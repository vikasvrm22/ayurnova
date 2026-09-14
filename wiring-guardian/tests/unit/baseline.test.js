import fs from "fs";
import path from "path";
import os from "os";
import { saveBaseline, loadBaseline, compareToBaseline } from "../../src/baseline/baseline.js";
import { assert, assertEqual } from "../helpers.js";

function finding(overrides) {
  return { layer: "L1", category: "contract", file: "a.js", route: "GET /x", observed: "obs", ...overrides };
}

export default async function () {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wg-baseline-test-"));

  assertEqual(loadBaseline(tmpRoot), null, "no baseline file yet -> loadBaseline returns null");

  const noBaselineCompare = compareToBaseline(null, [finding({})]);
  assertEqual(noBaselineCompare.hasBaseline, false, "compareToBaseline reports hasBaseline:false when there is nothing saved yet");

  const initial = [finding({ observed: "issue A" }), finding({ observed: "issue B" })];
  saveBaseline(tmpRoot, { auditedAt: "2026-01-01T00:00:00.000Z", findings: initial });

  const loaded = loadBaseline(tmpRoot);
  assert(loaded && loaded.findings.length === 2, "saved baseline round-trips through loadBaseline");

  const currentSameAsBaseline = compareToBaseline(loaded, initial);
  assertEqual(currentSameAsBaseline.regressions.length, 0, "identical findings vs baseline -> no regressions");
  assertEqual(currentSameAsBaseline.resolved.length, 0, "identical findings vs baseline -> nothing resolved");

  const currentWithNewIssue = [finding({ observed: "issue A" }), finding({ observed: "issue C (new)" })];
  const diff = compareToBaseline(loaded, currentWithNewIssue);
  assertEqual(diff.regressions.length, 1, "a finding not in the baseline is a regression");
  assertEqual(diff.regressions[0].observed, "issue C (new)", "the regression is identified correctly");
  assertEqual(diff.resolved.length, 1, "a baseline finding missing from the current run is resolved");
  assertEqual(diff.resolved[0].observed, "issue B", "the resolved finding is identified correctly");

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  return { checks: 8 };
}
