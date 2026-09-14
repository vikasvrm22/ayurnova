#!/usr/bin/env node
import { runScan, runAudit, runImpact, runRegression, runFixPlan } from "../src/runGuardian.js";

function printHelp() {
  console.log(`AyurNova Requirements Guardian

Usage:
  npm run requirements                          Full audit (default: same as "audit")
  npm run requirements -- scan                  List the requirement registry only (no compliance run)
  npm run requirements -- audit                 Full compliance audit + report
  npm run requirements -- audit --baseline      Audit, then save this run as the regression baseline
  npm run requirements -- impact                Change-impact analysis (uncommitted changes vs HEAD)
  npm run requirements -- impact --base <ref>   Change-impact analysis vs a specific ref/commit
  npm run requirements -- regression            Audit + compare against saved baseline (no new baseline write)
  npm run requirements -- report                Re-render the report from the current audit pass
  npm run requirements -- fixplan               Emit a Fix Plan (audit-only - never modifies application code)
  npm run requirements -- --scope <tag>          Scope any mode to one requirement scope tag (e.g. cod, orders, legal)

Reports are written to quality-agents/requirements-guardian/reports/ as timestamped
JSON+Markdown pairs, plus *.latest.json / *.latest.md. Baseline lives at
reports/baseline/baseline.json. See docs/REQUIREMENTS-GUARDIAN.md for the full model.
`);
}

function parseArgs(argv) {
  const args = { mode: "audit", saveAsBaseline: false, base: "HEAD", scope: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else if (a === "--baseline") args.saveAsBaseline = true;
    else if (a === "--base") args.base = argv[++i];
    else if (a === "--scope") args.scope = argv[++i];
    else positional.push(a);
  }
  if (positional.length) args.mode = positional[0];
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.mode === "scan") {
  const { registry } = runScan({ scope: args.scope });
  console.log(`Requirements Guardian - registry scan`);
  console.log(`Declared: ${registry.totalDeclared}, valid: ${registry.requirements.length}, structural errors: ${registry.structuralErrors.length}, duplicates: ${registry.duplicates.length}`);
  for (const r of registry.requirements) {
    console.log(`  [${r.lifecycle}] ${r.id} (${r.category}, ${r.priority || "-"}) - ${r.title}`);
  }
  if (registry.structuralErrors.length) {
    console.log(`\nStructural errors:`);
    for (const e of registry.structuralErrors) console.log(`  ${e.id}: ${e.errors.join("; ")}`);
  }
  process.exit(registry.structuralErrors.length > 0 ? 1 : 0);
}

if (args.mode === "impact") {
  const result = runImpact({ base: args.base, scope: args.scope });
  if (result.error) {
    console.error(`Requirements Guardian - impact analysis failed: ${result.error}`);
    process.exit(1);
  }
  const { model, paths } = result;
  console.log(`Requirements Guardian - change impact analysis`);
  console.log(`Changed files: ${model.impact.changedFiles.length}`);
  console.log(`Affected requirements: ${model.impact.affected.length} (DIRECT=${model.impact.counts.DIRECT}, INDIRECT=${model.impact.counts.INDIRECT}, POSSIBLE=${model.impact.counts.POSSIBLE})`);
  for (const a of model.impact.affected) console.log(`  [${a.confidence}] ${a.requirementId} - ${a.reason}`);
  console.log(`Report: ${paths.mdPath}`);
  process.exit(0);
}

if (args.mode === "fixplan") {
  const { fixPlan, fixPlanPath } = runFixPlan({ scope: args.scope });
  console.log(`Requirements Guardian - fix plan (${fixPlan.length} actionable finding(s), AUDIT ONLY - nothing applied)`);
  for (const f of fixPlan) console.log(`  [${f.findingId}] ${f.requirementId} - ${f.problem} (risk: ${f.risk})`);
  console.log(`Fix plan: ${fixPlanPath}`);
  process.exit(0);
}

const runner = args.mode === "regression" ? runRegression : () => runAudit({ scope: args.scope, saveAsBaseline: args.saveAsBaseline });
const { model, paths } = runner();

console.log(`Requirements Guardian audit complete.`);
console.log(`Decision: ${model.decision}`);
console.log(`Requirement coverage: ${model.coveragePercent}% (${model.registry.totalValid} requirements)`);
console.log(`Severity counts: P0=${model.severityCounts.P0} P1=${model.severityCounts.P1} P2=${model.severityCounts.P2} P3=${model.severityCounts.P3}`);
if (model.regression.hasBaseline) {
  console.log(`Regression vs baseline (${model.regression.baselineDate}): ${model.regression.regressions.length} new, ${model.regression.resolved.length} resolved, ${model.regression.escalated.length} escalated`);
}
console.log(`Report: ${paths.mdPath}`);
console.log(`Report (JSON): ${paths.jsonPath}`);

process.exitCode = model.decision === "BLOCKED" ? 1 : 0;
