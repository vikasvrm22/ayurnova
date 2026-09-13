/**
 * DEV Harness - Phase 7 focused checks (Customer Communications & Legal
 * Readiness). Same spirit as healthcheck.js: read-mostly, never
 * destructive to real data. The one write this makes is directly against
 * notification_log (idempotency probe rows keyed under a fixed test order
 * id that never matches a real order), never against orders/customers.
 *
 * What this checks:
 *  1. notify() never throws, even when notification_log/legal_pages don't
 *     exist yet (pre-migration) or every channel is unconfigured - the
 *     single hardest requirement for Phase 7 ("a notification failure
 *     must never block the real order/return/refund action").
 *  2. Once migration 0009 is applied, a duplicate notify() call for the
 *     same event+dedupe_key does not create a second notification_log row
 *     (idempotency).
 *  3. sanitizeRichText() strips disallowed tags/attributes and keeps
 *     allowed formatting - the legal CMS's stored-XSS defense.
 *
 * Usage: node dev-harness/test-phase7-notifications.js
 * Exit code 0 = all checks passed, 1 = at least one failed.
 */
import { notify } from "../src/notify/notificationService.js";
import { sanitizeRichText } from "../src/utils/richTextSanitizer.js";
import { supabaseAdmin } from "../src/db/supabaseClient.js";

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// order_id is deliberately null, not a fake UUID: notification_log.order_id
// has a real FK to orders(id), and this harness must never depend on (or
// risk notifying) a real order row. null is valid (nullable FK) and never
// touches the orders table at all.
const FAKE_ORDER = {
  id: null,
  order_number: "DEV-HARNESS-TEST",
  customer_id: null,
  guest_email: "dev-harness@example.com",
  guest_phone: "9999999999",
  shipping_address: { phone: "9999999999" },
  total: 499,
};

// ---- 1: never throws, regardless of migration/config state ----
try {
  await notify("order_placed", { order: FAKE_ORDER, total: FAKE_ORDER.total, dedupeKey: "dev-harness-probe-1" });
  check("notify() resolves without throwing", true);
} catch (e) {
  check("notify() resolves without throwing", false, e.message);
}

// ---- 2: idempotency - only meaningful once notification_log exists;
// skipped gracefully (not failed) if migration 0009 isn't applied yet, so
// this harness stays useful both before and after that manual step. ----
const { error: tableCheckError } = await supabaseAdmin().from("notification_log").select("id").limit(1);
if (tableCheckError) {
  console.log(`SKIP: idempotency check — notification_log not reachable yet (${tableCheckError.message}). Apply supabase/migrations/0009_phase7_notifications_and_legal_cms.sql, then re-run.`);
} else {
  const dedupeKey = `dev-harness-probe-${Date.now()}`;
  await notify("order_placed", { order: FAKE_ORDER, total: FAKE_ORDER.total, dedupeKey });
  await notify("order_placed", { order: FAKE_ORDER, total: FAKE_ORDER.total, dedupeKey }); // duplicate trigger
  const { data: rows, error } = await supabaseAdmin()
    .from("notification_log").select("id, channel").eq("event", "order_placed").eq("dedupe_key", dedupeKey);
  check(
    "duplicate notify() call does not create duplicate rows per channel",
    !error && new Set((rows || []).map((r) => r.channel)).size === (rows || []).length,
    error ? error.message : `${(rows || []).length} row(s) for 3 channels, no channel repeated`
  );
  // Cleanup the probe rows this test itself created - never touches
  // anything a real order/customer/staff action wrote.
  if (!error) await supabaseAdmin().from("notification_log").delete().eq("dedupe_key", dedupeKey);
}

// ---- 3: rich-text sanitizer ----
const dirty = `<p onclick="alert(1)">Hello <script>alert('xss')</script><strong>world</strong></p><div class="x">kept as text</div><a href="javascript:alert(1)">bad link</a><a href="https://example.com">good link</a>`;
const clean = sanitizeRichText(dirty);
check("sanitizeRichText strips <script>", !clean.includes("<script"), clean);
check("sanitizeRichText strips onclick attribute", !clean.includes("onclick"), clean);
check("sanitizeRichText strips disallowed <div> tag but keeps its text", !clean.includes("<div") && clean.includes("kept as text"), clean);
check("sanitizeRichText keeps allowed <strong> tag", clean.includes("<strong>world</strong>"), clean);
check("sanitizeRichText strips a javascript: href", !clean.includes("javascript:"), clean);
check("sanitizeRichText keeps a safe https href", clean.includes('href="https://example.com"'), clean);

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
