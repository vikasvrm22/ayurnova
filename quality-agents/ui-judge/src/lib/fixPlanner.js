// ============================================================
// 7. FIX PLANNER
// ============================================================
// Turns each finding into an implementation-ready recommendation, and
// makes a best-effort (never guaranteed) guess at the source file by
// grepping the project's own source roots for the selector/text involved.
// Never edits anything - this module only reads and reports.
import fs from "node:fs";
import path from "node:path";

const RECOMMENDATION_TEMPLATES = {
  "broken-image": () => "Fix or replace the image source so it resolves to a valid asset.",
  "missing-alt": () => "Add a descriptive alt attribute for accessibility/SEO parity with the reference.",
  "missing-element": (f) => `Add/restore the element matching "${f.selector || f.refExpectation}" - it is expected by the design but absent from the rendered DOM.`,
  "missing-section": (f) => `Restore the missing page section ("${f.refExpectation}") - the design references it but it was not found in the DOM.`,
  "text-mismatch": (f) => `Update the element's text to match the reference copy ("${f.refExpectation}").`,
  "font-size": (f) => `Adjust font-size on "${f.selector}" from ${f.actual} toward ${f.refExpectation}.`,
  "font-weight": (f) => `Adjust font-weight on "${f.selector}" to ${f.refExpectation}.`,
  "font-family": (f) => `Apply the expected font-family (${f.refExpectation}) to "${f.selector}".`,
  "gap-mismatch": (f) => `Adjust spacing between ${f.selector} to close a ${f.deviationEstimate} gap (expected ${f.refExpectation}).`,
  "image-count": () => "Reconcile the number of rendered images with the reference (missing or extra image blocks).",
  "palette-mismatch": (f) => `Bring the page's palette closer to reference color ${f.refExpectation} (nothing close was found on the rendered page).`,
  "band-mismatch": () => "Vertical layout rhythm diverges from the reference - review section heights/order (largest visual/structural signal for this page).",
  "overflow": (f) => `Fix horizontal overflow on ${f.selector || "the page"} (${f.deviationEstimate} over viewport width) at the ${f.viewport} viewport.`,
  "dead-button": () => "Wire this button to a real click handler or convert it to a disabled/non-interactive state intentionally.",
  "empty-href": () => "Give this link a real destination, or remove it if it is not yet implemented.",
  "unnamed-field": () => "Add a name/id attribute so this form field actually submits.",
  "console-error": () => "Investigate and fix the JavaScript error thrown while the page loaded.",
  "navigation-error": () => "The page failed to load at all - fix the route/server error before any visual comparison is meaningful.",
  "http-error": (f) => `The page responded with an HTTP error (${f.actual}) - fix the route before auditing UI fidelity.`,
};

// style-mismatch:<prop> findings are handled via startsWith() in recommendationFor, not this table.
function recommendationFor(finding) {
  if (finding.kind.startsWith("style-mismatch")) {
    const prop = finding.kind.split(":")[1] || "style";
    return `Update ${prop} on "${finding.selector}" from ${finding.actual} to match ${finding.refExpectation}.`;
  }
  const fn = RECOMMENDATION_TEMPLATES[finding.kind];
  return fn ? fn(finding) : "Review this deviation against the reference and adjust as needed.";
}

const TEXT_EXT = new Set([".html", ".css", ".js"]);
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (TEXT_EXT.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

/** Best-effort: which source file(s) mention this selector/text. Never modifies anything. */
function locateSource(finding, sourceRoots) {
  if (!sourceRoots?.length) return { file: null, note: "No sourceRoots configured for this project." };
  const needle = (finding.selector || finding.refExpectation || "").replace(/^[.#]/, "").split(/[.#\s>]/)[0];
  if (!needle || needle.length < 2) return { file: null, note: "No searchable identifier on this finding." };

  const files = sourceRoots.flatMap((root) => walk(root));
  const hits = [];
  for (const file of files) {
    let content;
    try { content = fs.readFileSync(file, "utf8"); } catch { continue; }
    if (content.includes(needle)) hits.push(file);
  }
  if (hits.length === 1) return { file: hits[0], note: null };
  if (hits.length === 0) return { file: null, note: `Not confidently identifiable - "${needle}" was not found in any configured source root.` };
  return { file: null, note: `Not confidently identifiable - "${needle}" matched ${hits.length} files.`, candidates: hits.slice(0, 5) };
}

export function buildFixPlan(findings, { sourceRoots, projectRoot } = {}) {
  return findings.map((f) => {
    const located = locateSource(f, sourceRoots);
    return {
      ...f,
      recommendation: recommendationFor(f),
      likelyArea: located.file ? path.relative(projectRoot || process.cwd(), located.file) : null,
      areaNote: located.note,
      areaCandidates: located.candidates ? located.candidates.map((c) => path.relative(projectRoot || process.cwd(), c)) : undefined,
      backendChangeRequired: false, // this tool only audits front-end rendering/markup, never backend logic
    };
  });
}
