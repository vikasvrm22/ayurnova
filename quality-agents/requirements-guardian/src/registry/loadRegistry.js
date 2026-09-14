import { REQUIREMENTS } from "./requirements.data.js";
import { validateRequirement, findDuplicates } from "./schema.js";

/** Loads the curated requirement registry, validating structure and
 * deterministic-id/duplicate rules (spec section 7). A requirement that
 * fails structural validation is dropped from the active set and reported
 * as a registry error - it is never silently included half-formed. */
export function loadRegistry() {
  const structuralErrors = [];
  const valid = [];

  for (const req of REQUIREMENTS) {
    const { valid: ok, errors } = validateRequirement(req);
    if (ok) valid.push(req);
    else structuralErrors.push({ id: req?.id || "UNKNOWN", errors });
  }

  const duplicates = findDuplicates(valid);

  return {
    requirements: valid,
    totalDeclared: REQUIREMENTS.length,
    structuralErrors,
    duplicates,
    byId: new Map(valid.map((r) => [r.id, r])),
  };
}

export function requirementsByLifecycle(registry, lifecycle) {
  return registry.requirements.filter((r) => r.lifecycle === lifecycle);
}

export function requirementsByScope(registry, scopeTag) {
  return registry.requirements.filter((r) => (r.scope || []).includes(scopeTag));
}
