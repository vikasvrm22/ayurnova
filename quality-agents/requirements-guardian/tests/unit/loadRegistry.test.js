import { loadRegistry, requirementsByLifecycle, requirementsByScope } from "../../src/registry/loadRegistry.js";
import { assertEqual, assert } from "../helpers.js";

export default async function run() {
  const registry = loadRegistry();

  // The real curated seed data must itself be structurally clean - this is
  // a regression test on requirements.data.js, not just on the loader.
  assertEqual(registry.structuralErrors.length, 0, `seed registry has structural errors: ${JSON.stringify(registry.structuralErrors)}`);
  assertEqual(registry.duplicates.length, 0, `seed registry has duplicate ids/evidence: ${JSON.stringify(registry.duplicates)}`);
  assert(registry.requirements.length > 0, "registry must not be empty");
  assertEqual(registry.requirements.length, registry.totalDeclared, "every declared requirement should be valid");

  // Every requirement must be reachable by id.
  const sample = registry.requirements[0];
  assertEqual(registry.byId.get(sample.id), sample, "byId lookup must resolve every requirement");

  const futureReqs = requirementsByLifecycle(registry, "FUTURE");
  assert(futureReqs.every((r) => r.lifecycle === "FUTURE"), "requirementsByLifecycle must only return matching lifecycle");
  assert(futureReqs.length > 0, "seed registry should contain at least one FUTURE requirement (deferred-feature protection)");

  const codReqs = requirementsByScope(registry, "cod");
  assert(codReqs.length > 0, "seed registry should contain at least one cod-scoped requirement");
  assert(codReqs.every((r) => r.scope.includes("cod")), "requirementsByScope must only return matching scope tag");

  return { totalRequirements: registry.requirements.length };
}
