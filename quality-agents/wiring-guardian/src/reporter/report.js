import fs from "fs";
import path from "path";
import { sortFindings, countBySeverity, categoryHealth, overallHealth } from "../severity/classify.js";

function ts() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

const CATEGORY_TO_BUCKET = {
  "module-graph": "Module",
  contract: "Contract",
  state: "State",
  rbac: "Security",
  "rbac-consistency": "Security",
  "feature-flag": "FeatureFlag",
  cache: "Cache",
  integration: "Integration",
  workflow: "Workflow",
};
const BUCKET_ORDER = ["Module", "Contract", "State", "Security", "FeatureFlag", "Cache", "Integration", "Workflow"];

export function buildReportModel(audit) {
  const { evidence, contracts, moduleGraph, workflows, findings, regression } = audit;

  // Category health is derived from the FINAL (already filtered/fix-planned)
  // findings list, not each engine's raw output - so a --workflow/--module
  // scoped run reports a score for the scope actually shown, not the whole repo.
  const byCategory = Object.fromEntries(BUCKET_ORDER.map((b) => [b, []]));
  for (const f of findings) {
    const bucket = CATEGORY_TO_BUCKET[f.category] || "Module";
    byCategory[bucket].push(f);
  }
  const categoryScores = Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, categoryHealth(v)]));
  const overall = overallHealth(categoryScores);

  const workflowsByLevel = {};
  for (const w of workflows.results) {
    workflowsByLevel[w.level] = workflowsByLevel[w.level] || [];
    workflowsByLevel[w.level].push(w);
  }

  return {
    generatedAt: new Date().toISOString(),
    discoveredAt: evidence.discoveredAt,
    scope: {
      note: "Initial baseline scope is Phase 1-2 (foundation + payments), but discovery and checks ran against the FULL repository - Wiring Guardian is phase-independent by design (see docs/WIRING-GUARDIAN.md).",
      routeFilesDiscovered: evidence.server.routes.length,
      frontendCallsDiscovered: evidence.frontend.calls.length,
      tablesDiscovered: evidence.schema.tables.length,
    },
    overallHealth: overall,
    categoryHealth: categoryScores,
    severityCounts: countBySeverity(findings),
    workflowsByLevel,
    findings: sortFindings(findings),
    regression,
    moduleGraph: { nodeCount: moduleGraph.nodes.length, edgeCount: moduleGraph.edges.length, nodes: moduleGraph.nodes, edges: moduleGraph.edges },
    contractSummary: { totalRoutes: contracts.totalRoutes, totalCalls: contracts.totalCalls },
  };
}

export function writeReports(reportsRoot, model, { label = "wiring-guardian" } = {}) {
  fs.mkdirSync(reportsRoot, { recursive: true });
  const stamp = ts();
  const jsonPath = path.join(reportsRoot, `${label}__${stamp}.json`);
  const mdPath = path.join(reportsRoot, `${label}__${stamp}.md`);
  const latestJsonPath = path.join(reportsRoot, `${label}.latest.json`);
  const latestMdPath = path.join(reportsRoot, `${label}.latest.md`);

  fs.writeFileSync(jsonPath, JSON.stringify(model, null, 2), "utf8");
  fs.writeFileSync(latestJsonPath, JSON.stringify(model, null, 2), "utf8");
  const md = renderMarkdown(model);
  fs.writeFileSync(mdPath, md, "utf8");
  fs.writeFileSync(latestMdPath, md, "utf8");

  return { jsonPath, mdPath, latestJsonPath, latestMdPath };
}

function renderMarkdown(model) {
  const lines = [];
  lines.push(`# AyurNova Wiring Guardian Report`);
  lines.push(``);
  lines.push(`Generated: ${model.generatedAt}`);
  lines.push(``);
  lines.push(`## 1. Executive Summary`);
  lines.push(``);
  lines.push(`- Overall Wiring Health: **${model.overallHealth.score}/100** (${model.overallHealth.formula})`);
  lines.push(`- Any category with a P0 finding: **${model.overallHealth.anyCritical ? "YES" : "no"}**`);
  lines.push(`- Severity counts: P0=${model.severityCounts.P0}, P1=${model.severityCounts.P1}, P2=${model.severityCounts.P2}, P3=${model.severityCounts.P3}`);
  lines.push(`- Backend routes discovered: ${model.scope.routeFilesDiscovered}; frontend calls discovered: ${model.scope.frontendCallsDiscovered}; DB tables discovered: ${model.scope.tablesDiscovered}`);
  lines.push(``);
  lines.push(`> ${model.scope.note}`);
  lines.push(``);

  lines.push(`## 2. Category Wiring Health`);
  lines.push(``);
  lines.push(`| Category | Score | P0 | P1 | P2 | P3 |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const [name, h] of Object.entries(model.categoryHealth)) {
    lines.push(`| ${name} | ${h.score}/100 | ${h.counts.P0} | ${h.counts.P1} | ${h.counts.P2} | ${h.counts.P3} |`);
  }
  lines.push(``);

  lines.push(`## 3. Workflow Coverage by Level`);
  lines.push(``);
  for (const level of ["MICRO", "FEATURE", "BUSINESS", "CROSS_MODULE", "FULL_LIFECYCLE"]) {
    const wfs = model.workflowsByLevel[level] || [];
    if (!wfs.length) continue;
    lines.push(`### ${level}`);
    lines.push(``);
    lines.push(`| Workflow | Status | Steps passed |`);
    lines.push(`|---|---|---|`);
    for (const w of wfs) {
      const stepsSummary = w.status === "NOT_EXECUTED" ? "-" : `${w.passedSteps}/${w.totalSteps}`;
      lines.push(`| ${w.name} (${w.id}) | ${w.status} | ${stepsSummary} |`);
      if (w.status === "NOT_EXECUTED") lines.push(`|   -> ${w.reason}${w.existingCoverage ? ` Existing coverage: ${w.existingCoverage}` : ""} | | |`);
    }
    lines.push(``);
  }

  lines.push(`## 4. Module Graph`);
  lines.push(``);
  lines.push(`${model.moduleGraph.nodeCount} modules discovered, ${model.moduleGraph.edgeCount} structural (FK-based) edges.`);
  lines.push(``);

  lines.push(`## 5. Findings (most severe first)`);
  lines.push(``);
  for (const f of model.findings) {
    lines.push(`### [${f.severity}] ${f.id} - ${f.category} (${f.layer})`);
    lines.push(``);
    if (f.workflow) lines.push(`- Workflow: \`${f.workflow}\``);
    if (f.route) lines.push(`- Route: \`${f.route}\``);
    lines.push(`- File: \`${f.file}${f.line ? `:${f.line}` : ""}\``);
    lines.push(`- Observed: ${f.observed}`);
    lines.push(`- Expected: ${f.expected}`);
    lines.push(`- Evidence: ${f.evidence}`);
    lines.push(`- Confidence: ${f.confidence}`);
    lines.push(`- Fix policy: ${f.fixPolicy || "n/a"}`);
    if (f.recommendedFix) lines.push(`- Recommended fix: ${f.recommendedFix}`);
    lines.push(`- Auto-fixed: ${f.autoFixed ? "yes" : "no"}${f.verification ? ` (${f.verification})` : ""}`);
    lines.push(``);
  }

  lines.push(`## 6. Regression vs Baseline`);
  lines.push(``);
  if (!model.regression.hasBaseline) {
    lines.push(`No prior baseline found - this run establishes the baseline.`);
  } else {
    lines.push(`Baseline from: ${model.regression.baselineDate}`);
    lines.push(`- New findings since baseline: ${model.regression.regressions.length}`);
    lines.push(`- Findings resolved since baseline: ${model.regression.resolved.length}`);
    lines.push(`- Unchanged: ${model.regression.unchangedCount}`);
  }
  lines.push(``);

  return lines.join("\n");
}
