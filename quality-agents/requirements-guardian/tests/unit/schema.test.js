import { validateRequirement, findDuplicates, SOURCE_TYPES, LIFECYCLE_STATUSES } from "../../src/registry/schema.js";
import { assert, assertEqual } from "../helpers.js";

function baseReq(overrides = {}) {
  return {
    id: "REQ-TEST-001",
    title: "Test requirement",
    category: "BUSINESS_RULE",
    lifecycle: "ACTIVE",
    requirement: "Something must be true.",
    sourceReference: { file: "docs/example.md", line: 1 },
    scope: ["test"],
    ...overrides,
  };
}

export default async function run() {
  // Valid record passes.
  let { valid, errors } = validateRequirement(baseReq());
  assert(valid, `expected a well-formed record to validate, got errors: ${errors}`);

  // Multi-segment area names (REQ-PAYMENT-RETRY-001 style) must be accepted.
  ({ valid } = validateRequirement(baseReq({ id: "REQ-PAYMENT-RETRY-001" })));
  assert(valid, "multi-segment area id should be valid");

  // Malformed id is rejected.
  ({ valid, errors } = validateRequirement(baseReq({ id: "not-an-id" })));
  assert(!valid && errors.some((e) => e.includes("id")), "malformed id should be rejected");

  // Unknown category is rejected.
  ({ valid, errors } = validateRequirement(baseReq({ category: "MADE_UP_TYPE" })));
  assert(!valid && errors.some((e) => e.includes("category")), "unknown category should be rejected");

  // Unknown lifecycle is rejected.
  ({ valid, errors } = validateRequirement(baseReq({ lifecycle: "SOMEDAY" })));
  assert(!valid && errors.some((e) => e.includes("lifecycle")), "unknown lifecycle should be rejected");

  // Missing sourceReference is rejected (never invent evidence).
  ({ valid, errors } = validateRequirement(baseReq({ sourceReference: null })));
  assert(!valid && errors.some((e) => e.includes("sourceReference")), "missing sourceReference should be rejected");

  // Missing scope is rejected.
  ({ valid, errors } = validateRequirement(baseReq({ scope: [] })));
  assert(!valid && errors.some((e) => e.includes("scope")), "empty scope should be rejected");

  // Duplicate id detection.
  const dupIds = findDuplicates([baseReq(), baseReq()]);
  assert(dupIds.some((d) => d.type === "DUPLICATE_ID"), "duplicate id should be detected");

  // Duplicate evidence claimed by two different ids.
  const dupEvidence = findDuplicates([
    baseReq({ id: "REQ-TEST-001" }),
    baseReq({ id: "REQ-TEST-002" }), // same sourceReference + requirement text
  ]);
  assert(dupEvidence.some((d) => d.type === "DUPLICATE_EVIDENCE"), "duplicate evidence across two ids should be detected");

  // No false positives on genuinely distinct records.
  const noDups = findDuplicates([
    baseReq({ id: "REQ-TEST-001", requirement: "A" }),
    baseReq({ id: "REQ-TEST-002", requirement: "B", sourceReference: { file: "docs/other.md", line: 2 } }),
  ]);
  assertEqual(noDups.length, 0, "distinct records must not be flagged as duplicates");

  assert(SOURCE_TYPES.includes("FUTURE_FEATURE"), "FUTURE_FEATURE must be a recognized source type");
  assert(LIFECYCLE_STATUSES.includes("CONFLICTED"), "CONFLICTED must be a recognized lifecycle");

  return { assertions: 11 };
}
