import { analyzeImpact, REQUIREMENT_DIRECT_FILES } from "../../src/impact/changeImpact.js";
import { assertEqual, assert } from "../helpers.js";

export default async function run() {
  const registry = {
    requirements: [
      { id: "REQ-COD-001", title: "cod", category: "BUSINESS_RULE", scope: ["cod", "checkout"], sourceReference: { file: "docs/x.md" } },
      { id: "REQ-ORDERS-STATE-001", title: "orders", category: "STATE_RULE", scope: ["orders", "state"], sourceReference: { file: "docs/y.md" } },
      { id: "REQ-UNRELATED-001", title: "unrelated", category: "BUSINESS_RULE", scope: ["wellness"], sourceReference: { file: "docs/z.md" } },
      { id: "REQ-FAKE-STATE-001", title: "fake state rule", category: "STATE_RULE", scope: ["unmatched-tag"], sourceReference: { file: "docs/w.md" } },
    ],
  };

  // DIRECT: exact match against the maintained REQUIREMENT_DIRECT_FILES map.
  assert(REQUIREMENT_DIRECT_FILES["REQ-COD-001"].includes("server/src/routes/public.js"), "map fixture assumption holds");
  const directResult = analyzeImpact(registry, ["server/src/routes/public.js"]);
  const codEntry = directResult.affected.find((a) => a.requirementId === "REQ-COD-001");
  assertEqual(codEntry.confidence, "DIRECT", "a file in the requirement's known checker target list must be DIRECT");

  // INDIRECT: scope-tag word match, not a raw substring match.
  const indirectResult = analyzeImpact(registry, ["server/src/routes/orders.js"]);
  const ordersEntry = indirectResult.affected.find((a) => a.requirementId === "REQ-ORDERS-STATE-001");
  assertEqual(ordersEntry.confidence, "INDIRECT", "a scope-tag path match must be INDIRECT");

  // Word-boundary regression guard: "cod" must not match "codeDiscovery.js".
  const falsePositiveResult = analyzeImpact(registry, ["quality-agents/requirements-guardian/src/discovery/codeDiscovery.js"]);
  const codFalseMatch = falsePositiveResult.affected.find((a) => a.requirementId === "REQ-COD-001");
  assertEqual(codFalseMatch, undefined, "'cod' scope tag must not substring-match inside 'codeDiscovery.js'");

  // POSSIBLE: a schema change touches every STATE_RULE/DATA_CONTRACT category
  // requirement even without a direct/scope match.
  const schemaResult = analyzeImpact(registry, ["supabase/migrations/9999_unrelated.sql"]);
  const possibleEntry = schemaResult.affected.find((a) => a.requirementId === "REQ-FAKE-STATE-001");
  assert(possibleEntry, "a schema change should surface a POSSIBLE link to an unrelated STATE_RULE requirement");
  assertEqual(possibleEntry.confidence, "POSSIBLE", "a category-only match (no direct/scope evidence) must be POSSIBLE, not a stronger confidence");

  // Unrelated requirement must never be reported for an unrelated file.
  const unrelatedResult = analyzeImpact(registry, ["server/src/routes/orders.js"]);
  assert(!unrelatedResult.affected.some((a) => a.requirementId === "REQ-UNRELATED-001"), "an unrelated requirement must not be reported as impacted");

  assertEqual(directResult.counts.DIRECT, 1, "counts.DIRECT must reflect the direct match");

  return { assertions: 6 };
}
