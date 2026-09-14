import { sortFindings, countBySeverity, complianceScore, SEVERITY_ORDER } from "../../src/severity/classify.js";
import { assertEqual, assert } from "../helpers.js";

export default async function run() {
  const findings = [
    { severity: "P2", confidence: "HIGH" },
    { severity: "P0", confidence: "HIGH" },
    { severity: "P3", confidence: "HIGH" },
    { severity: "P1", confidence: "HIGH" },
  ];
  const sorted = sortFindings(findings);
  assertEqual(sorted.map((f) => f.severity).join(","), "P0,P1,P2,P3", "sortFindings must order P0 first, P3 last");

  const counts = countBySeverity(findings);
  assertEqual(counts.P0, 1, "one P0 expected");
  assertEqual(counts.P2, 1, "one P2 expected");

  const clean = complianceScore([]);
  assertEqual(clean.score, 100, "zero findings must score 100");
  assertEqual(clean.hasCritical, false, "zero findings must not be critical");

  const withP0 = complianceScore([{ severity: "P0", confidence: "HIGH" }]);
  assertEqual(withP0.score, 60, "one P0 at penalty 40 must score 60");
  assertEqual(withP0.hasCritical, true, "a P0 finding must set hasCritical");

  // LOW-confidence findings must not move the score at all.
  const lowConfOnly = complianceScore([{ severity: "P0", confidence: "LOW" }]);
  assertEqual(lowConfOnly.score, 100, "a LOW-confidence finding must never move the compliance score");
  assertEqual(lowConfOnly.informationalCount, 1, "a LOW-confidence finding must be counted as informational");

  assertEqual(SEVERITY_ORDER.join(","), "P0,P1,P2,P3", "severity order must be P0..P3");

  return { assertions: 8 };
}
