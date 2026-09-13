/**
 * DEV Harness - Phase 9B (P2-3) focused check: payment retry attempt cap.
 * `startPaymentAttempt()` (server/src/services/paymentService.js) must
 * refuse to create an 11th Razorpay order-creation attempt for the same
 * order, instead of allowing unbounded retries.
 *
 * Seeds a disposable fixture order + payment + 10 existing
 * payment_attempts rows DIRECTLY in the DB (no real Razorpay calls needed
 * to reach the cap - the guard fires before any provider call), then
 * calls startPaymentAttempt() once more and asserts it is rejected.
 * Gated behind DEV_HARNESS_ALLOW_WRITE=true, same convention as the
 * other Phase 9B fixture-writing harnesses. Cleans up always.
 *
 * Usage:
 *   DEV_HARNESS_ALLOW_WRITE=true node dev-harness/test-phase9b-payment-retry-cap.js
 */
import "dotenv/config.js";
import { supabaseAdmin } from "../src/db/supabaseClient.js";
import { startPaymentAttempt } from "../src/services/paymentService.js";

if (process.env.DEV_HARNESS_ALLOW_WRITE !== "true") {
  console.log("DEV_HARNESS_ALLOW_WRITE is not set to 'true' - refusing to write fixture rows. See this file's own header comment.");
  process.exit(0);
}

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const FIXTURE_TAG = `phase9b-retrycap-${Date.now()}`;
const { data: order, error: orderError } = await supabaseAdmin().from("orders").insert({
  order_number: FIXTURE_TAG,
  customer_id: null,
  guest_email: "dev-harness@example.invalid",
  guest_phone: "9999999999",
  status: "pending",
  payment_method: "prepaid",
  payment_status: "unpaid",
  subtotal: 100, shipping_fee: 0, discount: 0, total: 100,
  shipping_address: { full_name: "Dev Harness", phone: "9999999999", line1: "Test", city: "Test", state: "Maharashtra", state_code: "27", pincode: "400001" },
  tax_mode: "inclusive", taxable_value: 100, cgst_amount: 0, sgst_amount: 0, igst_amount: 0, tax_amount: 0,
  place_of_supply_state_code: "27",
}).select().single();
if (orderError) throw orderError;

let paymentId = null;
try {
  const { data: payment, error: paymentError } = await supabaseAdmin().from("payments").insert({
    order_id: order.id, gateway: "razorpay", environment: "test", amount: order.total, currency: "INR", status: "INITIATED",
  }).select().single();
  if (paymentError) throw paymentError;
  paymentId = payment.id;

  const attemptRows = Array.from({ length: 10 }, (_, i) => ({
    payment_id: payment.id, attempt_number: i + 1, gateway_order_id: `${FIXTURE_TAG}-fake-${i + 1}`, status: "FAILED",
  }));
  const { error: attemptsError } = await supabaseAdmin().from("payment_attempts").insert(attemptRows);
  if (attemptsError) throw attemptsError;

  let rejected = false;
  let statusCode = null;
  let code = null;
  try {
    await startPaymentAttempt(order);
  } catch (e) {
    rejected = true;
    statusCode = e.statusCode || e.status;
    code = e.code;
  }
  check("the 11th attempt is rejected, not silently allowed", rejected);
  check("rejection uses the documented 429 TOO_MANY_PAYMENT_ATTEMPTS shape", statusCode === 429 && code === "TOO_MANY_PAYMENT_ATTEMPTS", `status=${statusCode} code=${code}`);

  const { count: attemptCountAfter } = await supabaseAdmin().from("payment_attempts").select("id", { count: "exact", head: true }).eq("payment_id", payment.id);
  check("no 11th payment_attempts row was created", attemptCountAfter === 10, attemptCountAfter);
} finally {
  if (paymentId) {
    await supabaseAdmin().from("payment_attempts").delete().eq("payment_id", paymentId);
    await supabaseAdmin().from("payments").delete().eq("id", paymentId);
  }
  await supabaseAdmin().from("orders").delete().eq("id", order.id);
  console.log(`Cleaned up fixture order ${order.id}.`);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
