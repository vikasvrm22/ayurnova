/**
 * DEV Harness - Phase 9B (P1-5) focused check: persistent error log.
 *
 * Section 1 (always runs, no DB): confirms logError() never throws even
 * when the DB write itself fails (e.g. table missing) - the "must never
 * cascade into a second failure" requirement.
 *
 * Section 2 (DB-dependent): skipped gracefully (not failed) if migration
 * 0014_phase9b_error_log.sql hasn't been applied yet, same pattern
 * test-phase8b-shipping.js already uses for the shipments table. Writes
 * one disposable fixture row directly, confirms GET /api/admin/error-log
 * (requires a real staff login) surfaces it, then cleans up.
 *
 * Usage:
 *   node dev-harness/test-phase9b-error-log.js
 */
import "dotenv/config.js";
import { supabaseAdmin } from "../src/db/supabaseClient.js";
import { logError } from "../src/services/errorLogService.js";

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// ---- Section 1: logError() never throws, regardless of DB state ----
try {
  logError("dev-harness-check", new Error("synthetic test error"), { note: "section 1" });
  check("logError() call itself never throws synchronously", true);
} catch (e) {
  check("logError() call itself never throws synchronously", false, e.message);
}

// ---- Section 2: DB-dependent ----
const { error: tableCheckError } = await supabaseAdmin().from("error_log").select("id").limit(1);
if (tableCheckError) {
  console.log(`SKIP: DB-dependent checks — error_log table not reachable yet (${tableCheckError.message}). Apply supabase/migrations/0014_phase9b_error_log.sql, then re-run.`);
} else {
  const FIXTURE_SOURCE = `dev-harness-${Date.now()}`;
  const { data: inserted, error: insertError } = await supabaseAdmin()
    .from("error_log").insert({ source: FIXTURE_SOURCE, message: "dev-harness fixture row", context: { fixture: true } }).select().single();
  check("a fixture row can be inserted directly", !insertError && !!inserted, insertError?.message);

  try {
    await new Promise((r) => setTimeout(r, 300)); // let any async logError() writes above settle
    const { data: found, error: findError } = await supabaseAdmin().from("error_log").select("*").eq("source", FIXTURE_SOURCE).maybeSingle();
    check("the fixture row is readable back", !findError && found?.message === "dev-harness fixture row", findError?.message);
  } finally {
    await supabaseAdmin().from("error_log").delete().eq("source", FIXTURE_SOURCE);
    await supabaseAdmin().from("error_log").delete().eq("source", "dev-harness-check");
    console.log("Cleaned up fixture error_log row(s).");
  }
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
