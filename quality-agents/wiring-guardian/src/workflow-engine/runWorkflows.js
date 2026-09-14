import { pathsMatch } from "../contract-engine/matchPath.js";
import { makeFinding } from "../evidence/Finding.js";

const STEP_STATUS = { PASS: "PASS", FAIL: "FAIL", NOT_EXECUTED: "NOT_EXECUTED" };

function checkRoute(evidence, step) {
  const matches = evidence.server.routes.filter((r) => r.method === step.check.method && pathsMatch(r.fullPath, step.check.path));
  if (matches.length === 0) {
    return { status: STEP_STATUS.FAIL, detail: `No route matches ${step.check.method} ${step.check.path}.` };
  }
  if (step.check.expectActor && !matches.some((r) => r.actorType === step.check.expectActor)) {
    return {
      status: STEP_STATUS.FAIL,
      detail: `Route ${step.check.method} ${step.check.path} exists but none of the matches classify as actor '${step.check.expectActor}' (found: ${matches.map((m) => m.actorType).join(", ")}).`,
    };
  }
  return { status: STEP_STATUS.PASS, detail: `${matches.length} matching route(s), e.g. ${matches[0].file}:${matches[0].line}.` };
}

function checkTable(evidence, step) {
  if (evidence.schema.tables.includes(step.check.table)) {
    return { status: STEP_STATUS.PASS, detail: `Table '${step.check.table}' exists in the live schema.` };
  }
  return { status: STEP_STATUS.FAIL, detail: `Table '${step.check.table}' was not found in supabase/schema.sql or migrations.` };
}

function checkState(evidence, step, statesConfig) {
  const entity = statesConfig.entities[step.check.entity];
  if (!entity) return { status: STEP_STATUS.FAIL, detail: `states.config.json has no entity '${step.check.entity}'.` };
  if (!entity.values.includes(step.check.value)) {
    return { status: STEP_STATUS.FAIL, detail: `states.config.json entity '${step.check.entity}' does not list value '${step.check.value}'.` };
  }
  const key = `${entity.table}.${entity.column}`;
  const live = evidence.schema.stateColumns[key];
  if (!live || !live.values.includes(step.check.value)) {
    return { status: STEP_STATUS.FAIL, detail: `Live schema for ${key} does not currently allow '${step.check.value}'.` };
  }
  return { status: STEP_STATUS.PASS, detail: `${key} allows '${step.check.value}' (confirmed live).` };
}

function checkEvent(evidence, step) {
  if (evidence.notifyEvents[step.check.event]) {
    const sites = evidence.notifyEvents[step.check.event];
    return { status: STEP_STATUS.PASS, detail: `notify('${step.check.event}') found at ${sites.map((s) => `${s.file}:${s.line}`).join(", ")}.` };
  }
  return { status: STEP_STATUS.FAIL, detail: `No notify('${step.check.event}') call site found under server/src/services, server/src/notify, or server/src/routes.` };
}

function checkFeatureFlag(featureFlagFindings, step) {
  const relevant = featureFlagFindings.filter((f) => f.severity === "P0");
  if (relevant.length > 0) {
    return { status: STEP_STATUS.FAIL, detail: `Feature-flag engine raised P0 finding(s): ${relevant.map((f) => f.id).join(", ")}.` };
  }
  return { status: STEP_STATUS.PASS, detail: `Feature-flag engine raised no P0 enforcement gap for '${step.check.flag}'.` };
}

function checkRbacSweep(rbacFindings, step) {
  const byScope = {
    "admin-auth": rbacFindings.filter((f) => f.category === "rbac" && f.severity === "P0" && f.route?.includes("admin")),
    "admin-permission": rbacFindings.filter((f) => f.category === "rbac" && f.severity === "P1"),
    "customer-auth": rbacFindings.filter((f) => f.category === "rbac" && f.severity === "P0" && !f.route?.includes("admin")),
  };
  const hits = byScope[step.check.scope] || [];
  if (hits.length > 0) {
    return { status: STEP_STATUS.FAIL, detail: `${hits.length} finding(s) in scope '${step.check.scope}': ${hits.map((f) => f.id).join(", ")}.` };
  }
  return { status: STEP_STATUS.PASS, detail: `No RBAC findings in scope '${step.check.scope}'.` };
}

function evaluateStep(evidence, step, ctx) {
  switch (step.check.type) {
    case "route":
      return checkRoute(evidence, step);
    case "table":
      return checkTable(evidence, step);
    case "state":
      return checkState(evidence, step, ctx.statesConfig);
    case "event":
      return checkEvent(evidence, step);
    case "featureFlag":
      return checkFeatureFlag(ctx.featureFlagFindings, step);
    case "rbacSweep":
      return checkRbacSweep(ctx.rbacFindings, step);
    default:
      return { status: STEP_STATUS.NOT_EXECUTED, detail: `Unknown check type '${step.check.type}'.` };
  }
}

/** Walks config/workflows.config.json and evaluates every step against the
 * evidence bundle + the other engines' already-computed findings. A
 * workflow with a NOT_EXECUTED_ENV_LIMITATION testStrategy is reported as
 * such (never silently marked PASS) - section 28. */
export function runWorkflows(evidence, workflowsConfig, statesConfig, { rbacFindings, featureFlagFindings }) {
  const ctx = { statesConfig, rbacFindings, featureFlagFindings };
  const findings = [];
  const results = [];

  for (const wf of workflowsConfig.workflows) {
    if (wf.testStrategy === "NOT_EXECUTED_ENV_LIMITATION") {
      results.push({
        id: wf.id,
        name: wf.name,
        level: wf.level,
        status: "NOT_EXECUTED",
        reason: "ENVIRONMENT LIMITATION - requires a live payment sandbox / running server, not safe to simulate in a static audit.",
        existingCoverage: wf.existingCoverage || null,
        steps: [],
      });
      continue;
    }

    const stepResults = wf.steps.map((step) => ({ ...step, result: evaluateStep(evidence, step, ctx) }));
    const failed = stepResults.filter((s) => s.result.status === STEP_STATUS.FAIL);
    const status = failed.length === 0 ? "CONFIRMED" : failed.length === stepResults.length ? "BROKEN" : "PARTIAL";

    for (const s of failed) {
      findings.push(
        makeFinding({
          layer: `workflow:${wf.level}`,
          category: "workflow",
          workflow: wf.id,
          module: null,
          file: "wiring-guardian/config/workflows.config.json",
          route: step_route(s),
          observed: s.result.detail,
          expected: s.description,
          evidence: `Workflow '${wf.id}' step ${s.seq}: ${JSON.stringify(s.check)}.`,
          severity: wf.level === "FULL_LIFECYCLE" || wf.level === "BUSINESS" ? "P1" : "P2",
          confidence: "medium",
          recommendedFix: "Investigate the specific step evidence above; this may be a real gap or a static-analysis limitation (see README limitations).",
        })
      );
    }

    results.push({
      id: wf.id,
      name: wf.name,
      level: wf.level,
      status,
      passedSteps: stepResults.length - failed.length,
      totalSteps: stepResults.length,
      steps: stepResults.map((s) => ({ seq: s.seq, description: s.description, status: s.result.status, detail: s.result.detail })),
    });
  }

  return { results, findings };
}

function step_route(step) {
  return step.check?.type === "route" ? `${step.check.method} ${step.check.path}` : null;
}
