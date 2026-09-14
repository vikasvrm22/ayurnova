import fs from "fs";
import path from "path";

const BASELINE_DIR = (reportsRoot) => path.join(reportsRoot, "baseline");

export function saveBaseline(reportsRoot, auditSummary) {
  const dir = BASELINE_DIR(reportsRoot);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "baseline.json"), JSON.stringify(auditSummary, null, 2), "utf8");
}

export function loadBaseline(reportsRoot) {
  const file = path.join(BASELINE_DIR(reportsRoot), "baseline.json");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Compares the current audit's finding set against the saved baseline by
 * finding-shape identity (layer+category+file+route+observed), since
 * auto-incrementing WG-#### ids are not stable across runs. Reports new
 * findings (regressions) and findings that disappeared (fixed or the code
 * they described no longer exists). */
export function compareToBaseline(baseline, currentFindings) {
  if (!baseline) return { hasBaseline: false, regressions: [], resolved: [], unchangedCount: currentFindings.length };

  const shape = (f) => `${f.layer}|${f.category}|${f.file}|${f.route}|${f.observed}`;
  const baselineShapes = new Set((baseline.findings || []).map(shape));
  const currentShapes = new Set(currentFindings.map(shape));

  const regressions = currentFindings.filter((f) => !baselineShapes.has(shape(f)));
  const resolved = (baseline.findings || []).filter((f) => !currentShapes.has(shape(f)));

  return {
    hasBaseline: true,
    baselineDate: baseline.auditedAt,
    regressions,
    resolved,
    unchangedCount: currentFindings.length - regressions.length,
  };
}
