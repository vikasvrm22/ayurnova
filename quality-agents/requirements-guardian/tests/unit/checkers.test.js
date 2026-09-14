import path from "node:path";
import { fileURLToPath } from "node:url";
import * as checkers from "../../src/compliance/checkers/index.js";
import { assertEqual, assert } from "../helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// quality-agents/requirements-guardian/tests/unit -> repo root is 4 levels up.
const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");

/** Regression tests against the REAL repository (spec section 27: "test
 * against real AyurNova repository structures where safely possible").
 * These pin down two real false positives this build hit during its own
 * first self-audit and fixed:
 *   1. lastEnumFor() was not table-scoped, so payments/refunds/return_requests
 *      all wrongly matched shipments' CHECK constraint (same column name,
 *      different table).
 *   2. seedAdminPasswordSafety() flagged a safe instructional log message
 *      ("...log in with the password you set...") as echoing the real
 *      password, because it matched on the word "password" instead of on
 *      actual variable interpolation.
 * If either regresses, these tests catch it - read-only, never modifies
 * the repository. */
export default async function run() {
  const cod = checkers.codFeatureFlagServerEnforced(REPO_ROOT);
  assertEqual(cod.compliance, "IMPLEMENTED", `REQ-COD-001 checker should find the live server-side COD gate: ${cod.observed}`);
  assertEqual(cod.confidence, "HIGH", "COD gate evidence should be HIGH confidence (exact code match)");

  const secrets = checkers.secretsFailFast(REPO_ROOT);
  assertEqual(secrets.compliance, "IMPLEMENTED", `REQ-SECRETS-001 checker should find requireSecret() fail-fast: ${secrets.observed}`);

  const seedAdmin = checkers.seedAdminPasswordSafety(REPO_ROOT);
  assertEqual(seedAdmin.compliance, "IMPLEMENTED", `REQ-SECRETS-002 checker must not false-positive on the safe instructional log line: ${seedAdmin.observed}`);

  const notify = checkers.notifyNeverThrows(REPO_ROOT);
  assertEqual(notify.compliance, "IMPLEMENTED", `REQ-NOTIFY-001 checker should find notify()'s try/catch invariant intact: ${notify.observed}`);

  // Table-scoping regression: these three must NOT return shipments' enum.
  const payments = checkers.paymentStatusEnum(REPO_ROOT);
  assertEqual(payments.compliance, "IMPLEMENTED", `payments.status enum should match the approved set: ${payments.observed}`);
  assert(!payments.observed.includes("label_generated"), "payments.status must never be cross-matched against shipments' enum");

  const refunds = checkers.refundStatusEnum(REPO_ROOT);
  assertEqual(refunds.compliance, "IMPLEMENTED", `refunds.status enum should match the approved set: ${refunds.observed}`);
  assert(!refunds.observed.includes("label_generated"), "refunds.status must never be cross-matched against shipments' enum");

  const returns = checkers.returnRequestStatusEnum(REPO_ROOT);
  assertEqual(returns.compliance, "IMPLEMENTED", `return_requests.status enum should match the approved set: ${returns.observed}`);
  assert(!returns.observed.includes("label_generated"), "return_requests.status must never be cross-matched against shipments' enum");

  const shipments = checkers.shipmentStatusEnum(REPO_ROOT);
  assertEqual(shipments.compliance, "IMPLEMENTED", `shipments.status enum should match its own approved set: ${shipments.observed}`);

  const orders = checkers.ordersStatusEnum(REPO_ROOT);
  assertEqual(orders.compliance, "IMPLEMENTED", `orders.status enum should match the post-Phase-8B approved set: ${orders.observed}`);

  const legalSlug = checkers.legalSlugEnum(REPO_ROOT);
  assertEqual(legalSlug.compliance, "IMPLEMENTED", `legal_pages.slug enum should match the approved closed set: ${legalSlug.observed}`);

  const paymentRetry = checkers.paymentRetryCap(REPO_ROOT);
  assertEqual(paymentRetry.compliance, "IMPLEMENTED", `payment retry cap should be found enforced: ${paymentRetry.observed}`);

  const webhook = checkers.webhookSignatureVerification(REPO_ROOT);
  assertEqual(webhook.compliance, "IMPLEMENTED", `webhook signature verification should be found: ${webhook.observed}`);

  // A nonexistent file must degrade to NEEDS_REVIEW/LOW, never a fabricated
  // pass or a thrown exception.
  const missingFileResult = checkers.notifyNeverThrows("/definitely/not/a/real/repo/path");
  assertEqual(missingFileResult.confidence, "LOW", "a missing file must degrade to LOW confidence, not crash or fake a PASS");

  return { assertions: 16 };
}
