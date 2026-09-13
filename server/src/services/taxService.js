/**
 * Phase 8A - server-authoritative tax calculation + the admin-configured
 * `tax_profile` settings (reuses the existing generic `settings`
 * key/value table unchanged - see server/src/routes/settings.js - no new
 * table needed for this part).
 *
 * Hard rule this module exists to enforce: the business is NOT
 * GST-registered yet (locked Phase 8A scope). `getTaxProfile()` defaults
 * to `gst_registered: false`, and `calculateOrderTax()` below forces
 * every tax rate to 0 whenever `gst_registered` is false, REGARDLESS of
 * whatever rate a variant happens to have configured - so a variant's
 * tax_rate_percent can safely be filled in ahead of time without
 * accidentally charging/reporting tax before the business is actually
 * registered.
 */
import { supabaseAdmin } from "../db/supabaseClient.js";

export const DEFAULT_TAX_PROFILE = {
  gst_registered: false,
  gstin: "",
  legal_business_name: "",
  registered_address: { line1: "", line2: "", city: "", state_code: "", pincode: "" },
  // Locked scope: default is inclusive (existing prices already behave
  // this way today - see calculateOrderTax()'s own comment on why
  // inclusive mode never changes `orders.total`).
  pricing_mode: "inclusive",
  invoice_number_prefix: "INV-",
  invoice_number_padding: 6,
};

export async function getTaxProfile() {
  const { data } = await supabaseAdmin().from("settings").select("value").eq("key", "tax_profile").maybeSingle();
  const stored = data?.value || {};
  return {
    ...DEFAULT_TAX_PROFILE,
    ...stored,
    registered_address: { ...DEFAULT_TAX_PROFILE.registered_address, ...(stored.registered_address || {}) },
  };
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Computes the full tax breakdown for one order at creation time.
 *
 * `lines`: [{ lineSubtotal (price_snapshot * qty, already computed by the
 *   caller), hsnCode, taxRatePercent }] - one entry per order line, in
 *   the SAME order the caller will insert order_items, so the returned
 *   `lines` array can be zipped back onto them 1:1.
 * `discountTotal`: the order's total discount (coupon + prepaid discount
 *   combined, exactly as already computed in checkout) - allocated
 *   proportionally across lines by each line's share of subtotal, purely
 *   for a defensible per-line taxable-value split; it does not change the
 *   order-level total this function returns.
 * `taxMode`: 'inclusive' | 'exclusive'.
 * `homeStateCode` / `placeOfSupplyStateCode`: GST state codes (see
 *   gstStateCodes.js) - equal means intra-state (CGST+SGST), different
 *   means inter-state (IGST). Either missing means "cannot determine";
 *   this function then reports zero CGST/SGST/IGST split confidence by
 *   defaulting to inter-state (IGST) treatment for the (currently
 *   necessarily zero, since gst_registered defaults false) tax amount -
 *   an engineering fallback, not a legal determination; a business tax
 *   advisor should confirm place-of-supply handling before this store
 *   goes GST-live.
 * `gstRegistered`: hard gate - forces every rate to 0 when false.
 *
 * IMPORTANT (why totals never double-add tax): in 'inclusive' mode, the
 * existing subtotal/shipping/discount/total arithmetic in
 * server/src/routes/public.js is left COMPLETELY UNCHANGED - this
 * function only back-calculates how much of that already-existing total
 * is taxable value vs embedded tax, for reporting/invoicing. In
 * 'exclusive' mode, the caller must ADD this function's returned
 * `taxAmount` to the order total (public.js does this explicitly, once,
 * in one place) - tax is never added more than that one time.
 */
export function calculateOrderTax({ lines, discountTotal = 0, taxMode, homeStateCode, placeOfSupplyStateCode, gstRegistered }) {
  const subtotal = lines.reduce((sum, l) => sum + l.lineSubtotal, 0);
  const isIntraState = !!homeStateCode && !!placeOfSupplyStateCode && homeStateCode === placeOfSupplyStateCode;

  let taxableValueTotal = 0;
  let cgstTotal = 0;
  let sgstTotal = 0;
  let igstTotal = 0;

  const lineResults = lines.map((line) => {
    const discountShare = subtotal > 0 ? discountTotal * (line.lineSubtotal / subtotal) : 0;
    const netAmount = Math.max(0, line.lineSubtotal - discountShare);
    const rate = gstRegistered ? Number(line.taxRatePercent || 0) : 0;

    let taxableValue;
    let taxAmount;
    if (rate > 0) {
      if (taxMode === "exclusive") {
        taxableValue = netAmount;
        taxAmount = netAmount * (rate / 100);
      } else {
        // inclusive: netAmount already contains the tax - back-calculate
        // the taxable (ex-tax) portion.
        taxableValue = netAmount / (1 + rate / 100);
        taxAmount = netAmount - taxableValue;
      }
    } else {
      taxableValue = netAmount;
      taxAmount = 0;
    }

    let cgst = 0;
    let sgst = 0;
    let igst = 0;
    if (taxAmount > 0) {
      if (isIntraState) {
        cgst = round2(taxAmount / 2);
        sgst = round2(taxAmount - cgst); // avoids a rounding-induced 1-paise mismatch vs taxAmount
      } else {
        igst = round2(taxAmount);
      }
    }

    taxableValueTotal += taxableValue;
    cgstTotal += cgst;
    sgstTotal += sgst;
    igstTotal += igst;

    return {
      hsnCode: line.hsnCode || null,
      taxRatePercent: rate,
      taxableValue: round2(taxableValue),
      cgstAmount: cgst,
      sgstAmount: sgst,
      igstAmount: igst,
    };
  });

  return {
    lines: lineResults,
    isIntraState,
    subtotal: round2(subtotal),
    taxableValue: round2(taxableValueTotal),
    cgstAmount: round2(cgstTotal),
    sgstAmount: round2(sgstTotal),
    igstAmount: round2(igstTotal),
    // exclusive mode: this is genuinely new money to add to the total.
    // inclusive mode: this is already inside the existing total/subtotal
    // and must NOT be added again.
    taxAmount: round2(cgstTotal + sgstTotal + igstTotal),
  };
}
