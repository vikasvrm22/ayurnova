export const SEVERITY_ORDER = ["P0", "P1", "P2", "P3"];

export function sortFindings(findings) {
  return [...findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
}

export function countBySeverity(findings) {
  const out = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const f of findings) out[f.severity] = (out[f.severity] || 0) + 1;
  return out;
}

/** Transparent per-category health score (spec section 32): 100 minus a
 * fixed penalty per open finding severity, floored at 0. No hidden weights,
 * and P0/P1 counts are always reported alongside the score so they can
 * never be hidden behind a deceptively high number.
 *
 * Only findings the engine itself is willing to stand behind (confidence
 * "high" or "medium") are scored. A confidence:"low" finding (this build
 * only ever assigns that to P3 leads such as "no frontend caller found for
 * this route - confirm it's intentional") is still reported in full, but
 * does not move the score - the whole point of tagging something low-
 * confidence is that it is a lead for a human, not a claim of a defect, and
 * a large batch of them should not read as "this category is broken" when
 * zero P0/P1/P2 findings exist. */
const PENALTY = { P0: 40, P1: 15, P2: 5, P3: 1 };

export function categoryHealth(findings) {
  const counts = countBySeverity(findings);
  const scored = findings.filter((f) => f.confidence !== "low");
  const scoredCounts = countBySeverity(scored);
  const penalty =
    scoredCounts.P0 * PENALTY.P0 + scoredCounts.P1 * PENALTY.P1 + scoredCounts.P2 * PENALTY.P2 + scoredCounts.P3 * PENALTY.P3;
  const score = Math.max(0, 100 - penalty);
  return {
    score,
    counts,
    informationalCount: findings.length - scored.length,
    formula: "100 - (P0*40 + P1*15 + P2*5 + P3*1) over confidence:high|medium findings only, floored at 0",
    hasCritical: counts.P0 > 0,
  };
}

/** Overall health is the MINIMUM of category scores (a single weak layer
 * drags the whole number down), never an average that could hide one
 * critical category behind several healthy ones - section 32's requirement
 * that P0/P1 findings override a high aggregate score. */
export function overallHealth(categoryScores) {
  const values = Object.values(categoryScores).map((c) => c.score);
  const anyCritical = Object.values(categoryScores).some((c) => c.hasCritical);
  return {
    score: values.length ? Math.min(...values) : 100,
    formula: "min(all category scores) - one broken layer caps the overall score, it is never averaged away",
    anyCritical,
  };
}
