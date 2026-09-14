import { detectConflicts } from "../../src/conflict/detectConflicts.js";
import { assertEqual, assert } from "../helpers.js";

export default async function run() {
  const cleanRegistry = {
    structuralErrors: [],
    duplicates: [],
    requirements: [
      { id: "REQ-A-001", title: "A", lifecycle: "ACTIVE" },
      { id: "REQ-B-001", title: "B", lifecycle: "FUTURE" },
    ],
  };
  const clean = detectConflicts(cleanRegistry);
  assertEqual(clean.hasAnyConflict, false, "a clean registry should report no conflicts");
  assertEqual(clean.conflictedRequirements.length, 0, "no CONFLICTED requirements expected");

  const conflictedRegistry = {
    structuralErrors: [],
    duplicates: [],
    requirements: [
      { id: "REQ-A-001", title: "A", lifecycle: "ACTIVE" },
      {
        id: "REQ-C-001",
        title: "Conflicting requirement",
        lifecycle: "CONFLICTED",
        sourceReference: { file: "docs/one.md", line: 1 },
      },
    ],
  };
  const result = detectConflicts(conflictedRegistry);
  assertEqual(result.hasAnyConflict, true, "a registry with a CONFLICTED requirement must report a conflict");
  assertEqual(result.conflictedRequirements.length, 1, "exactly one CONFLICTED requirement expected");
  assertEqual(result.conflictedRequirements[0].requirementId, "REQ-C-001", "the conflict must reference the correct requirement id");

  // Structural errors and duplicates surfaced from the registry loader must
  // also count as a conflict/integrity issue, without this module inventing
  // anything new about them.
  const withStructuralIssues = detectConflicts({
    structuralErrors: [{ id: "REQ-BAD", errors: ["missing title"] }],
    duplicates: [],
    requirements: [],
  });
  assert(withStructuralIssues.hasAnyConflict, "structural errors must count as a registry integrity conflict");

  return { assertions: 5 };
}
