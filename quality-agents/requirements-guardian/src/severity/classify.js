// Own copy of the severity model, matching quality-agents/wiring-guardian's
// proven shape (P0-P3, confidence-gated scoring) - not imported cross-agent,
// per the ecosystem independence rule (docs/quality/AYURNOVA-AGENT-ECOSYSTEM.md).
export const SEVERITY_ORDER = ["P0", "P1", "P2", "P3"];

export function sortFindings(findings) {
  return [...findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
}

export function countBySeverity(findings) {
  const out = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const f of findings) out[f.severity] = (out[f.severity] || 0) + 1;
  return out;
}

/** Transparent compliance score: 100 minus a fixed penalty per open finding
 * severity, floored at 0. Only confidence HIGH|MEDIUM findings move the
 * score - a LOW-confidence finding (NEEDS_REVIEW leads) is always reported
 * in full but never silently inflates or deflates the headline number. */
const PENALTY = { P0: 40, P1: 15, P2: 5, P3: 1 };

export function complianceScore(findings) {
  const counts = countBySeverity(findings);
  const scored = findings.filter((f) => f.confidence !== "LOW");
  const scoredCounts = countBySeverity(scored);
  const penalty =
    scoredCounts.P0 * PENALTY.P0 + scoredCounts.P1 * PENALTY.P1 + scoredCounts.P2 * PENALTY.P2 + scoredCounts.P3 * PENALTY.P3;
  const score = Math.max(0, 100 - penalty);
  return {
    score,
    counts,
    informationalCount: findings.length - scored.length,
    formula: "100 - (P0*40 + P1*15 + P2*5 + P3*1) over confidence:HIGH|MEDIUM findings only, floored at 0",
    hasCritical: counts.P0 > 0,
  };
}
