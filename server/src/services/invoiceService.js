/**
 * Phase 8A - invoice creation, numbering, snapshotting, PDF rendering,
 * and retrieval. This is the ONLY module that writes to the `invoices`
 * table, same "one module owns one table's writes" convention
 * paymentService.js already established for payments/payment_attempts/
 * refunds.
 *
 * Idempotency: generateInvoiceForOrder() is safe to call more than once
 * for the same order (e.g. a payment webhook and the Checkout.js verify
 * callback both racing to confirm the same payment success - see
 * paymentService.markAttemptOutcome) - `invoices.unique(order_id)` is the
 * actual guard, exactly the same pattern as Phase 2's
 * `webhook_events.unique(gateway, event_id)`: a duplicate insert fails
 * with a unique violation, treated as "already issued, return the
 * existing one" rather than an error.
 */
import PDFDocument from "pdfkit";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { getTaxProfile } from "./taxService.js";
import { getGstStateName } from "../utils/gstStateCodes.js";

async function allocateInvoiceNumber(prefix, padding) {
  const { data, error } = await supabaseAdmin().rpc("next_invoice_sequence_number");
  if (error) throw error;
  const sequenceNumber = Number(data);
  const invoiceNumber = `${prefix || "INV-"}${String(sequenceNumber).padStart(padding || 6, "0")}`;
  return { sequenceNumber, invoiceNumber };
}

/**
 * Generates (or, if one already exists, returns) the invoice for one
 * order. Callers: server/src/routes/public.js (COD, right after the
 * order itself is accepted) and server/src/services/paymentService.js
 * (prepaid, inside markAttemptOutcome's single "this call actually won
 * the race" branch) - both per the locked scope's "generate only after
 * order acceptance / verified payment" rule. Never throws in a way that
 * should block the caller's real action; callers wrap this in try/catch
 * exactly like every other non-critical side effect in this codebase
 * (restock-on-cancel, notification dispatch).
 */
export async function generateInvoiceForOrder(orderId, { actor = "system" } = {}) {
  const { data: existing } = await supabaseAdmin().from("invoices").select("*").eq("order_id", orderId).maybeSingle();
  if (existing) return existing;

  const { data: order, error: orderError } = await supabaseAdmin().from("orders").select("*").eq("id", orderId).single();
  if (orderError || !order) throw new Error(`Order ${orderId} not found for invoice generation`);

  const { data: items, error: itemsError } = await supabaseAdmin().from("order_items").select("*").eq("order_id", orderId);
  if (itemsError) throw itemsError;

  const taxProfile = await getTaxProfile();
  const shippingAddress = order.shipping_address || {};
  const billingAddress = order.billing_address || shippingAddress;

  // Never includes gateway ids, webhook payloads, or any payment-internal
  // detail - this snapshot only ever draws from orders/order_items/
  // tax_profile, none of which hold that data.
  const sellerSnapshot = {
    legalBusinessName: taxProfile.legal_business_name || null,
    gstin: taxProfile.gst_registered ? taxProfile.gstin || null : null,
    address: taxProfile.registered_address || null,
  };
  const buyerSnapshot = {
    name: billingAddress.full_name || shippingAddress.full_name || null,
    gstin: order.buyer_gstin || null,
    email: order.guest_email || null,
    phone: billingAddress.phone || shippingAddress.phone || null,
    billingAddress,
    shippingAddress,
  };
  const lineItems = (items || []).map((i) => ({
    title: i.title_snapshot,
    variantLabel: i.variant_label_snapshot || null,
    hsnCode: i.hsn_code_snapshot || null,
    qty: i.qty,
    unitPrice: i.price_snapshot,
    lineSubtotal: i.subtotal,
    taxableValue: i.taxable_value_snapshot ?? i.subtotal,
    taxRatePercent: i.tax_rate_snapshot || 0,
    cgstAmount: i.cgst_amount_snapshot || 0,
    sgstAmount: i.sgst_amount_snapshot || 0,
    igstAmount: i.igst_amount_snapshot || 0,
  }));

  const taxMode = order.tax_mode || taxProfile.pricing_mode;
  const { sequenceNumber, invoiceNumber } = await allocateInvoiceNumber(
    taxProfile.invoice_number_prefix,
    taxProfile.invoice_number_padding
  );

  const { data: invoice, error: insertError } = await supabaseAdmin()
    .from("invoices")
    .insert({
      order_id: order.id,
      invoice_number: invoiceNumber,
      sequence_number: sequenceNumber,
      tax_mode: taxMode,
      place_of_supply_state_code: order.place_of_supply_state_code || null,
      seller_snapshot: sellerSnapshot,
      buyer_snapshot: buyerSnapshot,
      line_items: lineItems,
      subtotal: order.subtotal,
      discount_amount: order.discount || 0,
      shipping_amount: order.shipping_fee || 0,
      taxable_value: order.taxable_value ?? order.subtotal,
      cgst_amount: order.cgst_amount || 0,
      sgst_amount: order.sgst_amount || 0,
      igst_amount: order.igst_amount || 0,
      tax_amount: order.tax_amount || 0,
      grand_total: order.total,
      generated_by: actor,
    })
    .select()
    .maybeSingle();

  if (insertError) {
    if (insertError.code === "23505") {
      // Lost the idempotency race - another concurrent call already
      // created this order's invoice. Return the winner, not an error.
      const { data: winner } = await supabaseAdmin().from("invoices").select("*").eq("order_id", orderId).maybeSingle();
      if (winner) return winner;
    }
    throw insertError;
  }
  return invoice;
}

export async function getInvoiceByOrderId(orderId) {
  const { data, error } = await supabaseAdmin().from("invoices").select("*").eq("order_id", orderId).maybeSingle();
  if (error) throw error;
  return data;
}

function formatAddressLines(addr) {
  if (!addr) return [];
  const cityLine = [addr.city, addr.state, addr.pincode].filter(Boolean).join(", ");
  return [addr.line1, addr.line2, cityLine].filter(Boolean);
}

const money = (n) => `Rs. ${Number(n || 0).toFixed(2)}`;

/**
 * Renders one invoice as a PDF buffer, purely from the invoice row's own
 * frozen snapshot fields (never re-reads orders/order_items/settings) -
 * so a PDF generated today and one generated a year from now for the
 * same invoice are byte-for-byte identical in content, regardless of any
 * later product/tax-config change. pdfkit is pure-JS (no native/Chromium
 * dependency), which is why it was chosen over a browser-based renderer
 * for this server.
 */
export function renderInvoicePdfBuffer(invoice) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const seller = invoice.seller_snapshot || {};
    const buyer = invoice.buyer_snapshot || {};
    const gstRegistered = !!seller.gstin;

    doc.fontSize(16).text("TAX INVOICE", { align: "center" });
    if (!gstRegistered) {
      doc.moveDown(0.3);
      doc.fontSize(9).fillColor("#666")
        .text("Not a GST tax invoice - seller is not GST-registered at the time of this order.", { align: "center" });
      doc.fillColor("#000");
    }
    doc.moveDown();

    doc.fontSize(11).text(seller.legalBusinessName || "AyurNova", { continued: false });
    doc.fontSize(9);
    formatAddressLines(seller.address).forEach((line) => doc.text(line));
    if (seller.gstin) doc.text(`GSTIN: ${seller.gstin}`);
    doc.moveDown();

    doc.fontSize(9);
    doc.text(`Invoice Number: ${invoice.invoice_number}`);
    doc.text(`Invoice Date: ${new Date(invoice.created_at).toLocaleDateString("en-IN")}`);
    if (invoice.place_of_supply_state_code) {
      doc.text(`Place of Supply: ${getGstStateName(invoice.place_of_supply_state_code) || invoice.place_of_supply_state_code}`);
    }
    doc.text(`Pricing: GST-${invoice.tax_mode === "exclusive" ? "Exclusive" : "Inclusive"}`);
    doc.moveDown();

    doc.fontSize(10).text("Bill To:", { underline: true });
    doc.fontSize(9).text(buyer.name || "-");
    formatAddressLines(buyer.billingAddress).forEach((line) => doc.text(line));
    if (buyer.gstin) doc.text(`GSTIN: ${buyer.gstin}`);
    if (buyer.phone) doc.text(`Phone: ${buyer.phone}`);
    doc.moveDown();

    if (buyer.shippingAddress && JSON.stringify(buyer.shippingAddress) !== JSON.stringify(buyer.billingAddress)) {
      doc.fontSize(10).text("Ship To:", { underline: true });
      doc.fontSize(9);
      formatAddressLines(buyer.shippingAddress).forEach((line) => doc.text(line));
      doc.moveDown();
    }

    // ---- Line items table (pdfkit has no built-in table primitive - a
    // simple fixed-column manual layout is the standard, minimal way to
    // do this without adding a second PDF/table library). ----
    const cols = [
      { label: "Item", x: 40, width: 140 },
      { label: "HSN", x: 180, width: 45 },
      { label: "Qty", x: 225, width: 30 },
      { label: "Taxable", x: 255, width: 60 },
      { label: "Rate%", x: 315, width: 35 },
      { label: "CGST", x: 350, width: 45 },
      { label: "SGST", x: 395, width: 45 },
      { label: "IGST", x: 440, width: 45 },
      { label: "Total", x: 485, width: 60 },
    ];
    let y = doc.y;
    doc.fontSize(8).font("Helvetica-Bold");
    cols.forEach((c) => doc.text(c.label, c.x, y, { width: c.width }));
    doc.font("Helvetica");
    y += 14;
    doc.moveTo(40, y - 2).lineTo(545, y - 2).strokeColor("#ccc").stroke();

    for (const line of invoice.line_items || []) {
      const lineTotal = Number(line.taxableValue) + Number(line.cgstAmount) + Number(line.sgstAmount) + Number(line.igstAmount);
      const values = [
        `${line.title}${line.variantLabel ? ` (${line.variantLabel})` : ""}`,
        line.hsnCode || "-",
        String(line.qty),
        Number(line.taxableValue).toFixed(2),
        Number(line.taxRatePercent).toFixed(1),
        Number(line.cgstAmount).toFixed(2),
        Number(line.sgstAmount).toFixed(2),
        Number(line.igstAmount).toFixed(2),
        lineTotal.toFixed(2),
      ];
      cols.forEach((c, idx) => doc.text(values[idx], c.x, y, { width: c.width }));
      y += 16;
      if (y > 740) {
        doc.addPage();
        y = 40;
      }
    }
    doc.y = y + 10;
    doc.moveTo(40, doc.y).lineTo(545, doc.y).strokeColor("#ccc").stroke();
    doc.moveDown();

    doc.fontSize(9);
    const summaryX = 380;
    const summaryRow = (label, value) => {
      doc.text(label, summaryX, doc.y, { width: 90, continued: false });
      doc.text(value, summaryX + 90, doc.y - doc.currentLineHeight(), { width: 75, align: "right" });
    };
    summaryRow("Taxable Value:", money(invoice.taxable_value));
    if (invoice.discount_amount) summaryRow("Discount:", `-${money(invoice.discount_amount)}`);
    if (invoice.shipping_amount) summaryRow("Shipping:", money(invoice.shipping_amount));
    if (invoice.cgst_amount) summaryRow("CGST:", money(invoice.cgst_amount));
    if (invoice.sgst_amount) summaryRow("SGST:", money(invoice.sgst_amount));
    if (invoice.igst_amount) summaryRow("IGST:", money(invoice.igst_amount));
    doc.font("Helvetica-Bold");
    summaryRow("Grand Total:", money(invoice.grand_total));
    doc.font("Helvetica");

    doc.moveDown(2);
    doc.fontSize(8).fillColor("#888").text(
      "This is a system-generated invoice. Order and payment identifiers are kept internal and are not shown here.",
      40, doc.y, { width: 505 }
    );

    doc.end();
  });
}
