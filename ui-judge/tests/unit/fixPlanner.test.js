import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildFixPlan } from "../../src/lib/fixPlanner.js";
import { assert } from "../helpers.js";

export default async function run() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ui-judge-fixplanner-"));
  fs.writeFileSync(path.join(tmpRoot, "widget.html"), `<button id="primary-cta" class="primary-cta">Go</button>`);
  fs.writeFileSync(path.join(tmpRoot, "other.html"), `<p>unrelated</p>`);

  const findings = [
    { id: "components-1", category: "components", severity: "P1", kind: "missing-element", refExpectation: "primary-cta present", actual: "not found", selector: "#primary-cta" },
    { id: "layout-1", category: "layout", severity: "P2", kind: "band-mismatch", refExpectation: "reference rhythm", actual: "correlation 0.3" },
    { id: "assets-1", category: "assets", severity: "P0", kind: "broken-image", refExpectation: "image loads", actual: "missing.png" },
  ];

  const plan = buildFixPlan(findings, { sourceRoots: [tmpRoot], projectRoot: tmpRoot });
  const bySelector = plan.find((f) => f.selector === "#primary-cta");
  assert(bySelector.likelyArea === "widget.html", `expected fixPlanner to locate widget.html via the selector, got ${bySelector.likelyArea}`);
  assert(bySelector.recommendation.length > 0, "every finding must get a recommendation");
  assert(bySelector.backendChangeRequired === false, "this tool never claims a backend change is required");

  const unlocatable = plan.find((f) => f.id === "layout-1");
  assert(unlocatable.likelyArea === null && unlocatable.areaNote, "a finding with no identifiable selector/text must honestly report it can't locate a file, not guess one");

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  return { name: "fixPlanner" };
}
