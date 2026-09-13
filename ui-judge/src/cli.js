// ============================================================
// 10. CLI
// ============================================================
import path from "node:path";
import { loadProjectConfig, resolvePage, loadWeightsFile, loadSeverityThresholds, defaultPaths } from "./lib/configLoader.js";
import { runAudit } from "./runAudit.js";
import { buildInventory, summarizeInventory, writeInventoryFile } from "./lib/referenceInventory.js";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) { out[key] = true; }
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function printHelp() {
  console.log(`UI Judge - audit an implemented page against an approved design reference.

Usage:
  node bin/ui-judge.js --page <name> [options]
  node bin/ui-judge.js --list
  node bin/ui-judge.js --page <name> --url <url> --reference <image> --width <px> --height <px>

Options:
  --page <name>        Page name from the config (or an ad-hoc name with --url/--reference)
  --config <path>      Path to pages.config.json (default: ui-judge/config/pages.config.json)
  --url <url>          Override the page's route/URL
  --reference <path>   Override the reference image path
  --width <px>         Override viewport width
  --height <px>        Override viewport height
  --output <dir>       Override the reports output directory
  --weights <path>     Override the weights config
  --json                Print the JSON result to stdout in addition to writing report files
  --headed              Accepted for compatibility - browser verification always runs headed
  --save-baseline       Promote this run's score to the baseline for future regression checks
  --list                List configured pages and exit
  --list-references     Scan the configured designRefDir, print a discovery
                         summary, and write generated/reference-inventory.json
  --help                Show this help
`);
}

function printReferenceSummary(summary) {
  console.log(`Total references:      ${summary.total}`);
  console.log(`  Configured:           ${summary.configured}`);
  console.log(`  Auto-discovered:      ${summary.autoDiscovered}`);
  console.log(`    Ready:              ${summary.ready}`);
  console.log(`    Needs mapping:      ${summary.needsMapping}`);
  console.log(`    Ambiguous:          ${summary.ambiguous}`);
  console.log(`    Unmapped:           ${summary.unmapped}`);
  console.log(`  Duplicates:           ${summary.duplicates}`);
  console.log(`  Unknown type:         ${summary.unknown}`);
  console.log("\nBy phase:");
  for (const [phase, count] of Object.entries(summary.byPhase).sort()) {
    console.log(`  ${phase}: ${count}`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { printHelp(); return 0; }

  const paths = defaultPaths();
  const configPath = args.config ? path.resolve(args.config) : paths.defaultConfig;
  const projectConfig = loadProjectConfig(configPath);

  if (args.list) {
    console.log("Configured pages:");
    projectConfig.pages.forEach((p) => console.log(`  - ${p.name}  (${p.route})`));
    return 0;
  }

  if (args["list-references"]) {
    if (!projectConfig.designRefDir) {
      console.error(`No "designRefDir" set in ${configPath} - nothing to discover.`);
      return 1;
    }
    const items = buildInventory({
      designRefDir: projectConfig.designRefDir,
      pagesConfig: projectConfig,
      sourceRoots: projectConfig.sourceRoots,
    });
    const summary = summarizeInventory(items);
    const outPath = path.join(paths.generatedDir, "reference-inventory.json");
    writeInventoryFile(items, outPath);
    printReferenceSummary(summary);
    console.log(`\nInventory written to ${outPath}`);
    return 0;
  }

  if (!args.page) { printHelp(); console.error("\nError: --page is required (or use --list / --list-references)."); return 1; }

  const pageConfig = resolvePage(projectConfig, args.page, {
    url: typeof args.url === "string" ? args.url : undefined,
    reference: typeof args.reference === "string" ? args.reference : undefined,
    width: args.width ? Number(args.width) : undefined,
    height: args.height ? Number(args.height) : undefined,
    baseUrl: projectConfig.baseUrl,
  });

  const weightsRaw = loadWeightsFile(args.weights ? path.resolve(args.weights) : paths.defaultWeights);
  const severityThresholds = loadSeverityThresholds(paths.defaultSeverity);
  const outputDir = args.output ? path.resolve(args.output) : paths.reportsDir;

  console.log(`Auditing "${pageConfig.name}" -> ${pageConfig.fullUrl}\nReference: ${pageConfig.referenceAbsPath}\n(headed browser - a Chromium window will open)`);

  const result = await runAudit(pageConfig, {
    weightsRaw, severityThresholds,
    sourceRoots: projectConfig.sourceRoots,
    authStorageStatePath: projectConfig.authStorageStatePath,
    specsDir: paths.specsDir, screenshotsDir: paths.screenshotsDir,
    reportsDir: outputDir, baselinesDir: paths.baselinesDir,
    projectRoot: path.resolve(paths.root, ".."), projectName: path.basename(path.resolve(paths.root, "..")),
    saveBaseline: !!args["save-baseline"],
  });

  console.log(`\nOverall Fidelity: ${result.scoring.overall}%  (confidence ${result.scoring.confidence}%)  -> ${result.scoring.status}`);
  for (const [cat, val] of Object.entries(result.scoring.categoryScores)) console.log(`  ${cat}: ${val === null ? "n/a (excluded)" : val + "%"}`);
  console.log(`\n${result.findings.length} deviation(s) found. Report: ${result.reportPaths.md}`);
  if (result.regression) console.log(`Baseline: ${result.regression.previous}% -> ${result.regression.current}% (${result.regression.delta >= 0 ? "+" : ""}${result.regression.delta}%)${result.regression.regressed ? " REGRESSION" : ""}`);

  if (args.json) console.log("\n" + JSON.stringify(result, null, 2));
  return 0;
}
