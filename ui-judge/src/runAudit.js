// Orchestrates one full audit run: Design Analyzer -> Actual UI Analyzer
// -> Functional Checker -> Comparison Engine -> Scoring -> Severity ->
// Fix Planner -> Baseline -> Report Generator. Used by both the CLI and
// the test suite (tests drive it directly against local fixtures so they
// don't depend on the real app/Supabase being up).
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { getDesignSpec } from "./lib/designAnalyzer.js";
import { collectEvidence } from "./lib/browserAnalyzer.js";
import { checkFunctional } from "./lib/functionalChecker.js";
import { compare, collectSpecSelectors } from "./lib/comparator.js";
import { scoreAudit, loadWeights } from "./lib/scoring.js";
import { detectDeviations } from "./lib/severity.js";
import { buildFixPlan } from "./lib/fixPlanner.js";
import { loadBaseline, saveBaseline, compareToBaseline } from "./lib/baseline.js";
import { writeReports } from "./lib/reporter.js";

/**
 * @param {object} pageConfig - resolved via configLoader.resolvePage (has fullUrl, viewport, referenceAbsPath, name)
 * @param {object} opts - { weightsRaw, severityThresholds, sourceRoots, specsDir, screenshotsDir, reportsDir, baselinesDir, projectRoot, projectName, saveBaseline }
 */
export async function runAudit(pageConfig, opts) {
  const weights = loadWeights(opts.weightsRaw);
  const spec = await getDesignSpec(pageConfig, { specsDir: opts.specsDir });
  const extraSelectors = collectSpecSelectors(spec);

  const browser = await chromium.launch({ headless: false }); // Section 2 requirement: browser verification MUST run headed.
  const evidenceByViewport = {};
  try {
    const primaryPage = await browser.newPage();
    evidenceByViewport.primary = await collectEvidence(primaryPage, {
      url: pageConfig.fullUrl, viewport: pageConfig.viewport, waitForSelector: pageConfig.waitForSelector, extraSelectors,
    });
    await primaryPage.close();

    for (const vp of pageConfig.additionalViewports || []) {
      const p = await browser.newPage();
      evidenceByViewport[vp.name] = await collectEvidence(p, {
        url: pageConfig.fullUrl, viewport: { width: vp.width, height: vp.height }, waitForSelector: pageConfig.waitForSelector, extraSelectors,
      });
      await p.close();
    }
  } finally {
    await browser.close();
  }

  const functionalResult = checkFunctional(evidenceByViewport.primary);
  const categoryResults = await compare({
    spec, evidenceByViewport, functionalResult,
    referenceAbsPath: pageConfig.referenceAbsPath,
    ignoreRegions: pageConfig.ignoreRegions || [],
  });

  const scoring = scoreAudit({ categoryResults, weights, navError: evidenceByViewport.primary.navError });
  const rawFindings = detectDeviations(categoryResults, opts.severityThresholds);
  const findings = buildFixPlan(rawFindings, { sourceRoots: opts.sourceRoots, projectRoot: opts.projectRoot });

  const timestamp = new Date().toISOString();
  const screenshotPath = path.join(opts.screenshotsDir, `${pageConfig.name}__actual.png`);
  fs.mkdirSync(opts.screenshotsDir, { recursive: true });
  fs.writeFileSync(screenshotPath, evidenceByViewport.primary.screenshotPng);
  let diffPath = null;
  if (categoryResults.visual?.diffPng) {
    diffPath = path.join(opts.screenshotsDir, `${pageConfig.name}__diff.png`);
    fs.writeFileSync(diffPath, categoryResults.visual.diffPng);
  }

  const baseline = loadBaseline(opts.baselinesDir, pageConfig.name);
  const regression = compareToBaseline(baseline, scoring);

  const result = {
    meta: {
      project: opts.projectName || "unnamed-project", page: pageConfig.name, url: pageConfig.fullUrl,
      reference: pageConfig.reference || pageConfig.referenceAbsPath, viewport: pageConfig.viewport, timestamp,
      designSpecSource: spec.source,
    },
    scoring, regression, findings,
    functional: { score: functionalResult.score, counts: functionalResult.counts, issues: functionalResult.issues },
    evidencePaths: { screenshot: screenshotPath, diff: diffPath, reference: pageConfig.referenceAbsPath },
    categoryDetails: Object.fromEntries(Object.entries(categoryResults).map(([k, v]) => [k, k === "visual" ? { diffRatio: v?.diffRatio ?? null } : sanitize(v)])),
  };

  const { jsonPath, mdPath } = writeReports(result, { reportsDir: opts.reportsDir });
  result.reportPaths = { json: jsonPath, md: mdPath };

  if (opts.saveBaseline) result.baselineSaved = saveBaseline(opts.baselinesDir, pageConfig.name, scoring, jsonPath);

  return result;
}

// Strips large/non-serializable fields (raw evidence isn't attached to categoryResults, but be defensive) before embedding a category summary in the report.
function sanitize(v) {
  if (!v || typeof v !== "object") return v;
  const { findings, ...rest } = v;
  return { ...rest, findingCount: (findings || []).length };
}
