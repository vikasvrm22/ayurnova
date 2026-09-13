// ============================================================
// 8. REPORT GENERATOR
// ============================================================
// Writes both a machine-readable JSON report and a human-readable
// Markdown report for one audit run. Pure formatting/fs - no scoring
// logic lives here.
import fs from "node:fs";
import path from "node:path";

function pct(v) { return v === null || v === undefined ? "n/a" : `${v}%`; }

function renderMarkdown(result) {
  const { meta, scoring, regression, findings, functional } = result;
  const lines = [];
  lines.push(`# UI Judge Report — ${meta.page}`);
  lines.push("");
  lines.push(`| | |`);
  lines.push(`|---|---|`);
  lines.push(`| Project | ${meta.project} |`);
  lines.push(`| Page | ${meta.page} |`);
  lines.push(`| URL | ${meta.url} |`);
  lines.push(`| Reference | ${meta.reference} |`);
  lines.push(`| Viewport | ${meta.viewport.width}x${meta.viewport.height} |`);
  lines.push(`| Timestamp | ${meta.timestamp} |`);
  lines.push(`| **Status** | **${scoring.status}** |`);
  lines.push("");
  lines.push(`## Overall Fidelity: ${pct(scoring.overall)}  (confidence: ${pct(scoring.confidence)})`);
  lines.push("");
  for (const [cat, val] of Object.entries(scoring.categoryScores)) {
    lines.push(`- ${cat[0].toUpperCase()}${cat.slice(1)}: ${pct(val)}${val === null ? " _(no usable evidence — excluded from score, weight redistributed)_" : ""}`);
  }
  lines.push("");
  lines.push(`Visual Fidelity: ${pct(scoring.visualFidelity)} · Structural Fidelity: ${pct(scoring.structuralFidelity)} · Functional Fidelity: ${pct(scoring.functionalFidelity)} · Responsive Fidelity: ${pct(scoring.responsiveFidelity)}`);
  lines.push("");

  if (regression) {
    lines.push(`## Baseline Regression`);
    lines.push(`Previous: ${regression.previous}% → Current: ${regression.current}% (${regression.delta >= 0 ? "+" : ""}${regression.delta}%)${regression.regressed ? " — **REGRESSION**" : ""}`);
    lines.push("");
  }

  lines.push(`## Deviations (${findings.length})`);
  if (!findings.length) lines.push("_None found._");
  for (const f of findings) {
    lines.push("");
    lines.push(`### [${f.severity}] ${f.id} — ${f.category}`);
    lines.push(`- Reference expectation: ${f.refExpectation}`);
    lines.push(`- Actual: ${f.actual}`);
    lines.push(`- Evidence: ${f.evidence}${f.viewport ? ` (${f.viewport} viewport)` : ""}`);
    lines.push(`- Estimated deviation: ${f.deviationEstimate}`);
    lines.push(`- Recommendation: ${f.recommendation}`);
    lines.push(`- Likely area: ${f.likelyArea || f.areaNote || "unknown"}`);
    lines.push(`- Backend change required: ${f.backendChangeRequired ? "Yes" : "No"}`);
  }

  lines.push("");
  lines.push(`## Functional Results`);
  lines.push(`Score: ${pct(functional.score)} (${functional.counts.buttons} buttons, ${functional.counts.links} links, ${functional.counts.forms} forms, ${functional.counts.images} images checked)`);

  lines.push("");
  lines.push(`## Evidence`);
  for (const [k, v] of Object.entries(result.evidencePaths)) {
    if (v) lines.push(`- ${k}: ${v}`);
  }

  return lines.join("\n") + "\n";
}

export function writeReports(result, { reportsDir }) {
  fs.mkdirSync(reportsDir, { recursive: true });
  const stamp = result.meta.timestamp.replace(/[:.]/g, "-");
  const base = `${result.meta.page}__${stamp}`;
  const jsonPath = path.join(reportsDir, `${base}.json`);
  const mdPath = path.join(reportsDir, `${base}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  fs.writeFileSync(mdPath, renderMarkdown(result));

  // "latest" pointer per page - convenient for baseline tooling/CI without parsing timestamps.
  fs.writeFileSync(path.join(reportsDir, `${result.meta.page}.latest.json`), JSON.stringify(result, null, 2));
  return { jsonPath, mdPath };
}
