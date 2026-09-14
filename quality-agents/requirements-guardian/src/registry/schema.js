// Structural contract for one requirement record (spec section 6/7) and the
// enums the rest of the Guardian relies on. This file only validates SHAPE -
// it never decides whether a requirement is true, active, or satisfied;
// that is the registry data's own content and the compliance engine's job.

export const SOURCE_TYPES = [
  "PRODUCT_REQUIREMENT",
  "BUSINESS_RULE",
  "DOMAIN_RULE",
  "APPROVED_DECISION",
  "API_CONTRACT",
  "DATA_CONTRACT",
  "STATE_RULE",
  "FEATURE_FLAG_RULE",
  "SECURITY_REQUIREMENT",
  "UX_BEHAVIOR_REQUIREMENT",
  "FUTURE_FEATURE",
  "DEPRECATED_REQUIREMENT",
  "HISTORICAL_REFERENCE",
  "UNKNOWN",
];

export const LIFECYCLE_STATUSES = ["ACTIVE", "DEPRECATED", "FUTURE", "HISTORICAL", "CONFLICTED", "NEEDS_REVIEW"];

export const COMPLIANCE_STATUSES = [
  "IMPLEMENTED",
  "PARTIALLY_IMPLEMENTED",
  "NOT_IMPLEMENTED",
  "ACCIDENTALLY_CHANGED",
  "CONFLICTING",
  "AFFECTED",
  "UNAPPROVED",
  "NEEDS_REVIEW",
  "NOT_APPLICABLE",
];

export const PRIORITIES = ["P0", "P1", "P2", "P3"];

const ID_PATTERN = /^REQ-[A-Z0-9]+(-[A-Z0-9]+)*-\d{3}$/;

/** Validates one requirement record's shape. Returns { valid, errors }.
 * Never mutates, never invents missing fields. */
export function validateRequirement(req) {
  const errors = [];
  if (!req || typeof req !== "object") return { valid: false, errors: ["record is not an object"] };

  if (!ID_PATTERN.test(req.id || "")) errors.push(`id "${req.id}" does not match REQ-<AREA>-<NNN>`);
  if (!req.title) errors.push("missing title");
  if (!SOURCE_TYPES.includes(req.category)) errors.push(`category "${req.category}" is not a recognized source type`);
  if (!LIFECYCLE_STATUSES.includes(req.lifecycle)) errors.push(`lifecycle "${req.lifecycle}" is not recognized`);
  if (!req.requirement) errors.push("missing requirement text");
  if (!req.sourceReference || !req.sourceReference.file) errors.push("missing sourceReference.file (evidence citation)");
  if (!Array.isArray(req.scope) || req.scope.length === 0) errors.push("missing scope[] (affected area tags)");
  if (req.priority && !PRIORITIES.includes(req.priority)) errors.push(`priority "${req.priority}" is not P0-P3`);

  return { valid: errors.length === 0, errors };
}

/** Deterministic duplicate detection: same id twice, or same
 * (sourceReference.file + sourceReference.line + requirement text) claimed
 * by two different ids - both indicate an authoring mistake in the seed
 * data, not a real second requirement. */
export function findDuplicates(requirements) {
  const byId = new Map();
  const byEvidence = new Map();
  const duplicates = [];

  for (const req of requirements) {
    if (byId.has(req.id)) {
      duplicates.push({ type: "DUPLICATE_ID", id: req.id });
    } else {
      byId.set(req.id, req);
    }
    const evidenceKey = `${req.sourceReference?.file}:${req.sourceReference?.line || ""}:${req.requirement}`;
    if (byEvidence.has(evidenceKey) && byEvidence.get(evidenceKey) !== req.id) {
      duplicates.push({ type: "DUPLICATE_EVIDENCE", ids: [byEvidence.get(evidenceKey), req.id] });
    } else {
      byEvidence.set(evidenceKey, req.id);
    }
  }
  return duplicates;
}
