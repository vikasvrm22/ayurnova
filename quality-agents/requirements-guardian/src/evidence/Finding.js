let counter = 0;

/** One evidence-driven Requirements Guardian finding. Only emitted for a
 * requirement verification whose compliance is NOT "IMPLEMENTED" (a clean
 * pass is recorded in the requirement registry's verification result, but
 * does not need a finding of its own - see docs/REQUIREMENTS-GUARDIAN.md
 * "Findings vs. verifications"). Mirrors the shape convention already
 * established by quality-agents/wiring-guardian/src/evidence/Finding.js
 * (own copy - no cross-agent import, per the ecosystem's independence rule
 * in docs/quality/AYURNOVA-AGENT-ECOSYSTEM.md). */
export function makeFinding({
  requirementId,
  title,
  compliance,
  severity,
  confidence = "MEDIUM",
  affectedArea = null,
  expected,
  observed,
  evidence,
  recommendation = null,
}) {
  counter += 1;
  return {
    id: `RG-${String(counter).padStart(4, "0")}`,
    requirementId,
    title,
    compliance, // PARTIALLY_IMPLEMENTED | NOT_IMPLEMENTED | ACCIDENTALLY_CHANGED | CONFLICTING | AFFECTED | UNAPPROVED | NEEDS_REVIEW
    severity, // P0 | P1 | P2 | P3
    confidence, // HIGH | MEDIUM | LOW
    affectedArea,
    expected,
    observed,
    evidence, // array of { file, line, detail }
    status: "OPEN",
    fixPolicy: null,
    recommendation,
  };
}

export function resetFindingCounter() {
  counter = 0;
}
