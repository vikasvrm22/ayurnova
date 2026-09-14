import { runWorkflows } from "../../src/workflow-engine/runWorkflows.js";
import { resetFindingCounter } from "../../src/evidence/Finding.js";
import { assert, assertEqual } from "../helpers.js";

export default async function () {
  resetFindingCounter();

  const evidence = {
    server: {
      routes: [{ file: "server/src/routes/fixture.js", line: 1, method: "GET", fullPath: "/api/public/thing", actorType: "public" }],
    },
    schema: {
      tables: ["orders"],
      stateColumns: { "orders.status": { table: "orders", column: "status", values: ["pending", "shipped"] } },
    },
    notifyEvents: { order_placed: [{ file: "server/src/services/x.js", line: 5 }] },
  };

  const statesConfig = { entities: { orders: { table: "orders", column: "status", values: ["pending", "shipped"] } } };

  const workflowsConfig = {
    workflows: [
      {
        id: "wf.confirmed",
        name: "Fully confirmed workflow",
        level: "MICRO",
        steps: [
          { seq: 1, description: "route exists", check: { type: "route", method: "GET", path: "/api/public/thing" } },
          { seq: 2, description: "table exists", check: { type: "table", table: "orders" } },
          { seq: 3, description: "state value allowed", check: { type: "state", entity: "orders", value: "shipped" } },
          { seq: 4, description: "event fires", check: { type: "event", event: "order_placed" } },
        ],
      },
      {
        id: "wf.broken",
        name: "Broken workflow",
        level: "BUSINESS",
        steps: [{ seq: 1, description: "route does not exist", check: { type: "route", method: "POST", path: "/api/public/missing" } }],
      },
      {
        id: "wf.env-limited",
        name: "Environment-limited workflow",
        level: "BUSINESS",
        testStrategy: "NOT_EXECUTED_ENV_LIMITATION",
        existingCoverage: "server/dev-harness/some-script.js",
        steps: [],
      },
    ],
  };

  const { results, findings } = runWorkflows(evidence, workflowsConfig, statesConfig, { rbacFindings: [], featureFlagFindings: [] });

  const confirmed = results.find((r) => r.id === "wf.confirmed");
  assertEqual(confirmed.status, "CONFIRMED", "a workflow where every step's evidence exists is CONFIRMED");
  assertEqual(confirmed.passedSteps, 4, "all 4 steps passed");

  const broken = results.find((r) => r.id === "wf.broken");
  assertEqual(broken.status, "BROKEN", "a workflow where every step fails is BROKEN");
  assert(findings.some((f) => f.workflow === "wf.broken"), "a failed workflow step produces a finding");

  const envLimited = results.find((r) => r.id === "wf.env-limited");
  assertEqual(envLimited.status, "NOT_EXECUTED", "a workflow marked NOT_EXECUTED_ENV_LIMITATION is reported as such, never silently PASS");
  assert(envLimited.existingCoverage.includes("dev-harness"), "existing dev-harness coverage is surfaced instead of re-simulating");

  return { workflowsRun: results.length };
}
