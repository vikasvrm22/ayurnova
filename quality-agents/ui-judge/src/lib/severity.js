// ============================================================
// 6. DEVIATION SEVERITY DETECTOR
// ============================================================
// Turns the comparator's raw per-category findings into standardized,
// ranked Finding records: P0 (broken/critical) .. P3 (polish).
const EVIDENCE_LABEL = {
  "broken-image": "browser DOM (naturalWidth === 0)", "missing-alt": "browser DOM (img[alt])",
  "missing-element": "DOM selector query", "missing-section": "DOM selector query",
  "text-mismatch": "DOM textContent", "font-size": "computed style", "font-weight": "computed style",
  "font-family": "computed style", "gap-mismatch": "bounding-box comparison", "image-count": "DOM query count",
  "palette-mismatch": "dominant-color extraction", "band-mismatch": "pixel diff / luminance profile",
  "overflow": "scrollWidth/clientWidth", "dead-button": "DOM event/attribute inspection",
  "empty-href": "DOM attribute inspection", "unnamed-field": "DOM attribute inspection",
  "console-error": "browser console", "navigation-error": "network/navigation", "http-error": "HTTP response",
};

function classifyByThreshold(value, t) {
  if (value === undefined || value === null) return null;
  if (value >= t.p0) return "P0";
  if (value >= t.p1) return "P1";
  if (value >= t.p2) return "P2";
  if (value >= t.p3) return "P3";
  return null;
}

function classify(finding, thresholds) {
  if (finding.presetSeverity) return finding.presetSeverity;
  if (finding.kind === "broken-image" || finding.kind === "navigation-error" || finding.kind === "http-error") return "P0";
  if (finding.kind === "missing-alt") return "P3";
  if (finding.kind === "missing-element" || finding.kind === "missing-section") return finding.critical || finding.kind === "missing-section" ? "P0" : "P1";
  if (finding.kind === "overflow") return classifyByThreshold(finding.deltaPx, thresholds.overflowPx) || "P3";
  if (finding.kind === "gap-mismatch") return classifyByThreshold(finding.deltaPx, thresholds.spacingDeltaPx) || "P3";
  if (finding.kind === "font-size") return classifyByThreshold(finding.deltaPx, thresholds.fontSizeDeltaPx) || "P3";
  if (finding.kind === "palette-mismatch" || finding.kind.startsWith("style-mismatch:color") || finding.kind.startsWith("style-mismatch:backgroundColor")) {
    return classifyByThreshold(finding.deviation, thresholds.colorDistance) || "P3";
  }
  if (finding.kind === "band-mismatch") return classifyByThreshold(finding.deviation, thresholds.visualDiffRatio) || "P3";
  if (finding.kind === "text-mismatch" || finding.kind === "font-weight" || finding.kind === "font-family" || finding.kind.startsWith("style-mismatch")) return "P2";
  if (finding.kind === "image-count") return "P2";
  return classifyByThreshold(finding.deviation ?? 0.1, thresholds.visualDiffRatio) || "P3";
}

const SEVERITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** Flattens comparator category results into one severity-ranked, IDed finding list. */
export function detectDeviations(categoryResults, thresholds) {
  const findings = [];
  let n = 0;
  for (const [category, result] of Object.entries(categoryResults)) {
    for (const raw of result?.findings || []) {
      n += 1;
      const severity = classify(raw, thresholds);
      findings.push({
        id: `${category}-${n}`,
        category,
        severity,
        refExpectation: raw.refExpectation,
        actual: raw.actual,
        evidence: EVIDENCE_LABEL[raw.kind] || "comparator heuristic",
        deviationEstimate: raw.deltaPx !== undefined ? `${raw.deltaPx}px` : raw.deviation !== undefined ? `${Math.round(raw.deviation * 100)}%` : "n/a",
        selector: raw.selector || null,
        viewport: raw.viewport || "primary",
        kind: raw.kind,
      });
    }
  }
  return findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
