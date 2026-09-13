// Validation case 1: a faithful implementation of the reference design.
// Proves the pipeline doesn't cry wolf over harmless noise (a live
// timestamp, a 2px CSS rounding difference) and produces a high,
// well-evidenced score end to end (screenshot -> DOM evidence -> score ->
// deviations -> fix plan -> JSON/MD reports).
import fs from "node:fs";
import { runFixtureAudit, assert } from "../helpers.js";

export default async function run() {
  const result = await runFixtureAudit("close-match", { additionalViewports: [{ name: "mobile", width: 390, height: 844 }] });

  assert(result.scoring.status !== "BLOCKED", `expected not BLOCKED, got ${result.scoring.status}`);
  assert(result.scoring.overall >= 85, `expected overall >= 85, got ${result.scoring.overall}`);
  assert(result.scoring.confidence >= 60, `expected reasonable confidence for an authored spec, got ${result.scoring.confidence}`);

  const p0p1 = result.findings.filter((f) => f.severity === "P0" || f.severity === "P1");
  assert(p0p1.length === 0, `expected no P0/P1 findings on a faithful implementation, got ${JSON.stringify(p0p1, null, 2)}`);

  assert(fs.existsSync(result.evidencePaths.screenshot), "actual screenshot was not written");
  assert(fs.existsSync(result.reportPaths.json), "JSON report was not written");
  assert(fs.existsSync(result.reportPaths.md), "Markdown report was not written");
  assert(result.functional.score === 100, `expected a clean functional score, got ${result.functional.score}`);

  return { name: "fixture-close-match", overall: result.scoring.overall, findings: result.findings.length };
}
