/**
 * DEV Harness - Phase 9B (P2-1) focused check: the admin order-cancel race
 * guard. Two near-simultaneous `PUT /api/admin/orders/:id/status`
 * cancel requests against the SAME order must not both succeed (which
 * would have double-called restock_order() before this fix) - exactly
 * one must win with 200, the other must get 409.
 *
 * Fires a real HTTP request pair (no DB write bypass) against a
 * disposable fixture order using a locally-signed staff JWT (no real
 * staff_users row needed - requireStaffAuth only verifies the JWT
 * signature, same JWT_SECRET the running server already trusts).
 *
 * Gated behind DEV_HARNESS_ALLOW_WRITE=true, same convention as
 * test-phase8a-invoicing.js - `orders` is a real commerce table.
 * Cleans up its fixture order always (even on failure).
 *
 * Usage:
 *   DEV_HARNESS_ALLOW_WRITE=true node dev-harness/test-phase9b-admin-cancel-race.js
 */
import "dotenv/config.js";
import jwt from "jsonwebtoken";
import { supabaseAdmin } from "../src/db/supabaseClient.js";
import { config } from "../src/config.js";

if (process.env.DEV_HARNESS_ALLOW_WRITE !== "true") {
  console.log("DEV_HARNESS_ALLOW_WRITE is not set to 'true' - refusing to write a fixture order. See this file's own header comment.");
  process.exit(0);
}

const BASE_URL = process.env.BASE_URL || "http://localhost:5100";
let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const staffToken = jwt.sign({ sub: "00000000-0000-0000-0000-000000000000", email: "dev-harness@example.invalid", role: "SuperAdmin", name: "Dev Harness" }, config.jwtSecret, { expiresIn: "5m" });

const FIXTURE_TAG = `phase9b-race-${Date.now()}`;
const { data: order, error } = await supabaseAdmin().from("orders").insert({
  order_number: FIXTURE_TAG,
  customer_id: null,
  guest_email: "dev-harness@example.invalid",
  guest_phone: "9999999999",
  status: "processing",
  payment_method: "cod",
  payment_status: "unpaid",
  subtotal: 100, shipping_fee: 0, discount: 0, total: 100,
  shipping_address: { full_name: "Dev Harness", phone: "9999999999", line1: "Test", city: "Test", state: "Maharashtra", state_code: "27", pincode: "400001" },
  tax_mode: "inclusive", taxable_value: 100, cgst_amount: 0, sgst_amount: 0, igst_amount: 0, tax_amount: 0,
  place_of_supply_state_code: "27",
}).select().single();
if (error) throw error;

try {
  const putCancel = () => fetch(`${BASE_URL}/api/admin/orders/${order.id}/status`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${staffToken}` },
    body: JSON.stringify({ status: "cancelled" }),
  });

  // Fire both requests as close to simultaneously as possible.
  const [resA, resB] = await Promise.all([putCancel(), putCancel()]);
  const statuses = [resA.status, resB.status].sort();
  check("exactly one of two simultaneous cancel requests succeeds (200) and the other is rejected (409)", statuses[0] === 200 && statuses[1] === 409, JSON.stringify(statuses));

  const { data: finalOrder } = await supabaseAdmin().from("orders").select("status").eq("id", order.id).single();
  check("order ends up cancelled exactly once (not corrupted by the race)", finalOrder?.status === "cancelled", finalOrder?.status);

  const { count: cancelLogCount } = await supabaseAdmin().from("activity_log").select("id", { count: "exact", head: true }).eq("entity_type", "order").eq("entity_id", order.id).eq("action", "status -> cancelled");
  check("activity_log records the transition exactly once (no duplicate audit entries from a double-write)", cancelLogCount === 1, cancelLogCount);
} finally {
  await supabaseAdmin().from("activity_log").delete().eq("entity_type", "order").eq("entity_id", order.id);
  await supabaseAdmin().from("orders").delete().eq("id", order.id);
  console.log(`Cleaned up fixture order ${order.id}.`);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
