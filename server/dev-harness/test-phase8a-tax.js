/**
 * DEV Harness - Phase 8A focused checks (Tax & Invoicing), pure
 * calculateOrderTax() unit tests - no DB, no network, safe to run
 * anytime. See test-phase8a-invoicing.js for the DB-touching invoice
 * generation/idempotency/RBAC checks.
 *
 * Usage: node dev-harness/test-phase8a-tax.js
 */
import { calculateOrderTax } from "../src/services/taxService.js";

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
function approx(a, b, eps = 0.01) {
  return Math.abs(Number(a) - Number(b)) < eps;
}

const oneLine = (lineSubtotal, taxRatePercent, hsnCode = "3004") => [{ lineSubtotal, hsnCode, taxRatePercent }];

// ---- 1: not GST-registered -> always zero tax, regardless of rate ----
{
  const r = calculateOrderTax({
    lines: oneLine(1000, 18), discountTotal: 0, taxMode: "inclusive",
    homeStateCode: "27", placeOfSupplyStateCode: "27", gstRegistered: false,
  });
  check("gst_registered=false forces zero tax even with a configured rate", r.taxAmount === 0 && r.lines[0].taxRatePercent === 0, JSON.stringify(r));
}

// ---- 2: inclusive mode, intra-state (CGST+SGST), back-calculates tax
// out of the existing amount without changing it ----
{
  const r = calculateOrderTax({
    lines: oneLine(1180, 18), discountTotal: 0, taxMode: "inclusive",
    homeStateCode: "27", placeOfSupplyStateCode: "27", gstRegistered: true,
  });
  check("inclusive: taxable value back-calculated correctly (1180 / 1.18 = 1000)", approx(r.taxableValue, 1000), r.taxableValue);
  check("inclusive: total tax = 180", approx(r.taxAmount, 180), r.taxAmount);
  check("inclusive intra-state: CGST+SGST split evenly (90/90)", approx(r.cgstAmount, 90) && approx(r.sgstAmount, 90), `cgst=${r.cgstAmount} sgst=${r.sgstAmount}`);
  check("inclusive intra-state: IGST is zero", r.igstAmount === 0, r.igstAmount);
}

// ---- 3: exclusive mode, inter-state (IGST) - tax is ADDED, not embedded ----
{
  const r = calculateOrderTax({
    lines: oneLine(1000, 18), discountTotal: 0, taxMode: "exclusive",
    homeStateCode: "27", placeOfSupplyStateCode: "29", gstRegistered: true,
  });
  check("exclusive: taxable value equals the line amount as-is (no back-calc)", approx(r.taxableValue, 1000), r.taxableValue);
  check("exclusive: tax is 18% ON TOP (180)", approx(r.taxAmount, 180), r.taxAmount);
  check("exclusive inter-state: IGST carries the full tax amount", approx(r.igstAmount, 180), r.igstAmount);
  check("exclusive inter-state: CGST/SGST are zero", r.cgstAmount === 0 && r.sgstAmount === 0, `cgst=${r.cgstAmount} sgst=${r.sgstAmount}`);
}

// ---- 4: discount is allocated proportionally across lines before tax ----
{
  const r = calculateOrderTax({
    lines: [
      { lineSubtotal: 800, hsnCode: "A", taxRatePercent: 18 },
      { lineSubtotal: 200, hsnCode: "B", taxRatePercent: 18 },
    ],
    discountTotal: 100, taxMode: "exclusive",
    homeStateCode: "27", placeOfSupplyStateCode: "27", gstRegistered: true,
  });
  // line 1: 800 - (100 * 800/1000) = 720 taxable, tax = 129.6
  // line 2: 200 - (100 * 200/1000) = 180 taxable, tax = 32.4
  check("discount allocated proportionally (line1 taxable ~720)", approx(r.lines[0].taxableValue, 720), r.lines[0].taxableValue);
  check("discount allocated proportionally (line2 taxable ~180)", approx(r.lines[1].taxableValue, 180), r.lines[1].taxableValue);
  check("total tax reflects post-discount base (162)", approx(r.taxAmount, 162), r.taxAmount);
}

// ---- 5: cannot determine place of supply -> treated as inter-state
// (a documented engineering default, never a silent intra-state assumption) ----
{
  const r = calculateOrderTax({
    lines: oneLine(1000, 18), discountTotal: 0, taxMode: "exclusive",
    homeStateCode: "27", placeOfSupplyStateCode: null, gstRegistered: true,
  });
  check("unknown place of supply defaults to inter-state (IGST), not intra-state", r.igstAmount > 0 && r.cgstAmount === 0 && r.sgstAmount === 0, JSON.stringify(r));
}

// ---- 6: zero rate variant -> zero tax, unaffected by mode ----
{
  const r = calculateOrderTax({
    lines: oneLine(500, 0), discountTotal: 0, taxMode: "exclusive",
    homeStateCode: "27", placeOfSupplyStateCode: "27", gstRegistered: true,
  });
  check("a variant with no/zero tax rate contributes zero tax", r.taxAmount === 0, r.taxAmount);
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
