import { runCompliance } from "../../src/compliance/runCompliance.js";
import { assert, assertEqual } from "../helpers.js";

function req(overrides) {
  return {
    id: "REQ-FIX-001",
    title: "fixture",
    category: "BUSINESS_RULE",
    priority: "P1",
    scope: ["fixture"],
    requirement: "fixture requirement",
    sourceReference: { file: "docs/fixture.md", line: 1 },
    ...overrides,
  };
}

function verdict(overrides) {
  return { compliance: "IMPLEMENTED", confidence: "HIGH", expected: "e", observed: "o", evidence: [], ...overrides };
}

export default async function run() {
  const registry = {
    requirements: [
      req({ id: "REQ-ACTIVE-PASS", lifecycle: "ACTIVE", checkerId: "activePass" }),
      req({ id: "REQ-ACTIVE-FAIL", lifecycle: "ACTIVE", checkerId: "activeFail" }),
      req({ id: "REQ-ACTIVE-LOWCONF", lifecycle: "ACTIVE", checkerId: "activeLowConfidenceFail" }),
      req({ id: "REQ-FUTURE-CLEAN", lifecycle: "FUTURE", checkerId: "futureNotImplemented" }),
      req({ id: "REQ-FUTURE-PREMATURE", lifecycle: "FUTURE", checkerId: "futureImplemented" }),
      req({ id: "REQ-FUTURE-NOCHECKER", lifecycle: "FUTURE", checkerId: null }),
      req({ id: "REQ-DEPRECATED-CLEAN", lifecycle: "DEPRECATED", checkerId: "deprecatedClean" }),
      req({ id: "REQ-DEPRECATED-RESIDUAL", lifecycle: "DEPRECATED", checkerId: "deprecatedResidual" }),
      req({ id: "REQ-HISTORICAL", lifecycle: "HISTORICAL", checkerId: "activeFail" }), // checker should never even run/matter
      req({ id: "REQ-CONFLICTED", lifecycle: "CONFLICTED", checkerId: "activeFail" }),
      req({ id: "REQ-NEEDS-REVIEW", lifecycle: "NEEDS_REVIEW", checkerId: "activeFail" }),
      req({ id: "REQ-ACTIVE-NOCHECKER", lifecycle: "ACTIVE", checkerId: null }),
    ],
  };

  const fakeCheckers = {
    activePass: () => verdict({ compliance: "IMPLEMENTED", confidence: "HIGH" }),
    activeFail: () => verdict({ compliance: "NOT_IMPLEMENTED", confidence: "HIGH" }),
    activeLowConfidenceFail: () => verdict({ compliance: "NOT_IMPLEMENTED", confidence: "LOW" }),
    futureNotImplemented: () => verdict({ compliance: "NOT_IMPLEMENTED", confidence: "HIGH" }),
    futureImplemented: () => verdict({ compliance: "IMPLEMENTED", confidence: "HIGH" }),
    deprecatedClean: () => verdict({ compliance: "NOT_IMPLEMENTED", confidence: "HIGH" }), // old behavior genuinely gone
    deprecatedResidual: () => verdict({ compliance: "ACCIDENTALLY_CHANGED", confidence: "HIGH" }), // old behavior still present
  };

  const { verifications, findings } = runCompliance(registry, "/fake/repo", fakeCheckers);
  const byId = Object.fromEntries(verifications.map((v) => [v.requirementId, v]));

  assertEqual(byId["REQ-ACTIVE-PASS"].compliance, "IMPLEMENTED", "ACTIVE + passing checker -> IMPLEMENTED");
  assertEqual(byId["REQ-ACTIVE-FAIL"].compliance, "NOT_IMPLEMENTED", "ACTIVE + failing checker -> NOT_IMPLEMENTED stands");
  assertEqual(byId["REQ-ACTIVE-LOWCONF"].compliance, "NEEDS_REVIEW", "LOW confidence violation must be downgraded to NEEDS_REVIEW, never stand as a hard defect");
  assertEqual(byId["REQ-FUTURE-CLEAN"].compliance, "NOT_APPLICABLE", "FUTURE + not implemented -> NOT_APPLICABLE, never a defect");
  assertEqual(byId["REQ-FUTURE-PREMATURE"].compliance, "UNAPPROVED", "FUTURE + prematurely implemented -> UNAPPROVED");
  assertEqual(byId["REQ-FUTURE-NOCHECKER"].compliance, "NOT_APPLICABLE", "FUTURE with no checker -> NOT_APPLICABLE (absence is not a defect)");
  assertEqual(byId["REQ-DEPRECATED-CLEAN"].compliance, "NOT_APPLICABLE", "DEPRECATED with no residual behavior -> NOT_APPLICABLE");
  assertEqual(byId["REQ-DEPRECATED-RESIDUAL"].compliance, "ACCIDENTALLY_CHANGED", "DEPRECATED with residual old behavior -> ACCIDENTALLY_CHANGED (regression)");
  assertEqual(byId["REQ-HISTORICAL"].compliance, "NOT_APPLICABLE", "HISTORICAL is never evaluated");
  assertEqual(byId["REQ-CONFLICTED"].compliance, "NEEDS_REVIEW", "CONFLICTED is never auto-resolved");
  assertEqual(byId["REQ-NEEDS-REVIEW"].compliance, "NEEDS_REVIEW", "NEEDS_REVIEW lifecycle always reports NEEDS_REVIEW");
  assertEqual(byId["REQ-ACTIVE-NOCHECKER"].compliance, "NEEDS_REVIEW", "ACTIVE with no checker -> NEEDS_REVIEW, never a fabricated PASS");

  // Findings: only non-IMPLEMENTED/NOT_APPLICABLE verifications become findings.
  const findingIds = findings.map((f) => f.requirementId);
  assert(!findingIds.includes("REQ-ACTIVE-PASS"), "a clean IMPLEMENTED verification must not produce a finding");
  assert(!findingIds.includes("REQ-FUTURE-CLEAN"), "a clean NOT_APPLICABLE verification must not produce a finding");
  assert(findingIds.includes("REQ-ACTIVE-FAIL"), "a real violation must produce a finding");
  assert(findingIds.includes("REQ-FUTURE-PREMATURE"), "an UNAPPROVED premature implementation must produce a finding");

  const activeFailFinding = findings.find((f) => f.requirementId === "REQ-ACTIVE-FAIL");
  assertEqual(activeFailFinding.severity, "P1", "finding severity should come from the requirement's priority");
  assert(activeFailFinding.id.startsWith("RG-"), "finding id must use the RG- prefix");

  return { verifications: verifications.length, findings: findings.length };
}
