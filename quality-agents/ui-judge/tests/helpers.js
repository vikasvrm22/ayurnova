// Shared test harness: renders a fixture's reference.html to a PNG with a
// real (headed) browser, serves the fixture directory over HTTP, and runs
// a full audit against it via the same runAudit() orchestrator the CLI
// uses - so these tests exercise the real pipeline end to end, not a mock.
import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { startStaticServer } from "./fixtures/staticServer.js";
import { runAudit } from "../src/runAudit.js";
import { defaultPaths } from "../src/lib/configLoader.js";

const DEFAULT_VIEWPORT = { width: 1024, height: 900 };
// The fixtures render a fixed-position clock in the bottom-right corner -
// a stand-in for "dynamic timestamps" the comparator must ignore, not compare.
const TIMESTAMP_IGNORE_REGION = { xPct: 0.82, yPct: 0.88, wPct: 0.18, hPct: 0.12 };

export async function runFixtureAudit(caseName, { viewport = DEFAULT_VIEWPORT, additionalViewports = [] } = {}) {
  const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures", caseName);
  const { port, close } = await startStaticServer(fixtureDir);

  try {
    const browser = await chromium.launch({ headless: false });
    const refPage = await browser.newPage();
    await refPage.setViewportSize(viewport);
    await refPage.goto(`http://127.0.0.1:${port}/reference.html`, { waitUntil: "load" });
    await refPage.waitForTimeout(200);
    const referencePng = await refPage.screenshot();
    await browser.close();

    const referenceAbsPath = path.join(fixtureDir, "reference.generated.png");
    fs.writeFileSync(referenceAbsPath, referencePng);

    const pageConfig = {
      name: `fixture-${caseName}`,
      route: "/actual.html",
      fullUrl: `http://127.0.0.1:${port}/actual.html`,
      referenceAbsPath,
      reference: "reference.generated.png",
      viewport,
      additionalViewports,
      ignoreRegions: [TIMESTAMP_IGNORE_REGION],
    };

    const paths = defaultPaths();
    const weightsRaw = JSON.parse(fs.readFileSync(paths.defaultWeights, "utf8"));
    const severityThresholds = JSON.parse(fs.readFileSync(paths.defaultSeverity, "utf8"));
    const outDir = path.join(paths.root, "reports", "_selftest");

    return await runAudit(pageConfig, {
      weightsRaw, severityThresholds, sourceRoots: [],
      specsDir: fixtureDir,
      screenshotsDir: path.join(outDir, "screenshots"),
      reportsDir: outDir,
      baselinesDir: path.join(outDir, "baselines"),
      projectRoot: paths.root, projectName: "ui-judge-selftest", saveBaseline: false,
    });
  } finally {
    await close();
  }
}

export function assert(cond, message) {
  if (!cond) throw new Error(`Assertion failed: ${message}`);
}
