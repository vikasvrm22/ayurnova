/**
 * DEV Harness - Phase 8A invoice generation checks: idempotency,
 * concurrency-safe numbering, tax-snapshot immutability, and PDF
 * rendering. Writes fixture `orders`/`order_items`/`invoices` rows
 * (clearly marked, referencing no real product/customer/payment) -
 * gated behind DEV_HARNESS_ALLOW_WRITE=true like seed-test-data.js,
 * since `orders` is a real commerce table, not a throwaway one. Cleans
 * up everything it creates, always (even on failure).
 *
 * Usage:
 *   DEV_HARNESS_ALLOW_WRITE=true node dev-harness/test-phase8a-invoicing.js
 */
import "dotenv/config.js";
import { supabaseAdmin } from "../src/db/supabaseClient.js";
import { generateInvoiceForOrder, renderInvoicePdfBuffer, getInvoiceByOrderId } from "../src/services/invoiceService.js";

if (process.env.DEV_HARNESS_ALLOW_WRITE !== "true") {
  console.log("DEV_HARNESS_ALLOW_WRITE is not set to 'true' - refusing to write fixture orders. See this file's own header comment.");
  process.exit(0);
}

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const FIXTURE_TAG = `phase8a-dev-harness-${Date.now()}`;
const createdOrderIds = [];

async function createFixtureOrder(n) {
  const { data: order, error } = await supabaseAdmin().from("orders").insert({
    order_number: `${FIXTURE_TAG}-${n}`,
    customer_id: null,
    guest_email: "dev-harness@example.invalid",
    guest_phone: "9999999999",
    status: "pending",
    payment_method: "cod",
    payment_status: "unpaid",
    subtotal: 1180, shipping_fee: 0, discount: 0, total: 1180,
    shipping_address: { full_name: "Dev Harness", phone: "9999999999", line1: "Test", city: "Test", state: "Maharashtra", state_code: "27", pincode: "400001" },
    tax_mode: "inclusive", taxable_value: 1000, cgst_amount: 90, sgst_amount: 90, igst_amount: 0, tax_amount: 180,
    place_of_supply_state_code: "27",
  }).select().single();
  if (error) throw error;
  createdOrderIds.push(order.id);

  const { error: itemError } = await supabaseAdmin().from("order_items").insert({
    order_id: order.id, product_id: null, variant_id: null,
    title_snapshot: "Dev Harness Fixture Item", variant_label_snapshot: null,
    price_snapshot: 1180, qty: 1, subtotal: 1180,
    hsn_code_snapshot: "3004", tax_rate_snapshot: 18, taxable_value_snapshot: 1000,
    cgst_amount_snapshot: 90, sgst_amount_snapshot: 90, igst_amount_snapshot: 0,
  });
  if (itemError) throw itemError;
  return order;
}

async function cleanup() {
  if (!createdOrderIds.length) return;
  await supabaseAdmin().from("invoices").delete().in("order_id", createdOrderIds);
  await supabaseAdmin().from("order_items").delete().in("order_id", createdOrderIds);
  await supabaseAdmin().from("orders").delete().in("id", createdOrderIds);
  console.log(`Cleaned up ${createdOrderIds.length} fixture order(s).`);
}

try {
  // ---- Idempotency ----
  const order1 = await createFixtureOrder(1);
  const invoiceA = await generateInvoiceForOrder(order1.id, { actor: "dev-harness" });
  const invoiceB = await generateInvoiceForOrder(order1.id, { actor: "dev-harness" });
  check("generateInvoiceForOrder is idempotent (same invoice id on repeat call)", invoiceA.id === invoiceB.id, `${invoiceA.id} vs ${invoiceB.id}`);
  const { count: dupCount } = await supabaseAdmin().from("invoices").select("id", { count: "exact", head: true }).eq("order_id", order1.id);
  check("exactly one invoice row exists for the order despite two generate calls", dupCount === 1, dupCount);

  // ---- Tax snapshot correctness ----
  check("invoice taxable_value matches the order's own snapshot (1000)", Number(invoiceA.taxable_value) === 1000, invoiceA.taxable_value);
  check("invoice cgst/sgst match order snapshot (90/90), igst is 0", Number(invoiceA.cgst_amount) === 90 && Number(invoiceA.sgst_amount) === 90 && Number(invoiceA.igst_amount) === 0);
  check("invoice line_items carries the HSN snapshot", invoiceA.line_items?.[0]?.hsnCode === "3004", JSON.stringify(invoiceA.line_items));

  // ---- Tax-snapshot immutability across a settings change ----
  const { data: existingProfile } = await supabaseAdmin().from("settings").select("value").eq("key", "tax_profile").maybeSingle();
  await supabaseAdmin().from("settings").upsert({ key: "tax_profile", value: { ...(existingProfile?.value || {}), gst_registered: true, pricing_mode: "exclusive" } });
  try {
    const invoiceAfterConfigChange = await getInvoiceByOrderId(order1.id);
    check(
      "invoice is unaffected by a LATER tax_profile change (still tax_mode='inclusive', same amounts)",
      invoiceAfterConfigChange.tax_mode === "inclusive" && Number(invoiceAfterConfigChange.cgst_amount) === 90,
      JSON.stringify({ tax_mode: invoiceAfterConfigChange.tax_mode, cgst: invoiceAfterConfigChange.cgst_amount })
    );
  } finally {
    // Restore whatever was there before this test touched it.
    if (existingProfile) await supabaseAdmin().from("settings").upsert({ key: "tax_profile", value: existingProfile.value });
    else await supabaseAdmin().from("settings").delete().eq("key", "tax_profile");
  }

  // ---- Concurrency-safe numbering: N fixture orders, all invoices
  // generated concurrently, must all get distinct sequence numbers ----
  const concurrentOrders = await Promise.all([2, 3, 4, 5, 6].map((n) => createFixtureOrder(n)));
  const concurrentInvoices = await Promise.all(concurrentOrders.map((o) => generateInvoiceForOrder(o.id, { actor: "dev-harness" })));
  const seqNumbers = concurrentInvoices.map((inv) => inv.sequence_number);
  const uniqueSeqNumbers = new Set(seqNumbers);
  check("concurrent invoice generation never collides on sequence number", uniqueSeqNumbers.size === seqNumbers.length, seqNumbers.join(","));
  const invoiceNumbers = concurrentInvoices.map((inv) => inv.invoice_number);
  check("concurrent invoice generation produces unique invoice numbers", new Set(invoiceNumbers).size === invoiceNumbers.length, invoiceNumbers.join(","));

  // ---- PDF rendering ----
  const pdfBuffer = await renderInvoicePdfBuffer(invoiceA);
  check("PDF buffer starts with the %PDF magic header", pdfBuffer.subarray(0, 4).toString("ascii") === "%PDF", pdfBuffer.subarray(0, 8).toString("ascii"));
  check("PDF buffer is a non-trivial size (>500 bytes)", pdfBuffer.length > 500, pdfBuffer.length);

  console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
} finally {
  await cleanup();
}
process.exit(failures ? 1 : 0);
