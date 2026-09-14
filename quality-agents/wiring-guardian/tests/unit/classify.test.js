import { countBySeverity, categoryHealth, overallHealth, sortFindings } from "../../src/severity/classify.js";
import { assert, assertEqual } from "../helpers.js";

function f(severity, confidence = "high") {
  return { severity, confidence };
}

export default async function () {
  assertEqual(countBySeverity([f("P0"), f("P1"), f("P1"), f("P3")]), { P0: 1, P1: 2, P2: 0, P3: 1 }, "counts findings per severity");

  const sorted = sortFindings([f("P3"), f("P0"), f("P2"), f("P1")]);
  assertEqual(sorted.map((x) => x.severity), ["P0", "P1", "P2", "P3"], "sorts most-severe first");

  const clean = categoryHealth([]);
  assertEqual(clean.score, 100, "a category with no findings scores 100");

  const oneP0 = categoryHealth([f("P0")]);
  assertEqual(oneP0.score, 60, "one P0 (penalty 40) scores 60");
  assert(oneP0.hasCritical, "a P0 finding sets hasCritical");

  const manyLowConfidenceP3s = categoryHealth(Array.from({ length: 50 }, () => f("P3", "low")));
  assertEqual(manyLowConfidenceP3s.score, 100, "a swarm of low-confidence P3 leads does not tank the score");
  assertEqual(manyLowConfidenceP3s.informationalCount, 50, "but they are still counted/reported as informational");

  const someHighConfidenceP3s = categoryHealth(Array.from({ length: 5 }, () => f("P3", "high")));
  assertEqual(someHighConfidenceP3s.score, 95, "high-confidence P3s still count toward the score (5 * 1 penalty)");

  const overall = overallHealth({ a: { score: 90, hasCritical: false }, b: { score: 40, hasCritical: true }, c: { score: 100, hasCritical: false } });
  assertEqual(overall.score, 40, "overall health is the MINIMUM across categories, never an average");
  assert(overall.anyCritical, "overall health surfaces if ANY category has a critical finding");

  return { checks: 8 };
}
