import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { runDiscovery } from "./discovery/index.js";
import { checkContracts } from "./contract-engine/checkContracts.js";
import { checkRbac } from "./security-engine/checkRbac.js";
import { checkFeatureFlags } from "./feature-flag-engine/checkFeatureFlags.js";
import { checkCache } from "./cache-engine/checkCache.js";
import { checkIntegrations } from "./integration-engine/checkIntegrations.js";
import { validateStates } from "./state-engine/validateStates.js";
import { buildModuleGraph } from "./module-graph/buildModuleGraph.js";
import { runWorkflows } from "./workflow-engine/runWorkflows.js";
import { planFixes } from "./fix-planner/planFixes.js";
import { applySafeFixes } from "./fix-planner/applyFixes.js";
import { loadBaseline, compareToBaseline, saveBaseline } from "./baseline/baseline.js";
import { buildReportModel, writeReports } from "./reporter/report.js";
import { resetFindingCounter } from "./evidence/Finding.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUARDIAN_ROOT = path.join(__dirname, "..");
const REPO_ROOT = path.join(GUARDIAN_ROOT, "..");

function loadJsonConfig(name) {
  return JSON.parse(fs.readFileSync(path.join(GUARDIAN_ROOT, "config", name), "utf8"));
}

/** One full discovery + every-engine pass against the CURRENT state of the
 * repo on disk. Pure read-only - never writes anything. Called twice by
 * runGuardian() when --apply-fixes is set: once to find findings, once more
 * (the "RE-AUDIT" step, section 21) after fixes have been written, so the
 * final report reflects reality rather than a stale pre-fix snapshot. */
function runAuditPass(filters) {
  const modulesConfig = loadJsonConfig("modules.config.json");
  const statesConfig = loadJsonConfig("states.config.json");
  const workflowsConfig = loadJsonConfig("workflows.config.json");

  const evidence = runDiscovery(REPO_ROOT);

  const contracts = checkContracts(evidence);
  const rbac = checkRbac(evidence);
  const featureFlags = checkFeatureFlags(REPO_ROOT);
  const cache = checkCache(REPO_ROOT);
  const integrations = checkIntegrations(REPO_ROOT);
  const states = validateStates(evidence, statesConfig);
  const moduleGraph = buildModuleGraph(evidence, modulesConfig);
  const workflows = runWorkflows(evidence, workflowsConfig, statesConfig, {
    rbacFindings: rbac.findings,
    featureFlagFindings: featureFlags.findings,
  });

  let allFindings = [
    ...contracts.findings,
    ...rbac.findings,
    ...featureFlags.findings,
    ...cache.findings,
    ...integrations.findings,
    ...states.findings,
    ...moduleGraph.findings,
    ...workflows.findings,
  ];
  allFindings = applyFilters(allFindings, filters);
  allFindings = planFixes(allFindings);

  return { evidence, contracts, rbac, featureFlags, cache, integrations, states, moduleGraph, workflows, findings: allFindings };
}

const findingShape = (f) => `${f.layer}|${f.category}|${f.file}|${f.route}|${f.observed}`;

/** AUDIT -> (DIAGNOSE is the engines above) -> FIX IF SAFE -> RE-AUDIT.
 * `filters` narrows which findings are kept (CLI --workflow/--module)
 * without changing what discovery covers (discovery always runs against
 * the full repo - see docs/WIRING-GUARDIAN.md on phase-independence). */
export function runGuardian({ applyFixes = false, saveAsBaseline = false, filters = {} } = {}) {
  resetFindingCounter();

  const pass1 = runAuditPass(filters);
  let appliedFixes = [];
  let finalPass = pass1;
  let resolvedByFix = [];

  if (applyFixes) {
    appliedFixes = applySafeFixes(pass1.findings, REPO_ROOT);
    if (appliedFixes.length > 0) {
      resetFindingCounter();
      const pass2 = runAuditPass(filters);
      const stillPresent = new Set(pass2.findings.map(findingShape));
      // Findings from pass 1 that a fixer touched AND that no longer appear
      // in the fresh re-audit are the confirmed, verified fixes - carry
      // their autoFixed/verification annotations into the final report as
      // resolved findings (section 21: every fix must be re-audited before
      // being reported as done, never just "applied").
      resolvedByFix = pass1.findings.filter((f) => f.autoFixed && !stillPresent.has(findingShape(f)));
      for (const f of resolvedByFix) f.verification = "APPLIED and CONFIRMED RESOLVED by re-audit.";
      const stillPresentAfterFixAttempt = pass1.findings.filter((f) => f.autoFixed && stillPresent.has(findingShape(f)));
      for (const f of stillPresentAfterFixAttempt) f.verification = "Fix was applied but the finding still reproduces on re-audit - needs manual review.";
      finalPass = pass2;
    }
  }

  const finalFindings = [...finalPass.findings, ...resolvedByFix];

  const reportsRoot = path.join(GUARDIAN_ROOT, "reports");
  const baseline = loadBaseline(reportsRoot);
  const regression = compareToBaseline(baseline, finalFindings);

  const model = buildReportModel({ ...finalPass, findings: finalFindings, regression });
  const paths = writeReports(reportsRoot, model);

  if (saveAsBaseline) {
    saveBaseline(reportsRoot, { auditedAt: model.generatedAt, findings: finalFindings });
  }

  return { model, paths, appliedFixes, evidence: finalPass.evidence };
}

function applyFilters(findings, filters) {
  let out = findings;
  if (filters.workflow) out = out.filter((f) => f.workflow === filters.workflow);
  if (filters.module) out = out.filter((f) => f.module === filters.module || (f.file || "").includes(filters.module));
  return out;
}

export { REPO_ROOT, GUARDIAN_ROOT };
