/**
 * DEV Harness - Phase 9B (P1-3) focused check: server-side COD eligibility
 * gate. The admin "COD Available" toggle (`settings.trust_badges.cod`)
 * must actually block `POST /api/public/checkout` with
 * `payment_method:"cod"`, not just hide the storefront badge.
 *
 * Section 1 (always runs, needs a running server + a real published
 * variant, but never writes an order): toggles `trust_badges.cod` to
 * false, confirms a COD checkout attempt is rejected with 400 and no
 * order is created, then restores the original setting value.
 *
 * Section 2 (DB-WRITING lifecycle check, gated behind
 * DEV_HARNESS_ALLOW_WRITE=true, same convention as
 * test-phase8a-invoicing.js): confirms that with COD enabled, the exact
 * same request DOES create a real order - so Section 1 isn't merely
 * testing a request that would have failed anyway. Cleans up the order
 * it creates and restocks the variant.
 *
 * Usage:
 *   node dev-harness/test-phase9b-cod-gate.js
 *   DEV_HARNESS_ALLOW_WRITE=true node dev-harness/test-phase9b-cod-gate.js
 */
import "dotenv/config.js";
import { supabaseAdmin } from "../src/db/supabaseClient.js";

const BASE_URL = process.env.BASE_URL || "http://localhost:5100";

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const { data: variant } = await supabaseAdmin()
  .from("product_variants").select("id, stock, products!inner(status)").eq("products.status", "published").gt("stock", 0).limit(1).maybeSingle();

if (!variant) {
  console.log("No published, in-stock product variant available - skipping (seed test data first).");
  process.exit(0);
}

const { data: originalSetting } = await supabaseAdmin().from("settings").select("value").eq("key", "trust_badges").single();
const originalValue = originalSetting.value;

function fixtureBody() {
  return {
    items: [{ variant_id: variant.id, qty: 1 }],
    address: { full_name: "Dev Harness", phone: "9999999999", line1: "Test Line", city: "Test City", state: "Maharashtra", state_code: "27", pincode: "400001" },
    payment_method: "cod",
    guest_email: "dev-harness@example.invalid",
    guest_phone: "9999999999",
  };
}

let createdOrderId = null;
try {
  // ---- Section 1: COD disabled -> blocked, no order created ----
  await supabaseAdmin().from("settings").upsert({ key: "trust_badges", value: { ...originalValue, cod: false } });

  const blockedRes = await fetch(`${BASE_URL}/api/public/checkout`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fixtureBody()),
  });
  const blockedBody = await blockedRes.json();
  check("COD checkout is rejected with 400 when admin has disabled COD", blockedRes.status === 400, JSON.stringify(blockedBody));
  check("rejection response carries no order_number (no order was created)", !blockedBody.order_number);

  // ---- Section 2 (writes a real order): COD enabled -> succeeds ----
  if (process.env.DEV_HARNESS_ALLOW_WRITE === "true") {
    await supabaseAdmin().from("settings").upsert({ key: "trust_badges", value: { ...originalValue, cod: true } });

    const allowedRes = await fetch(`${BASE_URL}/api/public/checkout`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fixtureBody()),
    });
    const allowedBody = await allowedRes.json();
    check("COD checkout succeeds (201) with the identical request once COD is re-enabled", allowedRes.status === 201, JSON.stringify(allowedBody));
    if (allowedBody?.order_number) {
      const { data: createdOrder } = await supabaseAdmin().from("orders").select("id").eq("order_number", allowedBody.order_number).single();
      if (createdOrder) createdOrderId = createdOrder.id;
    }
  } else {
    console.log("DEV_HARNESS_ALLOW_WRITE is not set to 'true' - skipping Section 2 (real order creation).");
  }
} finally {
  await supabaseAdmin().from("settings").upsert({ key: "trust_badges", value: originalValue });
  if (createdOrderId) {
    // Reuses the same restock_order() RPC the real cancellation path uses
    // (Phase 5B) - gives back exactly what FEFO allocation actually took,
    // via order_item_batch_allocations, not a re-derived guess.
    await supabaseAdmin().rpc("restock_order", { p_order_id: createdOrderId, p_actor: "dev-harness", p_reason: "dev-harness fixture cleanup" });
    await supabaseAdmin().from("invoices").delete().eq("order_id", createdOrderId);
    await supabaseAdmin().from("order_item_batch_allocations").delete().in(
      "order_item_id", (await supabaseAdmin().from("order_items").select("id").eq("order_id", createdOrderId)).data?.map((r) => r.id) || []
    );
    await supabaseAdmin().from("order_items").delete().eq("order_id", createdOrderId);
    await supabaseAdmin().from("orders").delete().eq("id", createdOrderId);
    console.log(`Cleaned up fixture order ${createdOrderId} and restocked its variant.`);
  }
  console.log("Restored original trust_badges setting.");
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
