// ============================================================
// 5. WEIGHTED SCORING ENGINE
// ============================================================
// Turns comparator category results into a transparent overall score.
//
// Categories with no usable evidence (evidenceLevel "none" - typically
// components/typography/spacing without an authored spec) are EXCLUDED
// from the weighted average and its weights are renormalized across the
// remaining categories, rather than being scored as if evidence existed.
// Confidence, separately, is computed over the ORIGINAL (non-renormalized)
// weights, so leaning on excluded categories still visibly lowers overall
// confidence even though it doesn't tank the score itself.
const EVIDENCE_WEIGHT = { high: 1, medium: 0.66, low: 0.33, none: 0 };

export function scoreAudit({ categoryResults, weights, navError }) {
  const categories = Object.keys(weights);
  const available = categories.filter((c) => categoryResults[c]?.score !== null && categoryResults[c] !== undefined);
  const availableWeightSum = available.reduce((s, c) => s + weights[c], 0) || 1;

  const categoryScores = {};
  for (const c of categories) {
    categoryScores[c] = categoryResults[c]?.score ?? null;
  }

  const overall = navError
    ? 0
    : Math.round(available.reduce((sum, c) => sum + categoryResults[c].score * (weights[c] / availableWeightSum), 0));

  const confidenceRaw = categories.reduce((sum, c) => sum + weights[c] * (EVIDENCE_WEIGHT[categoryResults[c]?.evidenceLevel || "none"]), 0);
  const confidence = Math.round(confidenceRaw * 100);

  const visualFidelity = categoryResults.layout?.visualDiffRatio !== undefined ? Math.round(100 * (1 - Math.min(1, categoryResults.layout.visualDiffRatio / 0.5))) : null;
  const structuralParts = ["layout", "components", "spacing"].map((c) => categoryScores[c]).filter((v) => v !== null);
  const structuralFidelity = structuralParts.length ? Math.round(structuralParts.reduce((a, b) => a + b, 0) / structuralParts.length) : null;
  const functionalFidelity = categoryScores.functional ?? null;
  const responsiveFidelity = categoryScores.responsive ?? null;

  let status = "NEEDS FIX";
  if (navError) status = "BLOCKED";
  else if (overall >= 90 && (functionalFidelity ?? 100) >= 90) status = "PASS";

  return {
    overall, categoryScores, confidence, status,
    visualFidelity, structuralFidelity, functionalFidelity, responsiveFidelity,
    excludedCategories: categories.filter((c) => !available.includes(c)),
    weightsUsed: Object.fromEntries(available.map((c) => [c, Number((weights[c] / availableWeightSum).toFixed(3))])),
  };
}

export function loadWeights(raw) {
  const entries = Object.entries(raw).filter(([k]) => !k.startsWith("_"));
  const sum = entries.reduce((s, [, v]) => s + v, 0) || 1;
  return Object.fromEntries(entries.map(([k, v]) => [k, v / sum]));
}
