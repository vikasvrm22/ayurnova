import { scoreAudit, loadWeights } from "../../src/lib/scoring.js";
import { assert } from "../helpers.js";

export default async function run() {
  const weights = loadWeights({ layout: 25, components: 20, typography: 10, spacing: 10, assets: 10, colors: 5, responsive: 10, functional: 10 });
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  assert(Math.abs(sum - 1) < 1e-9, `weights must normalize to 1, got ${sum}`);

  // Two categories have no evidence (score: null) - they must be excluded and weights renormalized, not scored as 0.
  const categoryResults = {
    layout: { score: 80, evidenceLevel: "medium" },
    components: { score: null, evidenceLevel: "none" },
    typography: { score: null, evidenceLevel: "none" },
    spacing: { score: 90, evidenceLevel: "high" },
    assets: { score: 100, evidenceLevel: "medium" },
    colors: { score: 95, evidenceLevel: "medium" },
    responsive: { score: 100, evidenceLevel: "high" },
    functional: { score: 100, evidenceLevel: "high" },
  };
  const result = scoreAudit({ categoryResults, weights, navError: null });
  assert(result.excludedCategories.includes("components") && result.excludedCategories.includes("typography"), "components/typography should be excluded when evidenceLevel is none");
  assert(result.categoryScores.components === null, "excluded category score must stay null, not a guessed number");
  assert(result.overall > 0 && result.overall <= 100, `overall out of range: ${result.overall}`);
  assert(result.confidence < 100, "confidence must be reduced by the two evidence-free categories, even though they were excluded from the score");

  const blocked = scoreAudit({ categoryResults, weights, navError: "ECONNREFUSED" });
  assert(blocked.status === "BLOCKED" && blocked.overall === 0, "a navigation error must force BLOCKED/0, regardless of category scores");

  // A perfect run with full evidence should PASS.
  const perfect = { layout: { score: 100, evidenceLevel: "high" }, components: { score: 100, evidenceLevel: "high" }, typography: { score: 100, evidenceLevel: "high" }, spacing: { score: 100, evidenceLevel: "high" }, assets: { score: 100, evidenceLevel: "high" }, colors: { score: 100, evidenceLevel: "high" }, responsive: { score: 100, evidenceLevel: "high" }, functional: { score: 100, evidenceLevel: "high" } };
  const pass = scoreAudit({ categoryResults: perfect, weights, navError: null });
  assert(pass.status === "PASS", `expected PASS for a perfect evidenced run, got ${pass.status}`);

  return { name: "scoring" };
}
