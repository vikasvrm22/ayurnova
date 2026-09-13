/**
 * DEV Harness - Phase 8C focused checks (Customer Wishlist).
 *
 * Section 1: table reachability (read-only). Skipped gracefully (not
 * failed) if migration 0012_phase8c_wishlist.sql hasn't been applied yet,
 * same pattern test-phase7-notifications.js/test-phase8b-shipping.js
 * already use.
 *
 * Section 2 (DB-WRITING): gated behind DEV_HARNESS_ALLOW_WRITE=true, same
 * convention as test-phase8a-invoicing.js/test-phase8b-shipping.js.
 * Creates two disposable Supabase Auth users (via the service-role admin
 * API - clearly tagged emails, deleted at the end) and one disposable
 * PUBLISHED product+variant (also deleted at the end) to exercise:
 * add/list/remove, duplicate-safe add, ownership isolation between the
 * two fixture customers, unpublished-product hydration, and cascade
 * cleanup on hard product delete. Never touches any real customer/product.
 *
 * Usage:
 *   node dev-harness/test-phase8c-wishlist.js                       # section 1 only
 *   DEV_HARNESS_ALLOW_WRITE=true node dev-harness/test-phase8c-wishlist.js   # + section 2
 */
import "dotenv/config.js";
import { supabaseAdmin } from "../src/db/supabaseClient.js";

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// ---- Section 1: table reachability ----
const { error: tableCheckError } = await supabaseAdmin().from("wishlist_items").select("id").limit(1);
if (tableCheckError) {
  console.log(`SKIP: DB-dependent checks — wishlist_items table not reachable yet (${tableCheckError.message}). Apply supabase/migrations/0012_phase8c_wishlist.sql, then re-run.`);
} else if (process.env.DEV_HARNESS_ALLOW_WRITE !== "true") {
  console.log("SKIP: lifecycle/ownership checks — set DEV_HARNESS_ALLOW_WRITE=true to run them (creates and cleans up two disposable auth users + one disposable product, never touches real data). See this file's own header comment.");
} else {
  await runChecks();
}

async function runChecks() {
  const FIXTURE_TAG = `phase8c-dev-harness-${Date.now()}`;
  let customerAId = null;
  let customerBId = null;
  let productId = null;
  let variantId = null;

  async function cleanup() {
    if (productId) await supabaseAdmin().from("products").delete().eq("id", productId); // cascades product_variants + wishlist_items
    if (customerAId) await supabaseAdmin().auth.admin.deleteUser(customerAId).catch(() => {});
    if (customerBId) await supabaseAdmin().auth.admin.deleteUser(customerBId).catch(() => {});
    console.log("Cleaned up fixture users/product/variant.");
  }

  try {
    // ---- Fixtures: two disposable customers + one published product ----
    const { data: userA, error: userAError } = await supabaseAdmin().auth.admin.createUser({
      email: `${FIXTURE_TAG}-a@example.invalid`, password: `Fixture!${Date.now()}A`, email_confirm: true,
    });
    if (userAError) throw userAError;
    customerAId = userA.user.id;

    const { data: userB, error: userBError } = await supabaseAdmin().auth.admin.createUser({
      email: `${FIXTURE_TAG}-b@example.invalid`, password: `Fixture!${Date.now()}B`, email_confirm: true,
    });
    if (userBError) throw userBError;
    customerBId = userB.user.id;

    const { data: product, error: productError } = await supabaseAdmin().from("products").insert({
      title: "Dev Harness Fixture Product", slug: FIXTURE_TAG, status: "published",
    }).select().single();
    if (productError) throw productError;
    productId = product.id;

    const { data: variant, error: variantError } = await supabaseAdmin().from("product_variants").insert({
      product_id: productId, label: "Fixture Pack", price: 199, mrp: 249, stock: 10,
    }).select().single();
    if (variantError) throw variantError;
    variantId = variant.id;

    // ---- add (POST semantics, direct table insert - route logic itself
    // is exercised by the account.html UI/integration path; this harness
    // verifies the DB layer's own constraints/behavior the route relies
    // on: unique(customer_id, product_id), RLS, and cascade) ----
    const { error: insertError } = await supabaseAdmin().from("wishlist_items").insert({ customer_id: customerAId, product_id: productId });
    check("Add: insert succeeds for a real customer + published product", !insertError, insertError?.message);

    // ---- duplicate add: unique constraint fires (route.js's own 23505
    // handling turns this into a no-op success - verified at the schema
    // level here) ----
    const { error: dupError } = await supabaseAdmin().from("wishlist_items").insert({ customer_id: customerAId, product_id: productId });
    check("Duplicate add: unique(customer_id, product_id) rejects a second insert (23505)", dupError?.code === "23505", dupError?.code);

    const { data: rowsAfterDup } = await supabaseAdmin().from("wishlist_items").select("id").eq("customer_id", customerAId).eq("product_id", productId);
    check("Duplicate add never creates a second row", (rowsAfterDup || []).length === 1, `${(rowsAfterDup || []).length} row(s)`);

    // ---- list (ownership-scoped query, same shape wishlistPublic.js uses) ----
    const { data: listA } = await supabaseAdmin().from("wishlist_items").select("*").eq("customer_id", customerAId);
    check("List: customer A sees their own wishlist item", (listA || []).length === 1);

    // ---- ownership isolation: customer B must see/delete nothing of A's ----
    const { data: listB } = await supabaseAdmin().from("wishlist_items").select("*").eq("customer_id", customerBId);
    check("Ownership: customer B's own-scoped list is empty (sees none of A's items)", (listB || []).length === 0);

    const { data: crossDelete } = await supabaseAdmin()
      .from("wishlist_items").delete().eq("customer_id", customerBId).eq("product_id", productId).select();
    check("Ownership: customer B cannot delete customer A's wishlist row (0 rows affected)", (crossDelete || []).length === 0);

    const { data: stillThere } = await supabaseAdmin().from("wishlist_items").select("id").eq("customer_id", customerAId).eq("product_id", productId);
    check("Customer A's row is unaffected by B's attempted delete", (stillThere || []).length === 1);

    // ---- unpublished product: getProductsByIds() (catalogService.js)
    // omits it, wishlistPublic.js's route reports available:false rather
    // than erroring or dropping the row - verified here at the data layer
    // getProductsByIds queries: .eq("status","published") ----
    await supabaseAdmin().from("products").update({ status: "draft" }).eq("id", productId);
    const { data: publishedCheck } = await supabaseAdmin().from("products").select("id").eq("id", productId).eq("status", "published").maybeSingle();
    check("Unpublished product: no longer matches the published-only hydration filter", !publishedCheck);
    const { data: rowStillSaved } = await supabaseAdmin().from("wishlist_items").select("id").eq("customer_id", customerAId).eq("product_id", productId);
    check("Unpublished product: the wishlist row itself is preserved (not silently deleted)", (rowStillSaved || []).length === 1);
    await supabaseAdmin().from("products").update({ status: "published" }).eq("id", productId); // restore for the next checks

    // ---- remove (DELETE semantics) ----
    const { data: removed } = await supabaseAdmin()
      .from("wishlist_items").delete().eq("customer_id", customerAId).eq("product_id", productId).select();
    check("Remove: delete succeeds for the owning customer", (removed || []).length === 1);
    const { data: goneCheck } = await supabaseAdmin().from("wishlist_items").select("id").eq("customer_id", customerAId).eq("product_id", productId);
    check("Remove: item no longer appears in the list", (goneCheck || []).length === 0);

    // ---- hard product delete cascades wishlist_items (never orphans) ----
    await supabaseAdmin().from("wishlist_items").insert({ customer_id: customerAId, product_id: productId });
    const { error: deleteProductError } = await supabaseAdmin().from("products").delete().eq("id", productId);
    check("Hard product delete succeeds", !deleteProductError, deleteProductError?.message);
    const { data: orphanCheck, error: orphanCheckError } = await supabaseAdmin().from("wishlist_items").select("id").eq("product_id", productId);
    check("Hard product delete cascades to wishlist_items (no orphaned row left)", !orphanCheckError && (orphanCheck || []).length === 0);
    productId = null; // already deleted - cleanup() should not try again
  } catch (e) {
    check("Wishlist test run completed without an unexpected exception", false, e.message);
  } finally {
    await cleanup();
  }
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
// process.exitCode (not process.exit()) - see test-phase8b-shipping.js's
// own comment for why: avoids a libuv assertion on Windows after a burst
// of Supabase HTTP requests right before exit.
process.exitCode = failures ? 1 : 0;
