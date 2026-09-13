// Validation case 2: the SAME reference design audited against a
// deliberately deviated implementation (moved/recolored CTA, missing
// section, broken image, missing alt, dead button, empty href, wrong
// font-size, horizontal overflow). Proves the pipeline actually detects
// and correctly prioritizes real problems - a high score here would mean
// the tool is fooled by "broadly similar" screenshots (the failure mode
// section 15 of the brief explicitly warns against).
import { runFixtureAudit, assert } from "../helpers.js";

export default async function run() {
  const result = await runFixtureAudit("deviations", { additionalViewports: [{ name: "mobile", width: 390, height: 844 }] });

  assert(result.scoring.overall < 70, `expected a visibly degraded overall score, got ${result.scoring.overall}`);
  assert(result.functional.score < 100, `expected functional issues to be detected, got ${result.functional.score}`);

  const kinds = new Set(result.findings.map((f) => f.kind));
  const expectedKinds = ["broken-image", "missing-alt", "gap-mismatch", "missing-element", "missing-section", "dead-button", "empty-href", "font-size", "overflow"];
  const missingKinds = expectedKinds.filter((k) => !kinds.has(k));
  assert(missingKinds.length === 0, `expected to detect ${JSON.stringify(expectedKinds)}, missing ${JSON.stringify(missingKinds)}. Got kinds: ${JSON.stringify([...kinds])}`);

  const severities = new Set(result.findings.map((f) => f.severity));
  assert(severities.has("P0"), "expected at least one P0 (broken image / missing section / overflow are all P0-worthy)");
  assert(severities.has("P1") || severities.has("P2") || severities.has("P3"), "expected severity spread beyond just P0");

  const sorted = [...result.findings];
  const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
  for (let i = 1; i < sorted.length; i++) assert(order[sorted[i].severity] >= order[sorted[i - 1].severity], "findings must be sorted most-severe first");

  const brokenImageFinding = result.findings.find((f) => f.kind === "broken-image");
  assert(brokenImageFinding.recommendation && brokenImageFinding.recommendation.length > 0, "fix plan must include a recommendation");

  return { name: "fixture-deviations", overall: result.scoring.overall, findings: result.findings.length, severities: [...severities] };
}
