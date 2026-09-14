/** Surfaces every reason the registry itself is not internally clean:
 * structural authoring errors, duplicate ids/evidence, and any requirement
 * explicitly marked CONFLICTED (spec section 4: "if authoritative sources
 * conflict, do not choose one - report NEEDS_REVIEW with both sides").
 * This module never resolves a conflict itself - it only collects and
 * reports them. */
export function detectConflicts(registry) {
  const conflictedRequirements = registry.requirements
    .filter((r) => r.lifecycle === "CONFLICTED")
    .map((r) => ({
      requirementId: r.id,
      title: r.title,
      reason: "Lifecycle explicitly marked CONFLICTED in the registry - authoritative sources disagree.",
      sourceReference: r.sourceReference,
    }));

  return {
    structuralErrors: registry.structuralErrors,
    duplicates: registry.duplicates,
    conflictedRequirements,
    hasAnyConflict: registry.structuralErrors.length > 0 || registry.duplicates.length > 0 || conflictedRequirements.length > 0,
  };
}
