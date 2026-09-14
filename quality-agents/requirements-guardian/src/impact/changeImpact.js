import { execSync } from "child_process";

/** The concrete file(s) each requirement's checker actually reads (mirrors
 * the literal paths in ../compliance/checkers/index.js). Kept as an
 * explicit, maintained map rather than re-parsing the checkers source, so a
 * changed file that exactly matches one of these is DIRECT-confidence
 * impact evidence, not a guess. Update this map whenever a checker's target
 * file(s) change. */
export const REQUIREMENT_DIRECT_FILES = {
  "REQ-COD-001": ["server/src/routes/public.js"],
  "REQ-COD-002": ["server/src/routes/returnsAdmin.js"],
  "REQ-SECRETS-001": ["server/src/config.js"],
  "REQ-SECRETS-002": ["server/src/scripts/seedAdmin.js"],
  "REQ-LEGAL-001": ["server/src/routes/pages.js"],
  "REQ-LEGAL-002": ["supabase/schema.sql", "supabase/migrations"],
  "REQ-LEGAL-CONTENT-001": ["supabase/migrations/0009_phase7_notifications_and_legal_cms.sql"],
  "REQ-SHIPPING-001": ["server/src/integrations/shipping/registry.js"],
  "REQ-SHIPMENT-STATE-001": ["supabase/migrations"],
  "REQ-ORDERS-STATE-001": ["supabase/migrations"],
  "REQ-PAYMENT-RETRY-001": ["server/src/services/paymentService.js"],
  "REQ-PAYMENT-WEBHOOK-001": ["server/src/routes/paymentsPublic.js"],
  "REQ-PAYMENT-STATE-001": ["supabase/migrations"],
  "REQ-REFUND-STATE-001": ["supabase/migrations"],
  "REQ-RETURNS-STATE-001": ["supabase/migrations"],
  "REQ-NOTIFY-001": ["server/src/notify/notificationService.js"],
  "REQ-NOTIFY-002": ["supabase/migrations/0009_phase7_notifications_and_legal_cms.sql"],
  "REQ-TAX-001": ["server/src/routes/public.js"],
  "REQ-TAX-GST-001": ["supabase/schema.sql"],
  "REQ-DETERMINISTIC-001": ["server/src"],
  "REQ-MARKETPLACE-001": ["supabase/schema.sql", "supabase/migrations"],
  "REQ-RBAC-001": ["quality-agents/wiring-guardian/reports/wiring-guardian.latest.json"],
  "REQ-SETTINGS-UI-001": ["admin"],
};

function normalize(p) {
  return p.replace(/\\/g, "/");
}

/** Returns the list of files changed relative to `base` (default: working
 * tree vs HEAD, i.e. uncommitted changes; pass a ref/range for a commit
 * comparison). Read-only - never stages, commits, or resets anything. */
export function getChangedFiles(repoRoot, { base = "HEAD" } = {}) {
  try {
    const out = execSync(`git diff --name-only ${base}`, { cwd: repoRoot, encoding: "utf8" });
    const staged = execSync(`git diff --name-only --cached`, { cwd: repoRoot, encoding: "utf8" });
    const untracked = execSync(`git ls-files --others --exclude-standard`, { cwd: repoRoot, encoding: "utf8" });
    const all = new Set([...out.split("\n"), ...staged.split("\n"), ...untracked.split("\n")].map(normalize).filter(Boolean));
    return [...all];
  } catch (e) {
    return { error: `git diff failed: ${e.message}` };
  }
}

/** Maps a changed-file set to affected requirements at DIRECT / INDIRECT /
 * POSSIBLE confidence (spec section 16/20). Never claims impact without
 * evidence: every entry names the exact matching rule that produced it. */
export function analyzeImpact(registry, changedFiles) {
  const files = changedFiles.map(normalize);
  const results = [];

  for (const req of registry.requirements) {
    const directFiles = REQUIREMENT_DIRECT_FILES[req.id] || [];
    const directMatch = files.find((f) => directFiles.some((d) => f === d || f.startsWith(`${d}/`) || (d.endsWith(".sql") === false && d.includes("migrations") && f.startsWith(d))));
    if (directMatch) {
      results.push({ requirementId: req.id, title: req.title, confidence: "DIRECT", reason: `Changed file "${directMatch}" is a known target of this requirement's compliance checker.` });
      continue;
    }

    const sourceFile = req.sourceReference?.file;
    if (sourceFile && files.includes(normalize(sourceFile))) {
      results.push({ requirementId: req.id, title: req.title, confidence: "DIRECT", reason: `Changed file "${sourceFile}" is this requirement's own approved-source document/file.` });
      continue;
    }

    // Word-boundary match, not a raw substring test - otherwise a scope tag
    // like "cod" would falsely match an unrelated path such as
    // "codeDiscovery.js" (a real false positive this checker hit in its own
    // first self-audit).
    const scopeMatch = files.find((f) => (req.scope || []).some((tag) => new RegExp(`\\b${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(f)));
    if (scopeMatch) {
      results.push({ requirementId: req.id, title: req.title, confidence: "INDIRECT", reason: `Changed file "${scopeMatch}" path matches this requirement's scope tag(s): ${req.scope.join(", ")}.` });
      continue;
    }

    const anySchemaChange = files.some((f) => f.startsWith("supabase/"));
    if (anySchemaChange && (req.category === "STATE_RULE" || req.category === "DATA_CONTRACT")) {
      results.push({ requirementId: req.id, title: req.title, confidence: "POSSIBLE", reason: "A schema/migration file changed and this requirement is a STATE_RULE/DATA_CONTRACT - worth re-checking, but no direct file match was found." });
    }
  }

  return {
    changedFiles: files,
    affected: results,
    counts: {
      DIRECT: results.filter((r) => r.confidence === "DIRECT").length,
      INDIRECT: results.filter((r) => r.confidence === "INDIRECT").length,
      POSSIBLE: results.filter((r) => r.confidence === "POSSIBLE").length,
    },
  };
}
