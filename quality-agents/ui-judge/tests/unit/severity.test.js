import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectDeviations } from "../../src/lib/severity.js";
import { assert } from "../helpers.js";

const thresholds = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "config", "severity.thresholds.json"), "utf8"));

export default async function run() {
  const categoryResults = {
    assets: { findings: [{ kind: "broken-image", refExpectation: "loads", actual: "x.png", deviation: 1 }, { kind: "missing-alt", refExpectation: "alt present", actual: "x.png", deviation: 0.2 }] },
    responsive: { findings: [{ kind: "overflow", refExpectation: "no overflow", actual: "100px over", deviation: 1, deltaPx: 100, viewport: "mobile" }] },
    spacing: { findings: [{ kind: "gap-mismatch", refExpectation: "24px", actual: "60px", deviation: 0.5, deltaPx: 36, selector: "a->b" }] },
    typography: { findings: [{ kind: "font-size", refExpectation: "32px", actual: "20px", deviation: 0.6, deltaPx: 12, selector: "#hero-title" }] },
    components: { findings: [{ kind: "missing-element", refExpectation: "#cta present", actual: "not found", deviation: 1, critical: true, selector: "#cta" }] },
    functional: { findings: [{ kind: "dead-button", refExpectation: "wired up", actual: "no handler", deviation: 0.6, presetSeverity: "P1" }] },
  };

  const findings = detectDeviations(categoryResults, thresholds);
  const byKind = Object.fromEntries(findings.map((f) => [f.kind, f]));

  assert(byKind["broken-image"].severity === "P0", "broken image must always be P0");
  assert(byKind["missing-alt"].severity === "P3", "missing alt is a polish-level accessibility issue, P3");
  assert(byKind["overflow"].severity === "P0", `100px overflow should classify as P0 per thresholds, got ${byKind.overflow.severity}`);
  assert(byKind["gap-mismatch"].severity === "P1", `36px gap delta should classify as P1 per thresholds, got ${byKind["gap-mismatch"].severity}`);
  assert(byKind["font-size"].severity === "P0", `12px font-size delta should classify as P0 per thresholds, got ${byKind["font-size"].severity}`);
  assert(byKind["missing-element"].severity === "P0", "a critical missing element must be P0");
  assert(byKind["dead-button"].severity === "P1", "functional findings must honor their preset severity");

  // Sorted most-severe first.
  const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
  for (let i = 1; i < findings.length; i++) assert(order[findings[i].severity] >= order[findings[i - 1].severity], "findings must come back sorted P0 -> P3");

  // Non-critical missing element should be P1, not P0.
  const nonCritical = detectDeviations({ components: { findings: [{ kind: "missing-element", refExpectation: "x", actual: "y", deviation: 1, critical: false, selector: "#x" }] } }, thresholds);
  assert(nonCritical[0].severity === "P1", `non-critical missing element should be P1, got ${nonCritical[0].severity}`);

  return { name: "severity" };
}
