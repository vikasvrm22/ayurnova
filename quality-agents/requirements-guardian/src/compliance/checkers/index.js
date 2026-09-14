import fs from "fs";
import path from "path";
import { readFileSafe, findLinesInFile, findLinesInDir, listMigrations } from "../../discovery/codeDiscovery.js";

// Each checker is a pure function (repoRoot) -> verdict:
//   { compliance, confidence, expected, observed, evidence: [{file,line,detail}], recommendation? }
// `compliance` is one of the COMPLIANCE_STATUSES in ../../registry/schema.js.
// Checkers never write anything - read-only evidence gathering only (the
// "only place compliance checkers touch the filesystem is via
// codeDiscovery.js" boundary is enforced by these being the only importers
// of that module's read functions).

function ev(file, line, detail) {
  return { file, line, detail };
}

/** Extracts the `create table <table> ( ... );` block from SQL source text
 * (this repo's consistent convention: every table definition closes with a
 * `);` alone on its own line - verified against supabase/schema.sql). Scoping
 * to this block is what prevents an unqualified column-name search (e.g.
 * "status") from matching a different table's constraint. Returns null if
 * this file has no CREATE TABLE for `table`. */
function createTableBlock(content, table) {
  const startMatch = new RegExp(`create table\\s+${table}\\s*\\(`, "i").exec(content);
  if (!startMatch) return null;
  const bodyStart = startMatch.index + startMatch[0].length;
  const closeMatch = /\n\);/.exec(content.slice(bodyStart));
  if (!closeMatch) return null;
  const body = content.slice(bodyStart, bodyStart + closeMatch.index);
  return { body, offset: bodyStart };
}

/** Scans every migration (in applied order) plus schema.sql for the LAST
 * `alter table <table> ... add constraint <name> check (<col> in (...))` or,
 * failing that, the inline `check (<col> in (...))` INSIDE that table's own
 * `create table` block, returning the final live enum. Table-scoped by
 * construction, so two different tables that happen to share a column name
 * (e.g. every lifecycle table has a `status` column) never cross-match. */
function lastEnumFor(repoRoot, { table, column, constraintName = null }) {
  const files = ["supabase/schema.sql", ...listMigrations(repoRoot)];
  let last = null;
  const alterPattern = constraintName
    ? new RegExp(`alter table\\s+${table}[\\s\\S]{0,40}?add constraint\\s+${constraintName}[\\s\\S]{0,160}?check\\s*\\(\\s*${column}\\s+in\\s*\\(([^)]+)\\)`, "i")
    : null;

  for (const rel of files) {
    const content = readFileSafe(repoRoot, rel);
    if (!content) continue;

    const alterMatch = alterPattern ? content.match(alterPattern) : null;
    if (alterMatch) {
      const values = alterMatch[1].split(",").map((v) => v.trim().replace(/^'|'$/g, ""));
      const lineNum = content.slice(0, alterMatch.index).split(/\r?\n/).length;
      last = { file: rel, line: lineNum, values };
      continue;
    }

    const block = createTableBlock(content, table);
    if (!block) continue;
    const inlinePattern = new RegExp(`\\b${column}\\b[^,\\n]*?check\\s*\\(\\s*${column}\\s+in\\s*\\(([^)]+)\\)`, "i");
    const inlineMatch = block.body.match(inlinePattern);
    if (inlineMatch) {
      const values = inlineMatch[1].split(",").map((v) => v.trim().replace(/^'|'$/g, ""));
      const lineNum = content.slice(0, block.offset + inlineMatch.index).split(/\r?\n/).length;
      last = { file: rel, line: lineNum, values };
    }
  }
  return last;
}

function enumChecker({ table, column, constraintName, expectedValues, requirementId }) {
  return (repoRoot) => {
    const found = lastEnumFor(repoRoot, { table, column, constraintName });
    if (!found) {
      return {
        compliance: "NEEDS_REVIEW",
        confidence: "LOW",
        expected: expectedValues.join(", "),
        observed: "No matching CHECK constraint found in schema.sql or migrations.",
        evidence: [ev("supabase/schema.sql", null, `searched for ${table}.${column} CHECK constraint - not found by regex`)],
        recommendation: "Confirm the column/constraint name has not been renamed; update this checker's search pattern if so.",
      };
    }
    const same = found.values.length === expectedValues.length && found.values.every((v) => expectedValues.includes(v));
    return {
      compliance: same ? "IMPLEMENTED" : "ACCIDENTALLY_CHANGED",
      confidence: "HIGH",
      expected: expectedValues.join(", "),
      observed: found.values.join(", "),
      evidence: [ev(found.file, found.line, `live CHECK constraint on ${table}.${column}`)],
      recommendation: same ? null : `${table}.${column}'s live enum no longer matches the approved requirement - confirm whether this was an approved decision or an accidental drift.`,
    };
  };
}

// ---------------------------------------------------------------- COD --
export function codFeatureFlagServerEnforced(repoRoot) {
  const hits = findLinesInFile(repoRoot, "server/src/routes/public.js", /codEnabled/);
  if (hits === null) {
    return { compliance: "NEEDS_REVIEW", confidence: "LOW", expected: "server-side COD gate", observed: "server/src/routes/public.js not found", evidence: [] };
  }
  const gateHit = hits.find((h) => /codEnabled\s*=/.test(h.text));
  const rejectHit = hits.find((h) => /if\s*\(\s*!codEnabled\s*\)/.test(h.text));
  if (gateHit && rejectHit) {
    return {
      compliance: "IMPLEMENTED",
      confidence: "HIGH",
      expected: "payment_method:'cod' rejected server-side when settings.trust_badges.cod === false",
      observed: `codEnabled read at line ${gateHit.line}, rejected at line ${rejectHit.line}`,
      evidence: [ev("server/src/routes/public.js", gateHit.line, gateHit.text), ev("server/src/routes/public.js", rejectHit.line, rejectHit.text)],
    };
  }
  return {
    compliance: "NOT_IMPLEMENTED",
    confidence: "MEDIUM",
    expected: "payment_method:'cod' rejected server-side when settings.trust_badges.cod === false",
    observed: "No codEnabled gate-and-reject pair found in server/src/routes/public.js",
    evidence: [],
    recommendation: "A direct API checkout call with payment_method:'cod' may bypass the admin COD toggle - verify manually.",
  };
}

export function codRefundFlagServerEnforced(repoRoot) {
  const hits = findLinesInFile(repoRoot, "server/src/routes/returnsAdmin.js", /cod_refund_enabled/);
  if (hits === null || hits.length === 0) {
    return {
      compliance: "NOT_IMPLEMENTED",
      confidence: "MEDIUM",
      expected: "COD refund approval checks settings.returns.cod_refund_enabled server-side",
      observed: "No cod_refund_enabled reference found in server/src/routes/returnsAdmin.js",
      evidence: [],
    };
  }
  const guard = hits.find((h) => /if\s*\(\s*!.*cod_refund_enabled/.test(h.text));
  return {
    compliance: guard ? "IMPLEMENTED" : "PARTIALLY_IMPLEMENTED",
    confidence: guard ? "HIGH" : "MEDIUM",
    expected: "COD refund approval rejected when settings.returns.cod_refund_enabled is false",
    observed: guard ? `Guard found at line ${guard.line}` : `cod_refund_enabled referenced but no clear reject guard found (line ${hits[0].line})`,
    evidence: hits.map((h) => ev("server/src/routes/returnsAdmin.js", h.line, h.text)),
  };
}

// ------------------------------------------------------------ Secrets --
export function secretsFailFast(repoRoot) {
  const content = readFileSafe(repoRoot, "server/src/config.js");
  if (content === null) {
    return { compliance: "NEEDS_REVIEW", confidence: "LOW", expected: "requireSecret() fail-fast", observed: "server/src/config.js not found", evidence: [] };
  }
  // Distinguish a SAFE usage (the literal appears only inside a
  // known-weak-value REJECTION list) from an UNSAFE one (the literal used
  // as a `||` fallback default) - both contain the same string, only the
  // context differs.
  const dangerousFallback = /(JWT_SECRET|INTEGRATION_ENCRYPTION_KEY)[^\n]{0,80}\|\|\s*["']dev-/i.test(content);
  const hasRequireSecretJwt = /requireSecret\s*\(\s*["']JWT_SECRET["']/.test(content);
  const hasRequireSecretKey = /requireSecret\s*\(\s*["']INTEGRATION_ENCRYPTION_KEY["']/.test(content);
  const requireSecretDefLine = findLinesInFile(repoRoot, "server/src/config.js", /function requireSecret/)?.[0]?.line || null;

  if (dangerousFallback) {
    return {
      compliance: "ACCIDENTALLY_CHANGED",
      confidence: "HIGH",
      expected: "no hardcoded fallback for JWT_SECRET/INTEGRATION_ENCRYPTION_KEY",
      observed: "A `||` fallback to a dev- literal was found for one of these variables",
      evidence: [ev("server/src/config.js", null, "regex matched a dangerous fallback pattern")],
    };
  }
  if (hasRequireSecretJwt && hasRequireSecretKey) {
    return {
      compliance: "IMPLEMENTED",
      confidence: "HIGH",
      expected: "both secrets loaded via requireSecret() with no insecure fallback",
      observed: `requireSecret() used for both JWT_SECRET and INTEGRATION_ENCRYPTION_KEY (defined at line ${requireSecretDefLine})`,
      evidence: [ev("server/src/config.js", requireSecretDefLine, "function requireSecret(envVar, { minLength }) {...}")],
    };
  }
  return {
    compliance: "NOT_IMPLEMENTED",
    confidence: "MEDIUM",
    expected: "both secrets loaded via requireSecret() with no insecure fallback",
    observed: "requireSecret() call not found for one or both of JWT_SECRET/INTEGRATION_ENCRYPTION_KEY",
    evidence: [],
    recommendation: "Confirm server/src/config.js was not refactored in a way this regex-based check misses.",
  };
}

export function seedAdminPasswordSafety(repoRoot) {
  const content = readFileSafe(repoRoot, "server/src/scripts/seedAdmin.js");
  if (content === null) {
    return { compliance: "NEEDS_REVIEW", confidence: "LOW", expected: "seedAdmin.js refuses weak/missing password", observed: "file not found", evidence: [] };
  }
  const refusesMissing = /if\s*\(\s*!password\s*\)/.test(content);
  const refusesWeak = /KNOWN_WEAK_PASSWORDS/.test(content) && /\.length\s*<\s*8/.test(content);
  // Only flags actual interpolation of the `password` variable's VALUE into
  // a log call (`${password}`) - a log message that merely mentions the
  // word "password" in an instructional string (e.g. "log in with the
  // password you set...") is safe and must not be flagged.
  const echoesPassword = /console\.(log|error|warn)\([^)]*\$\{\s*password\s*\}/.test(content);
  if (refusesMissing && refusesWeak && !echoesPassword) {
    return {
      compliance: "IMPLEMENTED",
      confidence: "HIGH",
      expected: "refuses missing/weak/placeholder password, never echoes it",
      observed: "Missing-password guard, weak-password guard present; no console.log of the raw password found",
      evidence: [ev("server/src/scripts/seedAdmin.js", 19, "KNOWN_WEAK_PASSWORDS guard"), ev("server/src/scripts/seedAdmin.js", 25, "missing-password guard")],
    };
  }
  return {
    compliance: echoesPassword ? "ACCIDENTALLY_CHANGED" : "PARTIALLY_IMPLEMENTED",
    confidence: "MEDIUM",
    expected: "refuses missing/weak/placeholder password, never echoes it",
    observed: `refusesMissing=${refusesMissing}, refusesWeak=${refusesWeak}, echoesPassword=${echoesPassword}`,
    evidence: [],
  };
}

// ---------------------------------------------------------------- Legal --
export function legalPublishGate(repoRoot) {
  const hits = findLinesInFile(repoRoot, "server/src/routes/pages.js", /["']published["']/);
  if (hits === null || hits.length === 0) {
    return { compliance: "NEEDS_REVIEW", confidence: "LOW", expected: "public routes filter on status='published'", observed: "no 'published' literal found in pages.js", evidence: [] };
  }
  return {
    compliance: "IMPLEMENTED",
    confidence: "MEDIUM",
    expected: "public legal-page route filters on status='published'",
    observed: `${hits.length} status==='published' checks found in server/src/routes/pages.js`,
    evidence: hits.slice(0, 3).map((h) => ev("server/src/routes/pages.js", h.line, h.text)),
    recommendation: "Confirm the specific legal-page route (not just other published-content routes in the same file) applies this filter - see docs/AYURNOVA-PHASE-9A-P0-CLOSURE.md line 49 for the line this was originally verified at.",
  };
}

export const legalSlugEnum = enumChecker({
  table: "legal_pages",
  column: "slug",
  expectedValues: ["terms-and-conditions", "privacy-policy", "return-refund-policy", "shipping-policy"],
});

export function legalContentAuthored(repoRoot) {
  const content = readFileSafe(repoRoot, "supabase/migrations/0009_phase7_notifications_and_legal_cms.sql");
  if (content === null) {
    return { compliance: "NEEDS_REVIEW", confidence: "LOW", expected: "n/a", observed: "seed migration not found", evidence: [] };
  }
  const stillHasPlaceholder = /DRAFT.{0,40}BUSINESS CONTENT REQUIRED/i.test(content);
  return {
    compliance: "NEEDS_REVIEW",
    confidence: "MEDIUM",
    expected: "real, business-approved legal copy published for all 4 legal pages",
    observed: stillHasPlaceholder
      ? "The seed migration still defines the auto-generated placeholder text; static analysis cannot confirm whether an admin has since published real content over it (that is live database state, not something this file-based check can see)."
      : "Seed migration's placeholder text pattern was not found as originally written - content may have changed; still requires a live check.",
    evidence: [ev("supabase/migrations/0009_phase7_notifications_and_legal_cms.sql", null, "seed placeholder text")],
    recommendation: "Run a live check against the current legal_pages table (Admin -> Legal Pages) to confirm actual publish status - this is an ANALYSIS LIMITATION, not a static-analysis-confirmed PASS or FAIL.",
  };
}

// ------------------------------------------------------------- Shipping --
export function shippingManualOnlyExpected(repoRoot) {
  const content = readFileSafe(repoRoot, "server/src/integrations/shipping/registry.js");
  if (content === null) {
    return { compliance: "NEEDS_REVIEW", confidence: "LOW", expected: "n/a", observed: "registry.js not found", evidence: [] };
  }
  const providerKeys = [...content.matchAll(/^\s*(\w+):\s*\w+Provider,?$/gm)].map((m) => m[1]);
  const onlyManual = providerKeys.length === 1 && providerKeys[0] === "manual";
  return {
    compliance: "NOT_APPLICABLE",
    confidence: "HIGH",
    expected: "manual-only is the current approved state; more providers would be a FUTURE feature landing early (not a violation)",
    observed: `Registered shipping providers: ${providerKeys.join(", ") || "(none matched)"}`,
    evidence: [ev("server/src/integrations/shipping/registry.js", 12, "SHIPPING_PROVIDERS map")],
    recommendation: onlyManual ? null : "A non-manual provider is now registered - confirm this was an approved decision to begin live courier integration, not an unapproved change.",
  };
}

export const shipmentStatusEnum = enumChecker({
  table: "shipments",
  column: "status",
  expectedValues: [
    "pending", "label_generated", "pickup_scheduled", "picked_up", "in_transit",
    "out_for_delivery", "delivered", "failed_delivery", "rto_initiated",
    "rto_in_transit", "rto_delivered", "cancelled",
  ],
});

// --------------------------------------------------------------- Orders --
export const ordersStatusEnum = enumChecker({
  table: "orders",
  column: "status",
  constraintName: "orders_status_check",
  expectedValues: ["pending", "processing", "shipped", "delivered", "cancelled", "rto"],
});

// ------------------------------------------------------------- Payments --
export function paymentRetryCap(repoRoot) {
  const hits = findLinesInFile(repoRoot, "server/src/services/paymentService.js", /MAX_PAYMENT_ATTEMPTS_PER_ORDER\s*=\s*(\d+)/);
  const enforceHits = findLinesInFile(repoRoot, "server/src/services/paymentService.js", /nextAttemptNumber\s*>\s*MAX_PAYMENT_ATTEMPTS_PER_ORDER/);
  if (!hits || hits.length === 0) {
    return { compliance: "NOT_IMPLEMENTED", confidence: "MEDIUM", expected: "a numeric cap constant on payment attempts", observed: "MAX_PAYMENT_ATTEMPTS_PER_ORDER not found", evidence: [] };
  }
  const capMatch = hits[0].text.match(/=\s*(\d+)/);
  const cap = capMatch ? Number(capMatch[1]) : null;
  const enforced = enforceHits && enforceHits.length > 0;
  return {
    compliance: enforced && cap > 0 ? "IMPLEMENTED" : "PARTIALLY_IMPLEMENTED",
    confidence: "HIGH",
    expected: "a positive cap constant that is actually enforced before creating a new attempt",
    observed: `cap=${cap}, enforced=${enforced}`,
    evidence: [ev("server/src/services/paymentService.js", hits[0].line, hits[0].text), ...(enforceHits || []).map((h) => ev("server/src/services/paymentService.js", h.line, h.text))],
  };
}

export function webhookSignatureVerification(repoRoot) {
  const verifyHits = findLinesInFile(repoRoot, "server/src/routes/paymentsPublic.js", /verifyWebhookSignature/);
  const rejectHits = findLinesInFile(repoRoot, "server/src/routes/paymentsPublic.js", /if\s*\(\s*!signatureValid\s*\)/);
  if (!verifyHits || verifyHits.length === 0) {
    return { compliance: "NOT_IMPLEMENTED", confidence: "MEDIUM", expected: "webhook route calls verifyWebhookSignature before processing", observed: "not found in server/src/routes/paymentsPublic.js", evidence: [] };
  }
  const rejects = rejectHits && rejectHits.length > 0;
  return {
    compliance: rejects ? "IMPLEMENTED" : "PARTIALLY_IMPLEMENTED",
    confidence: "HIGH",
    expected: "signature verified and an invalid signature is rejected (non-2xx), never silently accepted",
    observed: `verify call at line ${verifyHits[0].line}; explicit reject-on-invalid ${rejects ? `at line ${rejectHits[0].line}` : "not found"}`,
    evidence: [ev("server/src/routes/paymentsPublic.js", verifyHits[0].line, verifyHits[0].text)],
  };
}

export const paymentStatusEnum = enumChecker({
  table: "payments",
  column: "status",
  expectedValues: ["INITIATED", "PENDING", "SUCCESS", "FAILED", "CANCELLED", "REFUNDED", "PARTIALLY_REFUNDED"],
});

export const refundStatusEnum = enumChecker({
  table: "refunds",
  column: "status",
  expectedValues: ["INITIATED", "PROCESSED", "FAILED"],
});

export const returnRequestStatusEnum = enumChecker({
  table: "return_requests",
  column: "status",
  expectedValues: ["requested", "approved", "rejected", "refunded"],
});

// -------------------------------------------------------------- Notify --
export function notifyNeverThrows(repoRoot) {
  const content = readFileSafe(repoRoot, "server/src/notify/notificationService.js");
  if (content === null) {
    return { compliance: "NEEDS_REVIEW", confidence: "LOW", expected: "notify() never throws", observed: "notificationService.js not found", evidence: [] };
  }
  const fnMatch = content.match(/export async function notify\s*\([\s\S]*$/);
  if (!fnMatch) {
    return { compliance: "NEEDS_REVIEW", confidence: "LOW", expected: "notify() never throws", observed: "could not locate notify() function body", evidence: [] };
  }
  const body = fnMatch[0];
  // Generous window: the function's own parameter destructuring can be long
  // (this file's notify() signature runs ~95 chars before its body even
  // opens), so a short fixed-offset check would false-negative on a
  // perfectly correct try-wraps-everything implementation.
  const hasOuterTry = /\btry\s*\{/.test(body.slice(0, 400));
  const hasCatch = /catch\s*\(\s*e\s*\)\s*\{/.test(body);
  const rethrows = /catch\s*\(\s*e\s*\)\s*\{[^}]*\bthrow\b/.test(body);
  const lineOfFn = content.slice(0, content.indexOf("export async function notify")).split(/\r?\n/).length;
  const compliant = hasOuterTry && hasCatch && !rethrows;
  return {
    compliance: compliant ? "IMPLEMENTED" : "ACCIDENTALLY_CHANGED",
    confidence: "HIGH",
    expected: "notify() body is wrapped in try/catch and the catch block never re-throws",
    observed: `hasOuterTry=${hasOuterTry}, hasCatch=${hasCatch}, rethrows=${rethrows}`,
    evidence: [ev("server/src/notify/notificationService.js", lineOfFn, "export async function notify(...)")],
  };
}

export function notificationDedupConstraint(repoRoot) {
  const hits = findLinesInFile(repoRoot, "supabase/migrations/0009_phase7_notifications_and_legal_cms.sql", /unique\s*\(\s*event\s*,\s*channel\s*,\s*dedupe_key\s*\)/);
  if (!hits || hits.length === 0) {
    return { compliance: "NOT_IMPLEMENTED", confidence: "MEDIUM", expected: "unique(event, channel, dedupe_key) on notification_log", observed: "constraint not found", evidence: [] };
  }
  return {
    compliance: "IMPLEMENTED",
    confidence: "HIGH",
    expected: "unique(event, channel, dedupe_key) on notification_log",
    observed: `constraint found at line ${hits[0].line}`,
    evidence: [ev("supabase/migrations/0009_phase7_notifications_and_legal_cms.sql", hits[0].line, hits[0].text)],
  };
}

// ----------------------------------------------------------------- Tax --
export function taxSnapshotColumns(repoRoot) {
  const required = ["hsn_code_snapshot", "tax_rate_snapshot", "cgst_amount_snapshot", "sgst_amount_snapshot", "igst_amount_snapshot"];
  const content = readFileSafe(repoRoot, "server/src/routes/public.js");
  if (content === null) {
    return { compliance: "NEEDS_REVIEW", confidence: "LOW", expected: required.join(", "), observed: "public.js not found", evidence: [] };
  }
  const missing = required.filter((col) => !content.includes(col));
  return {
    compliance: missing.length === 0 ? "IMPLEMENTED" : "PARTIALLY_IMPLEMENTED",
    confidence: "HIGH",
    expected: required.join(", "),
    observed: missing.length === 0 ? "all snapshot columns written at checkout" : `missing: ${missing.join(", ")}`,
    evidence: [ev("server/src/routes/public.js", 201, "order_items insert includes *_snapshot columns")],
  };
}

export function taxProfileGstRegisteredDormant(repoRoot) {
  const hits = findLinesInFile(repoRoot, "supabase/schema.sql", /gst_registered/);
  return {
    compliance: "NOT_APPLICABLE",
    confidence: "LOW",
    expected: "gst_registered remains false until GST-advisor sign-off; live setting value cannot be confirmed statically",
    observed: hits && hits.length ? `gst_registered referenced in schema.sql (line ${hits[0].line}); current live value is DB state, not visible to static analysis` : "gst_registered not found in schema.sql (may be a settings JSON value only, not a column)",
    evidence: hits && hits.length ? [ev("supabase/schema.sql", hits[0].line, hits[0].text)] : [],
    recommendation: "This is a business decision gate (needs GST-advisor sign-off), not something static analysis can verify - confirm current settings.tax_profile.gst_registered value via Admin -> Settings before enabling exclusive mode.",
  };
}

// ----------------------------------------------------------- Discovery --
const AI_SDK_PATTERNS = [/@anthropic-ai/i, /\bopenai\b/i, /langchain/i, /google\.generativeai/i, /\bmistralai\b/i, /\bcohere\b/i, /\bollama\b/i];

export function deterministicNoAiDependency(repoRoot) {
  const hits = [];
  for (const pattern of AI_SDK_PATTERNS) {
    hits.push(...findLinesInDir(repoRoot, "server/src", pattern, { extensions: [".js"] }));
  }
  const pkgContent = readFileSafe(repoRoot, "server/package.json");
  const pkgHasAiDep = pkgContent && AI_SDK_PATTERNS.some((p) => p.test(pkgContent));
  if (hits.length === 0 && !pkgHasAiDep) {
    return {
      compliance: "IMPLEMENTED",
      confidence: "MEDIUM",
      expected: "no AI/ML/LLM SDK imports or dependency anywhere under server/src",
      observed: "No AI/ML/LLM SDK references found in server/src or server/package.json",
      evidence: [ev("server/src/services/wellnessService.js", 3, "own docstring: 'Deterministic only (no AI/ML/LLM anywhere in this file)'")],
    };
  }
  return {
    compliance: "UNAPPROVED",
    confidence: "MEDIUM",
    expected: "no AI/ML/LLM SDK imports or dependency anywhere under server/src",
    observed: `Found ${hits.length} reference(s) to an AI/ML SDK pattern`,
    evidence: hits.slice(0, 5).map((h) => ev(h.file, h.line, h.text)),
    recommendation: "An AI/ML/LLM dependency was introduced - confirm this was an explicit, approved product decision, since deterministic-only logic is an established, repeated business rule across dosha/search/recommendations.",
  };
}

export function noMarketplaceSellerTables(repoRoot) {
  const content = readFileSafe(repoRoot, "supabase/schema.sql");
  const migrations = listMigrations(repoRoot).map((f) => readFileSafe(repoRoot, f) || "");
  const all = [content || "", ...migrations].join("\n");
  const sellerTableHit = /create table\s+(sellers|vendors|marketplace_\w+)/i.exec(all);
  return {
    compliance: sellerTableHit ? "UNAPPROVED" : "NOT_APPLICABLE",
    confidence: "MEDIUM",
    expected: "no sellers/vendors/marketplace_* table in schema",
    observed: sellerTableHit ? `Found table definition matching "${sellerTableHit[1]}"` : "No seller/vendor/marketplace table found",
    evidence: sellerTableHit ? [ev("supabase/schema.sql", null, sellerTableHit[0])] : [],
    recommendation: sellerTableHit ? "A marketplace/seller concept appears to have been introduced - confirm this was an approved architecture change (see docs/AYURVEDICSTORE-PHASE-0-AUDIT.md's locked single-brand decision)." : null,
  };
}

// ----------------------------------------------------------------- RBAC --
export function rbacDeferredToWiringGuardian(repoRoot) {
  const wgReportPath = path.join(repoRoot, "quality-agents/wiring-guardian/reports/wiring-guardian.latest.json");
  if (!fs.existsSync(wgReportPath)) {
    return {
      compliance: "NEEDS_REVIEW",
      confidence: "LOW",
      expected: "requireStaffAuth + requirePermission on every mutating admin route",
      observed: "No quality-agents/wiring-guardian report found to consult - Requirements Guardian does not implement its own RBAC sweep (that would duplicate Wiring Guardian's security-engine scope).",
      evidence: [],
      recommendation: "Run Wiring Guardian (npm run wiring:guardian) and re-run this check, or verify RBAC coverage manually.",
    };
  }
  let report;
  try {
    report = JSON.parse(fs.readFileSync(wgReportPath, "utf8"));
  } catch {
    return { compliance: "NEEDS_REVIEW", confidence: "LOW", expected: "n/a", observed: "wiring-guardian.latest.json could not be parsed", evidence: [] };
  }
  const rbacFindings = (report.findings || []).filter((f) => f.category === "rbac" || f.category === "rbac-consistency");
  const openHighSeverity = rbacFindings.filter((f) => f.severity === "P0" || f.severity === "P1");
  return {
    compliance: openHighSeverity.length === 0 ? "IMPLEMENTED" : "CONFLICTING",
    confidence: "MEDIUM",
    expected: "zero open P0/P1 RBAC findings in Wiring Guardian's own security-engine",
    observed: `Wiring Guardian report (generated ${report.generatedAt}) has ${rbacFindings.length} RBAC finding(s), ${openHighSeverity.length} at P0/P1`,
    evidence: openHighSeverity.slice(0, 5).map((f) => ev(f.file, f.line, f.observed)),
    recommendation: "This requirement's compliance is entirely sourced from Wiring Guardian's independent RBAC engine - see quality-agents/wiring-guardian/reports/.",
  };
}

// ------------------------------------------------------------- Settings --
export function staleSettingsUiTextAbsent(repoRoot) {
  const hits = findLinesInDir(repoRoot, "admin", /not editable here for security/i, { extensions: [".html", ".js"] });
  return {
    compliance: hits.length === 0 ? "IMPLEMENTED" : "ACCIDENTALLY_CHANGED",
    confidence: "MEDIUM",
    expected: "the stale 'configured via server .env - not editable here' Razorpay/PayU text is absent from the admin UI",
    observed: hits.length === 0 ? "Stale text not found under admin/" : `Found ${hits.length} occurrence(s) of the stale text`,
    evidence: hits.slice(0, 3).map((h) => ev(h.file, h.line, h.text)),
  };
}
