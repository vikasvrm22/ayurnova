import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { loadRegistry, requirementsByScope } from "./registry/loadRegistry.js";
import { runCompliance } from "./compliance/runCompliance.js";
import { detectConflicts } from "./conflict/detectConflicts.js";
import { getChangedFiles, analyzeImpact } from "./impact/changeImpact.js";
import { planFixes, buildFixPlan } from "./fix-planner/planFixes.js";
import { loadBaseline, saveBaseline, compareToBaseline } from "./baseline/baseline.js";
import { buildReportModel, writeReports } from "./reporter/report.js";
import { resetFindingCounter } from "./evidence/Finding.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUARDIAN_ROOT = path.join(__dirname, "..");
const REPO_ROOT = path.join(GUARDIAN_ROOT, "..", "..");

function repoInfo() {
  const run = (cmd) => {
    try {
      return execSync(cmd, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  };
  return { branch: run("git rev-parse --abbrev-ref HEAD"), commit: run("git rev-parse --short HEAD") };
}

function applyScopeFilter(registry, scopeTag) {
  if (!scopeTag) return registry;
  return { ...registry, requirements: requirementsByScope(registry, scopeTag) };
}

/** One full audit pass: load registry, run compliance, detect conflicts,
 * plan (never apply) fixes. Pure read-only against the repo. */
function runAuditPass({ scope } = {}) {
  resetFindingCounter();
  const registry = applyScopeFilter(loadRegistry(), scope);
  const conflicts = detectConflicts(registry);
  const { verifications, findings } = runCompliance(registry, REPO_ROOT);
  const plannedFindings = planFixes(findings);
  return { registry, conflicts, verifications, findings: plannedFindings };
}

export function runScan({ scope } = {}) {
  const { registry } = runAuditPass({ scope });
  return { registry };
}

export function runAudit({ scope, saveAsBaseline = false } = {}) {
  const { registry, conflicts, verifications, findings } = runAuditPass({ scope });

  const reportsRoot = path.join(GUARDIAN_ROOT, "reports");
  const baseline = loadBaseline(reportsRoot);
  const regression = compareToBaseline(baseline, verifications);

  const model = buildReportModel({ registry, verifications, findings, conflicts, impact: null, regression, repoInfo: repoInfo() });
  const paths = writeReports(reportsRoot, model);

  if (saveAsBaseline) {
    saveBaseline(reportsRoot, { auditedAt: model.generatedAt, verifications });
  }

  return { model, paths };
}

export function runImpact({ base = "HEAD", scope } = {}) {
  const { registry, conflicts, verifications, findings } = runAuditPass({ scope });
  const changed = getChangedFiles(REPO_ROOT, { base });
  if (changed?.error) return { error: changed.error };
  const impact = analyzeImpact(registry, changed);

  const reportsRoot = path.join(GUARDIAN_ROOT, "reports");
  const baseline = loadBaseline(reportsRoot);
  const regression = compareToBaseline(baseline, verifications);
  const model = buildReportModel({ registry, verifications, findings, conflicts, impact, regression, repoInfo: repoInfo() });
  const paths = writeReports(reportsRoot, model, { label: "requirements-guardian-impact" });
  return { model, paths };
}

export function runRegression() {
  const { registry, conflicts, verifications, findings } = runAuditPass({});
  const reportsRoot = path.join(GUARDIAN_ROOT, "reports");
  const baseline = loadBaseline(reportsRoot);
  const regression = compareToBaseline(baseline, verifications);
  const model = buildReportModel({ registry, verifications, findings, conflicts, impact: null, regression, repoInfo: repoInfo() });
  const paths = writeReports(reportsRoot, model);
  return { model, paths };
}

export function runFixPlan({ scope } = {}) {
  const { findings } = runAuditPass({ scope });
  const fixPlan = buildFixPlan(findings.filter((f) => f.compliance !== "NEEDS_REVIEW" && f.compliance !== "NOT_APPLICABLE"));
  const reportsRoot = path.join(GUARDIAN_ROOT, "reports");
  fs.mkdirSync(reportsRoot, { recursive: true });
  const fixPlanPath = path.join(reportsRoot, "requirements-guardian-fixplan.latest.json");
  fs.writeFileSync(fixPlanPath, JSON.stringify({ generatedAt: new Date().toISOString(), fixPlan }, null, 2), "utf8");
  return { fixPlan, fixPlanPath };
}

export { REPO_ROOT, GUARDIAN_ROOT };
