import fs from "fs";
import path from "path";
import { sortFindings, countBySeverity } from "../severity/classify.js";

function ts() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

const VIOLATION_COMPLIANCES = new Set(["NOT_IMPLEMENTED", "PARTIALLY_IMPLEMENTED", "ACCIDENTALLY_CHANGED", "CONFLICTING", "UNAPPROVED"]);

/** Transparent, evidence-based decision (spec section 28/35 - never a fake
 * PASS). BLOCKED requires a confirmed (non-LOW-confidence) P0 violation.
 * NEEDS REVIEW fires when open NEEDS_REVIEW items exist at P0/P1 with no
 * confirmed P0 violation - ambiguity is reported as ambiguity, never
 * silently resolved into a PASS. */
function decide(findings) {
  const confirmedP0Violation = findings.some((f) => f.severity === "P0" && VIOLATION_COMPLIANCES.has(f.compliance) && f.confidence !== "LOW");
  if (confirmedP0Violation) return "BLOCKED";

  const openNeedsReviewHighPriority = findings.some((f) => f.compliance === "NEEDS_REVIEW" && (f.severity === "P0" || f.severity === "P1"));
  if (openNeedsReviewHighPriority) return "NEEDS REVIEW";

  const anyWarning = findings.some((f) => VIOLATION_COMPLIANCES.has(f.compliance) || f.compliance === "NEEDS_REVIEW" || f.compliance === "AFFECTED");
  return anyWarning ? "PASS WITH WARNINGS" : "PASS";
}

export function buildReportModel({ registry, verifications, findings, conflicts, impact, regression, repoInfo }) {
  const plannedFindings = findings; // already fix-policy-annotated by caller
  const byLifecycle = {};
  for (const v of verifications) byLifecycle[v.lifecycle] = (byLifecycle[v.lifecycle] || 0) + 1;

  const byCompliance = {};
  for (const v of verifications) byCompliance[v.compliance] = (byCompliance[v.compliance] || 0) + 1;

  return {
    generatedAt: new Date().toISOString(),
    repo: repoInfo,
    registry: {
      totalDeclared: registry.totalDeclared,
      totalValid: registry.requirements.length,
      structuralErrors: registry.structuralErrors,
      duplicates: registry.duplicates,
      byLifecycle,
      byCompliance,
    },
    conflicts,
    severityCounts: countBySeverity(plannedFindings),
    findings: sortFindings(plannedFindings),
    verifications,
    impact: impact || null,
    regression,
    coveragePercent: verifications.length ? Math.round((verifications.filter((v) => v.compliance !== "NEEDS_REVIEW").length / verifications.length) * 100) : 0,
    decision: decide(plannedFindings),
  };
}

export function writeReports(reportsRoot, model, { label = "requirements-guardian" } = {}) {
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
  lines.push(`# AyurNova Requirements Guardian Report`);
  lines.push(``);
  lines.push(`Generated: ${model.generatedAt}`);
  lines.push(``);
  lines.push(`## 1. Decision`);
  lines.push(``);
  lines.push(`**${model.decision}**`);
  lines.push(``);
  lines.push(`- Requirements in registry: ${model.registry.totalValid} (${model.registry.totalDeclared} declared, ${model.registry.structuralErrors.length} rejected for structural errors)`);
  lines.push(`- Requirement coverage (non-NEEDS_REVIEW verdicts): ${model.coveragePercent}%`);
  lines.push(`- Severity counts: P0=${model.severityCounts.P0}, P1=${model.severityCounts.P1}, P2=${model.severityCounts.P2}, P3=${model.severityCounts.P3}`);
  lines.push(``);

  lines.push(`## 2. Registry Summary`);
  lines.push(``);
  lines.push(`### By lifecycle`);
  lines.push(``);
  for (const [k, v] of Object.entries(model.registry.byLifecycle)) lines.push(`- ${k}: ${v}`);
  lines.push(``);
  lines.push(`### By compliance status`);
  lines.push(``);
  for (const [k, v] of Object.entries(model.registry.byCompliance)) lines.push(`- ${k}: ${v}`);
  lines.push(``);

  if (model.conflicts?.hasAnyConflict) {
    lines.push(`## 3. Conflicts / Registry Integrity`);
    lines.push(``);
    if (model.conflicts.structuralErrors.length) {
      lines.push(`**Structural errors** (requirement rejected from the active set):`);
      for (const e of model.conflicts.structuralErrors) lines.push(`- ${e.id}: ${e.errors.join("; ")}`);
    }
    if (model.conflicts.duplicates.length) {
      lines.push(`**Duplicates:**`);
      for (const d of model.conflicts.duplicates) lines.push(`- ${JSON.stringify(d)}`);
    }
    if (model.conflicts.conflictedRequirements.length) {
      lines.push(`**Requirements marked CONFLICTED (authoritative sources disagree - not auto-resolved):**`);
      for (const c of model.conflicts.conflictedRequirements) lines.push(`- ${c.requirementId}: ${c.title}`);
    }
    lines.push(``);
  }

  if (model.impact) {
    lines.push(`## Change Impact`);
    lines.push(``);
    lines.push(`Changed files: ${model.impact.changedFiles.length}`);
    lines.push(`Affected requirements: ${model.impact.affected.length} (DIRECT=${model.impact.counts.DIRECT}, INDIRECT=${model.impact.counts.INDIRECT}, POSSIBLE=${model.impact.counts.POSSIBLE})`);
    lines.push(``);
    lines.push(`| Requirement | Confidence | Reason |`);
    lines.push(`|---|---|---|`);
    for (const a of model.impact.affected) lines.push(`| ${a.requirementId} | ${a.confidence} | ${a.reason} |`);
    lines.push(``);
  }

  lines.push(`## 4. Findings (most severe first)`);
  lines.push(``);
  if (model.findings.length === 0) lines.push(`No open findings.`);
  for (const f of model.findings) {
    lines.push(`### [${f.severity}] ${f.id} - ${f.requirementId}: ${f.title}`);
    lines.push(``);
    lines.push(`- Compliance: ${f.compliance}`);
    lines.push(`- Confidence: ${f.confidence}`);
    lines.push(`- Expected: ${f.expected || "n/a"}`);
    lines.push(`- Observed: ${f.observed || "n/a"}`);
    if (f.evidence?.length) {
      lines.push(`- Evidence:`);
      for (const e of f.evidence) lines.push(`  - \`${e.file}${e.line ? `:${e.line}` : ""}\`${e.detail ? ` - ${e.detail}` : ""}`);
    }
    lines.push(`- Fix policy: ${f.fixPolicy || "n/a"}`);
    if (f.recommendation) lines.push(`- Recommendation: ${f.recommendation}`);
    lines.push(``);
  }

  lines.push(`## 5. Regression vs Baseline`);
  lines.push(``);
  if (!model.regression.hasBaseline) {
    lines.push(`No prior baseline found - this run establishes the baseline.`);
  } else {
    lines.push(`Baseline from: ${model.regression.baselineDate}`);
    lines.push(`- New regressions since baseline: ${model.regression.regressions.length}`);
    lines.push(`- Resolved since baseline: ${model.regression.resolved.length}`);
    lines.push(`- Severity-escalated since baseline: ${model.regression.escalated.length}`);
    lines.push(`- Unchanged: ${model.regression.unchangedCount}`);
  }
  lines.push(``);

  return lines.join("\n");
}
