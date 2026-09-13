/**
 * DEV Harness - Phase 9F (P1-7) focused check: publishing/editing a
 * product must invalidate the Home/Shop SSR cache immediately, not
 * leave a stale rendered page for up to ssrCacheTtlMs (previously up
 * to 5 minutes).
 *
 * Uses a real admin PUT (through the actual HTTP route + RBAC
 * middleware, not a direct DB write) on a real existing product,
 * changing only its title to a disposable marker, then confirms the
 * change is reflected on the very next GET /shop - restores the
 * original title always, even on failure.
 *
 * Usage:
 *   node dev-harness/test-phase9f-cache-invalidation.js
 */
import "dotenv/config.js";
import jwt from "jsonwebtoken";
import { supabaseAdmin } from "../src/db/supabaseClient.js";
import { config } from "../src/config.js";

const BASE_URL = process.env.BASE_URL || "http://localhost:5100";
let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const { data: product, error } = await supabaseAdmin().from("products").select("*").eq("status", "published").limit(1).maybeSingle();
if (!product) {
  console.log("No published product available - skipping (seed test data first).");
  process.exit(0);
}
if (error) throw error;

const staffToken = jwt.sign({ sub: "00000000-0000-0000-0000-000000000000", email: "dev-harness@example.invalid", role: "SuperAdmin", name: "Dev Harness" }, config.jwtSecret, { expiresIn: "5m" });
const originalTitle = product.title;
const markerTitle = `${originalTitle} [dev-harness-cache-check-${Date.now()}]`;

async function putProduct(title) {
  const body = { ...product, title };
  delete body.id; delete body.created_at; delete body.updated_at; delete body.slug; delete body.avg_rating; delete body.review_count;
  return fetch(`${BASE_URL}/api/admin/products/${product.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${staffToken}` },
    body: JSON.stringify(body),
  });
}

try {
  // Prime the shop cache with the ORIGINAL title.
  const beforeRes = await fetch(`${BASE_URL}/shop`);
  const beforeHtml = await beforeRes.text();
  check("shop page (cache-priming request) renders 200", beforeRes.status === 200, beforeRes.status);

  const updateRes = await putProduct(markerTitle);
  const updateBody = await updateRes.json();
  check("admin product update succeeds (200)", updateRes.status === 200, JSON.stringify(updateBody).slice(0, 200));

  const afterRes = await fetch(`${BASE_URL}/shop`);
  const afterHtml = await afterRes.text();
  check(
    "the VERY NEXT /shop request reflects the new title (cache was invalidated, not stale for up to ssrCacheTtlMs)",
    afterHtml.includes(markerTitle),
    afterHtml.includes(markerTitle) ? "marker found" : "marker NOT found - still serving stale cached HTML"
  );
} finally {
  const restoreRes = await putProduct(originalTitle);
  check("original title restored", restoreRes.status === 200, restoreRes.status);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
