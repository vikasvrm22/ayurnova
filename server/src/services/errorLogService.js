/**
 * Phase 9B (P1-5): minimal persistent error log. Before this, an
 * unhandled exception (the global error handler's 500 path) or a
 * background failure outside a channel that already writes its own
 * durable record (notification_log, webhook_events) was only
 * `console.error`'d - invisible to an admin after the fact unless they
 * had access to raw server logs.
 *
 * logError() is the single write path, used by errorHandler.js (every
 * unhandled 500) and the two other "invisible" spots the Phase 9 audit
 * named: analytics/tracker.js's flush failures and
 * notify/notificationService.js's outer catch (a failure BEFORE a
 * per-channel attempt is ever recorded to notification_log, e.g. inside
 * resolveRecipient). Deliberately fire-and-forget and never throws -
 * logging a failure must never itself cause a second failure or block
 * the response/action that triggered it. If the `error_log` table
 * doesn't exist yet (migration not applied), this silently no-ops
 * rather than spamming console.error on every single request.
 */
import { supabaseAdmin } from "../db/supabaseClient.js";

let tableMissingWarned = false;

export function logError(source, err, context = {}) {
  const message = (err?.message || String(err) || "Unknown error").slice(0, 2000);
  const stack = (err?.stack || "").slice(0, 8000);
  supabaseAdmin()
    .from("error_log")
    .insert({ source, message, stack, context })
    .then(({ error }) => {
      if (error && !tableMissingWarned) {
        tableMissingWarned = true;
        console.error(
          "error_log table not reachable - persistent error logging is inactive. Apply supabase/migrations/0014_phase9b_error_log.sql, then restart. (further occurrences of this warning are suppressed)",
          error.message
        );
      }
    })
    .catch(() => {
      // Never let a logging failure cascade - the original error is
      // already console.error'd by the caller before/after this call.
    });
}
