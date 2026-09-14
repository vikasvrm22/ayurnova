import fs from "fs";
import os from "os";
import path from "path";
import { saveBaseline, loadBaseline, compareToBaseline } from "../../src/baseline/baseline.js";
import { assertEqual, assert } from "../helpers.js";

export default async function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rg-baseline-test-"));

  assertEqual(loadBaseline(tmpDir), null, "no baseline saved yet should load as null");

  const baselineVerifications = [
    { requirementId: "REQ-1", compliance: "IMPLEMENTED", priority: "P1" },
    { requirementId: "REQ-2", compliance: "NOT_IMPLEMENTED", priority: "P1" },
    { requirementId: "REQ-3", compliance: "NOT_IMPLEMENTED", priority: "P3" },
    { requirementId: "REQ-4", compliance: "NOT_APPLICABLE", priority: "P2" },
  ];
  saveBaseline(tmpDir, { auditedAt: "2026-01-01T00:00:00.000Z", verifications: baselineVerifications });

  const loaded = loadBaseline(tmpDir);
  assert(loaded && loaded.verifications.length === 4, "baseline should round-trip through save/load");

  // No baseline case.
  const noBaselineResult = compareToBaseline(null, baselineVerifications);
  assertEqual(noBaselineResult.hasBaseline, false, "compareToBaseline with no baseline should report hasBaseline:false");

  // Regression: REQ-1 went from IMPLEMENTED to NOT_IMPLEMENTED.
  const currentWithRegression = [
    { requirementId: "REQ-1", compliance: "NOT_IMPLEMENTED", priority: "P1" },
    { requirementId: "REQ-2", compliance: "NOT_IMPLEMENTED", priority: "P1" },
    { requirementId: "REQ-3", compliance: "NOT_IMPLEMENTED", priority: "P3" },
    { requirementId: "REQ-4", compliance: "NOT_APPLICABLE", priority: "P2" },
  ];
  const regressionResult = compareToBaseline(loaded, currentWithRegression);
  assertEqual(regressionResult.regressions.length, 1, "exactly one regression expected");
  assertEqual(regressionResult.regressions[0].requirementId, "REQ-1", "the regression must be REQ-1");

  // Resolution: REQ-2 went from NOT_IMPLEMENTED to IMPLEMENTED.
  const currentWithResolution = [
    { requirementId: "REQ-1", compliance: "IMPLEMENTED", priority: "P1" },
    { requirementId: "REQ-2", compliance: "IMPLEMENTED", priority: "P1" },
    { requirementId: "REQ-3", compliance: "NOT_IMPLEMENTED", priority: "P3" },
    { requirementId: "REQ-4", compliance: "NOT_APPLICABLE", priority: "P2" },
  ];
  const resolutionResult = compareToBaseline(loaded, currentWithResolution);
  assertEqual(resolutionResult.resolved.length, 1, "exactly one resolution expected");
  assertEqual(resolutionResult.resolved[0].requirementId, "REQ-2", "the resolution must be REQ-2");

  // Severity escalation: REQ-3 stays NOT_IMPLEMENTED but priority worsens P3 -> P0.
  const currentWithEscalation = [
    { requirementId: "REQ-1", compliance: "IMPLEMENTED", priority: "P1" },
    { requirementId: "REQ-2", compliance: "NOT_IMPLEMENTED", priority: "P1" },
    { requirementId: "REQ-3", compliance: "NOT_IMPLEMENTED", priority: "P0" },
    { requirementId: "REQ-4", compliance: "NOT_APPLICABLE", priority: "P2" },
  ];
  const escalationResult = compareToBaseline(loaded, currentWithEscalation);
  assertEqual(escalationResult.escalated.length, 1, "exactly one severity escalation expected");
  assertEqual(escalationResult.escalated[0].requirementId, "REQ-3", "the escalation must be REQ-3");

  // Unchanged: an existing NOT_IMPLEMENTED requirement staying NOT_IMPLEMENTED
  // at the same priority must NOT be reported as a new regression (spec:
  // "do not report an existing accepted baseline limitation as a new
  // regression unless evidence shows it changed").
  const unchangedResult = compareToBaseline(loaded, baselineVerifications);
  assertEqual(unchangedResult.regressions.length, 0, "an unchanged known limitation must not be reported as a new regression");
  assertEqual(unchangedResult.unchangedCount, 4, "all four requirements should be reported unchanged");

  fs.rmSync(tmpDir, { recursive: true, force: true });
  return { assertions: 10 };
}
