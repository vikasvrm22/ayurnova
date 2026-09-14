#!/usr/bin/env node
import { runGuardian } from "../src/runGuardian.js";

function parseArgs(argv) {
  const args = { applyFixes: false, saveAsBaseline: false, filters: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--baseline") args.saveAsBaseline = true;
    else if (a === "--apply-fixes") args.applyFixes = true;
    else if (a === "--workflow") args.filters.workflow = argv[++i];
    else if (a === "--module") args.filters.module = argv[++i];
    else if (a === "--phase") args.filters.phase = argv[++i]; // informational only - see README
    else if (a === "--regression" || a === "--report") {
      // both are the default reporting behaviour; accepted for CLI-shape compatibility with the spec.
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp() {
  console.log(`AyurNova Wiring Guardian

Usage:
  npm run guardian
  npm run guardian -- --workflow customer.checkout.purchase
  npm run guardian -- --module payments
  npm run guardian -- --baseline           Save this run's findings as the new regression baseline
  npm run guardian -- --apply-fixes        Apply any SAFE_AUTO_FIX-classified findings, then report
  npm run guardian -- --phase 1-2          Informational filter tag only (Guardian is phase-independent)

Reports are written to wiring-guardian/reports/ as timestamped JSON+Markdown pairs, plus
*.latest.json / *.latest.md. Baseline lives at wiring-guardian/reports/baseline/baseline.json.
`);
}

const args = parseArgs(process.argv.slice(2));
const { model, paths, appliedFixes } = runGuardian(args);

console.log(`Wiring Guardian audit complete.`);
console.log(`Overall Wiring Health: ${model.overallHealth.score}/100 (${model.overallHealth.formula})`);
console.log(`Severity counts: P0=${model.severityCounts.P0} P1=${model.severityCounts.P1} P2=${model.severityCounts.P2} P3=${model.severityCounts.P3}`);
if (appliedFixes.length) {
  console.log(`Applied ${appliedFixes.length} safe auto-fix(es), then re-audited:`);
  for (const f of appliedFixes) console.log(`  - [${f.findingIds.join(", ")}] via ${f.fixerId} -> ${f.file}`);
}
console.log(`Report: ${paths.mdPath}`);
console.log(`Report (JSON): ${paths.jsonPath}`);

if (model.severityCounts.P0 > 0) process.exitCode = 1;
