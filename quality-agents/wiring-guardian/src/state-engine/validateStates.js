import { makeFinding } from "../evidence/Finding.js";

/** Validates config/states.config.json (curated product knowledge) against
 * the live schema evidence (src/discovery/schemaDiscovery.js). A curated
 * state machine that has drifted from the real CHECK constraints is exactly
 * the kind of silent gap the spec calls out (section 12/26) - this keeps the
 * state engine honest rather than trusting a config file forever. */
export function validateStates(evidence, statesConfig) {
  const findings = [];
  const { stateColumns } = evidence.schema;

  for (const [entityName, entity] of Object.entries(statesConfig.entities)) {
    const key = `${entity.table}.${entity.column}`;
    const discovered = stateColumns[key];
    if (!discovered) {
      findings.push(
        makeFinding({
          layer: "L4-state-engine",
          category: "state",
          file: "wiring-guardian/config/states.config.json",
          route: null,
          module: entityName,
          observed: `No CHECK constraint for ${key} was found in the live schema (supabase/schema.sql + migrations).`,
          expected: `states.config.json declares ${key} with values ${JSON.stringify(entity.values)}.`,
          evidence: `schemaDiscovery found no stateColumns entry for '${key}'.`,
          severity: "P2",
          confidence: "medium",
          recommendedFix: "Confirm the column/table name is still correct, or remove this stale entity from states.config.json.",
        })
      );
      continue;
    }

    const configured = new Set(entity.values);
    const live = new Set(discovered.values);
    const missingFromConfig = [...live].filter((v) => !configured.has(v));
    const missingFromSchema = [...configured].filter((v) => !live.has(v));

    if (missingFromConfig.length) {
      findings.push(
        makeFinding({
          layer: "L4-state-engine",
          category: "state",
          file: discovered.sources[discovered.sources.length - 1]?.file || "supabase/schema.sql",
          module: entityName,
          route: null,
          observed: `Live schema for ${key} allows value(s) ${JSON.stringify(missingFromConfig)} that states.config.json does not know about.`,
          expected: "The curated workflow state machine should cover every value the database actually allows.",
          evidence: `schemaDiscovery: ${key} live values = ${JSON.stringify([...live])}; states.config.json values = ${JSON.stringify([...configured])}.`,
          severity: "P2",
          confidence: "high",
          recommendedFix: `Add ${JSON.stringify(missingFromConfig)} to states.config.json's '${entityName}' entity, and confirm which workflow(s) drive that transition.`,
        })
      );
    }
    if (missingFromSchema.length) {
      findings.push(
        makeFinding({
          layer: "L4-state-engine",
          category: "state",
          file: "wiring-guardian/config/states.config.json",
          module: entityName,
          route: null,
          observed: `states.config.json declares value(s) ${JSON.stringify(missingFromSchema)} for ${key} that the live schema's CHECK constraint no longer allows.`,
          expected: "The curated state machine should not reference values the database would reject.",
          evidence: `schemaDiscovery: ${key} live values = ${JSON.stringify([...live])}; states.config.json values = ${JSON.stringify([...configured])}.`,
          severity: "P3",
          confidence: "high",
          recommendedFix: "Update states.config.json to drop the stale value(s), or confirm a migration removed them intentionally.",
        })
      );
    }
  }

  return { findings };
}
