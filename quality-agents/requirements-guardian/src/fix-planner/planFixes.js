/** Requirements Guardian is AUDIT-ONLY (spec section 21/22): it never
 * modifies application behavior. Every finding is classified into exactly
 * two buckets - there is no SAFE_AUTO_FIX path for application code, unlike
 * quality-agents/wiring-guardian which whitelists a handful of deterministic
 * UI-wiring fixes. The only thing this module ever produces is a Fix Plan
 * document for a human to act on. */

const NEVER_PATTERNS = [
  /payment/i,
  /refund/i,
  /\btax\b|gst/i,
  /order/i,
  /inventory/i,
  /\bauth\b|rbac/i,
  /schema|migration/i,
  /secret/i,
  /\.env/,
];

export function classifyFixPolicy(finding) {
  const text = `${finding.affectedArea || ""} ${finding.requirementId} ${finding.title}`;
  return NEVER_PATTERNS.some((p) => p.test(text)) ? "NEVER_AUTO_FIX" : "REVIEW_REQUIRED";
}

/** Annotates every finding with its fix-policy bucket (never applies
 * anything - Requirements Guardian has no --apply-fixes mode at all). */
export function planFixes(findings) {
  return findings.map((f) => ({ ...f, fixPolicy: classifyFixPolicy(f) }));
}

/** One deterministic Fix Plan entry per actionable finding (spec section
 * 22): what's wrong, where, why it violates the requirement, a suggested
 * fix, the risk, and whether human approval is required. Never includes
 * an actual patch or auto-applies anything. */
export function buildFixPlan(findings) {
  return findings.map((f) => ({
    findingId: f.id,
    requirementId: f.requirementId,
    problem: f.title,
    affectedFiles: (f.evidence || []).map((e) => e.file).filter(Boolean),
    whyItViolates: `Expected: ${f.expected || "n/a"}. Observed: ${f.observed || "n/a"}.`,
    suggestedFix: f.recommendation || "No automated suggestion - requires human judgment on the correct product behavior.",
    risk: f.fixPolicy === "NEVER_AUTO_FIX" ? "HIGH - touches payment/tax/order/inventory/auth/schema/secrets" : "MODERATE",
    affectedWorkflows: f.affectedArea ? [f.affectedArea] : [],
    validationRequired: "Re-run `npm run requirements -- audit` after any change and confirm this finding no longer reproduces.",
    humanApprovalRequired: true,
  }));
}
