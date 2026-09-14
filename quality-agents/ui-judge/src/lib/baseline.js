// ============================================================
// 9. BASELINE / REGRESSION SUPPORT
// ============================================================
// Compares the current run's score against a previously *approved*
// baseline for the same page (separate from the reference-image
// comparison, which always runs). A score delta is reported as a
// regression only past REGRESSION_THRESHOLD - small day-to-day noise
// (content changes, minor copy edits) should not cry wolf.
import fs from "node:fs";
import path from "node:path";

const REGRESSION_THRESHOLD = 5; // percentage points

export function loadBaseline(baselinesDir, pageName) {
  const file = path.join(baselinesDir, `${pageName}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function saveBaseline(baselinesDir, pageName, scoring, reportPath) {
  fs.mkdirSync(baselinesDir, { recursive: true });
  const record = { page: pageName, overall: scoring.overall, categoryScores: scoring.categoryScores, savedAt: new Date().toISOString(), reportPath };
  fs.writeFileSync(path.join(baselinesDir, `${pageName}.json`), JSON.stringify(record, null, 2));
  return record;
}

export function compareToBaseline(baseline, scoring) {
  if (!baseline) return null;
  const delta = scoring.overall - baseline.overall;
  return {
    previous: baseline.overall, current: scoring.overall, delta,
    regressed: delta <= -REGRESSION_THRESHOLD,
    baselineSavedAt: baseline.savedAt,
  };
}
