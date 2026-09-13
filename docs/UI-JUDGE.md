# UI Judge

A reusable, **project-agnostic** UI auditor that compares an approved design
reference (a screenshot/mockup) against a real, implemented web page and
produces an evidence-based implementation-fidelity score, a ranked list of
deviations, and a fix plan. It lives at [`ui-judge/`](../ui-judge/), fully
self-contained (its own `package.json`, dependencies, config, and tests) and
does not depend on anything specific to this app beyond a `pages.config.json`
entry per page you want audited.

**It is an auditor, not an autofixer.** Default (and only) mode is
audit-only: it never edits application source, never touches the database,
and never performs a destructive or write action of any kind.

## Why it exists / how it was validated

This app has real approved design mockups already sitting in
[`public-site/design-ref/`](../public-site/design-ref/) with no automated way
to check the implementation against them. UI Judge closes that gap. It was
built and validated against two kinds of pages (see "Validation results"
below): a real page in this app, and two self-contained fixtures with a
known-correct and a known-deviated implementation of the same design, used
as the automated test suite (`npm test`).

## Architecture

```
ui-judge/
  bin/ui-judge.js         CLI entry point (section 10)
  src/
    cli.js                 argument parsing + orchestration glue
    runAudit.js             orchestrates one full audit run
    lib/
      configLoader.js       resolves pages.config.json / weights / severity thresholds
      designAnalyzer.js      1. DESIGN ANALYZER   - reference image -> spec
      browserAnalyzer.js     2. ACTUAL UI ANALYZER - headed Playwright -> evidence
      functionalChecker.js   4. FUNCTIONAL UI CHECKER - non-interactive wiring checks
      comparator.js           3. COMPARISON ENGINE - spec + evidence -> per-category results
      scoring.js               5. WEIGHTED SCORING ENGINE
      severity.js              6. DEVIATION SEVERITY DETECTOR (P0-P3)
      fixPlanner.js             7. FIX PLANNER (recommendations + best-effort file location)
      reporter.js               8. REPORT GENERATOR (JSON + Markdown)
      baseline.js               9. BASELINE / REGRESSION SUPPORT
      imageUtils.js            shared pixel-math primitives (sharp + pixelmatch)
  config/
    pages.config.json      11. MULTI-PAGE SUPPORT - the live page registry for this project
    weights.json             category weights for the scoring engine
    severity.thresholds.json  magnitude -> P0..P3 thresholds
  specs/                   cached/heuristic design specs (gitignored except authored ones you add)
  references/              (optional) local copies of reference images
  screenshots/             actual screenshots + visual diff images (gitignored)
  reports/                 JSON + Markdown reports per run (gitignored)
  baselines/               one JSON file per page - the last score promoted via --save-baseline
  tests/                    12. TESTING - unit + integration, run headed (npm test)
```

Each numbered module corresponds directly to a pipeline stage; `runAudit.js`
wires them together in order: Design Analyzer → Actual UI Analyzer →
Functional Checker → Comparison Engine → Scoring → Severity → Fix Planner →
Baseline → Report Generator.

## The Design Analyzer: two spec sources

A "Design Specification" for a page can come from two places, and the tool
always prefers the more trustworthy one:

- **Authored** (`specs/<page>.json` with `"source": "authored"`): a
  hand-written (or agent-authored - e.g. a person or an LLM that actually
  looked at the mockup) JSON file. This is the *only* way component
  identity, typography and spacing expectations reach high confidence,
  because reliably reading those off a flat PNG needs a human/vision model
  in the loop, not pixel math. See `ui-judge/tests/fixtures/*/fixture-*.json`
  for worked examples of the schema (`sections`, `colors`, `typography`,
  `spacing`, `components`, `assets`).
- **Heuristic** (generated automatically, cached to
  `specs/<page>.heuristic.json`): pixel-only analysis of the reference
  image - dimensions, dominant colors (coarse quantized-bucket histogram),
  and rough vertical section bands (luminance-change segmentation). Fields
  it cannot support (typography, spacing, component identity) are marked
  `confidence: "unknown"` rather than guessed.

**This is the load-bearing honesty mechanism in the whole tool.** Categories
that need an authored spec (components, typography, spacing) are *excluded*
from the score - not scored as if evidence existed - when only a heuristic
spec is available, and the exclusion is renormalized into the remaining
weights. Confidence is computed separately, over the *original* (non
-renormalized) weights, so leaning on excluded categories still visibly
lowers overall confidence.

Categories computable straight from pixels/DOM regardless of spec authoring
(layout via band-correlation + full visual pixel-diff, colors, assets,
responsive, functional) always produce a real number, so even a
heuristic-only run against a brand-new page produces a genuinely useful,
if lower-confidence, result. See the real admin-login run below.

## The Actual UI Analyzer + Functional Checker

Drives a **headed** Chromium (Playwright) - required, not configurable off -
navigates to the page, and collects: a screenshot, generic DOM structure
(headings/buttons/links/inputs/forms/images/nav/etc. with bounding boxes and
computed styles), plus any selector the design spec references specifically
(so authored component/typography/spacing checks can query exact elements).
It also captures overflow (`scrollWidth > clientWidth`) per viewport, broken
images (`naturalWidth === 0`), and console/page errors.

The Functional Checker is deliberately **non-interactive** - it never
clicks, submits, or navigates. It only inspects whether controls are wired
up: dead buttons (no `onclick` and not a native form submit/reset), links
with empty/placeholder hrefs, unnamed form fields, broken images, and
JS/navigation errors. This is a scope boundary, not an oversight (see
Limitations) - an audit run must never trigger a real checkout, delete, or
side effect.

## Comparison Engine + Scoring

Every category comparison is described in `comparator.js`. Highlights:

- **Layout** blends two independently-computable signals: a full visual
  pixel-diff (reference image vs. actual screenshot, via `pixelmatch`) and
  a structural landmark-presence check (do the DOM selectors an authored
  spec lists as `sections.expectedOrder` actually exist?). Both work even
  with a heuristic-only spec (the pixel-diff always runs), so layout is the
  category most resistant to "no authored spec = no signal".
- **Colors** compares the reference image's dominant palette (measured, not
  guessed) against the actual screenshot's dominant palette - also always
  computable.
- **Assets, Responsive, Functional** are always computable from
  automated evidence alone (broken images/alt text, overflow, wiring).
- **Components, Typography, Spacing** require an authored spec with
  selectors; without one they are excluded from scoring, not faked.

Weights (`config/weights.json`, editable without touching engine code):

| Category | Weight |
|---|---|
| Layout / Structure | 25% |
| Components | 20% |
| Typography | 10% |
| Spacing | 10% |
| Assets | 10% |
| Colors | 5% |
| Responsive | 10% |
| Functional | 10% |

Overall Fidelity is the weighted average of categories that *have evidence*,
weights renormalized across just those. Visual/Structural/Functional
/Responsive Fidelity are reported separately, alongside a **Confidence**
score (0-100%) that reflects evidence quality, not just category count.
Status is `PASS` (overall ≥ 90% and functional ≥ 90%), `NEEDS FIX`, or
`BLOCKED` (the page failed to load/navigate at all).

## Severity Detector (P0-P3)

`config/severity.thresholds.json` maps deviation magnitude to severity per
finding kind (pixel deltas for spacing/overflow/font-size, normalized 0-1
distance for color/visual-diff). A few kinds are hard-coded on principle
regardless of magnitude: a broken image, a navigation/HTTP error, or a
missing structural section is always P0; a missing accessibility `alt` is
always P3. Functional findings carry their own preset severity from the
Functional Checker. Findings are always returned sorted P0 → P3.

## Fix Planner

Every finding gets a template-based, category-aware recommendation, plus a
**best-effort** attempt to locate the likely source file: it greps the
project's configured `sourceRoots` (from `pages.config.json`) for the
finding's selector/text. If it finds exactly one match, that file is named;
otherwise it honestly reports "not confidently identifiable" (0 or multiple
matches) rather than guessing. `backendChangeRequired` is always `false` -
this tool only ever looks at front-end rendering/markup.

## Report Generator + Baselines

Each run writes both a JSON report (everything, including raw category
details) and a Markdown report (human-readable, matching the "Overall
Fidelity / category breakdown / Status / deviations / fix plan / functional
results / evidence paths" structure) to `reports/`, plus a
`<page>.latest.json` pointer. `--save-baseline` promotes the current run's
score to `baselines/<page>.json`; every subsequent run (baseline or not)
reports the delta and flags a **regression** only past a 5-point threshold,
so ordinary content/copy changes don't cry wolf.

## Configuration

`config/pages.config.json` is the only file you edit to add a page - no
engine code changes needed:

```json
{
  "baseUrl": "http://localhost:5100",
  "sourceRoots": ["../../admin", "../../public-site"],
  "pages": [
    {
      "name": "admin-login",
      "route": "/admin/login.html",
      "reference": "../../public-site/design-ref/Phase1 08 AdminLogin.png",
      "viewport": { "width": 1440, "height": 900 },
      "additionalViewports": [{ "name": "mobile", "width": 390, "height": 844 }],
      "waitForSelector": ".login-box",
      "ignoreRegions": [{ "xPct": 0.0, "yPct": 0.0, "wPct": 0.2, "hPct": 0.05 }]
    }
  ]
}
```

All paths resolve relative to the config file itself. `ignoreRegions`
(fractions of image size) mask out known-dynamic areas - a live timestamp,
a rotating banner - from the visual diff so real rendering noise doesn't
get scored as a deviation.

## CLI usage

```bash
cd ui-judge
npm install                          # one-time
npm run judge -- --page admin-login  # audit a configured page
npm run judge -- --list              # list configured pages
npm run judge -- --page admin-login --width 390 --height 844   # ad-hoc viewport override
npm run judge -- --page admin-login --save-baseline            # promote this run to the baseline
npm run judge -- --page new-page --url /some/route --reference path/to/mock.png  # ad-hoc, no config entry
```

The equivalent `npm run ui:judge -- --page <name>` form also works from the
repo root via the thin pass-through `package.json` at the repository root.

Browser verification always runs **headed** - a real Chromium window opens
during a run; this is not configurable off, per the tool's own design brief.

## Supported inputs

- Reference: a screenshot/image (PNG/JPEG) at any resolution.
- Target: any URL/route reachable from wherever the CLI runs (this project's
  local dev server, a deployed environment, or any other project entirely).
- Viewport: primary + any number of named `additionalViewports` for
  responsive checks.
- Optional per-page: `waitForSelector`, `ignoreRegions`.

## Report format

See any file under `reports/*.md` for a live example, or the shape at the
top of `src/lib/reporter.js`. The JSON report includes everything the
Markdown report shows plus untruncated `categoryDetails` for programmatic
consumption (CI gating, dashboards, etc.).

## Limitations (stated plainly, not hidden)

- **No OCR/vision model in the loop.** The heuristic Design Analyzer can
  only measure pixels (dimensions, palette, luminance bands) - it cannot
  read text, identify a "button" as a button, or know what spacing was
  *intended*. High-confidence component/typography/spacing checks require
  an authored spec (see `tests/fixtures/*/fixture-*.json` for the schema).
- **"Section order" is presence-based today, not a true sequence check.**
  `sections.expectedOrder` verifies each listed landmark selector exists in
  the DOM; it does not yet verify they appear in that exact order (the
  visual pixel-diff and luminance-band correlation partially cover ordering
  indirectly, since a resequenced page also looks different).
- **Functional wiring detection is static, not exhaustive.** It recognizes
  inline `onclick` handlers and native form submit/reset wiring (this
  project's own admin/storefront pages use inline `onclick` extensively, so
  this maps well here) but cannot see handlers attached via
  `addEventListener` from an external script, which is common in
  component-framework apps. A "dead button" finding is a real signal on
  this codebase; on a different, framework-heavy project it may need the
  authored-spec path or a project-specific adapter instead.
- **Visual diff resizes to a common resolution** (`fit: "fill"`) when
  reference and actual screenshots differ in aspect ratio, which introduces
  minor stretch distortion into the pixel comparison - acceptable for a
  coarse fidelity signal, not pixel-perfect regression tooling.
- **No production data or real user interaction is ever exercised** - by
  design (see Safety/Scope in the original brief), so end-to-end business
  flows (checkout, refunds, etc.) are out of scope for this tool.

## Validation results

Run via `cd ui-judge && npm test` (7 tests, all passing as of this writing):

1. **`tests/integration/fixture-close-match.test.js`** - a faithful
   implementation of a small reference design (headed browser renders both
   the reference and the "actual" page via a local static server). Result:
   **100% overall, 0 findings**, confidence 100%, functional 100% - proves
   harmless noise (a live clock, a 2px CSS rounding difference) does not
   produce false positives.
2. **`tests/integration/fixture-deviations.test.js`** - the *same* reference
   design audited against a deliberately deviated implementation (moved +
   recolored CTA, missing section, broken image with no alt text, a dead
   button, an empty-href link, a wrong font-size, and horizontal overflow
   at two viewports). Result: **64% overall, 15 findings across all four
   severities (P0-P3)**, correctly sorted and each with a recommendation -
   proves the tool actually detects and prioritizes real problems rather
   than being fooled by "broadly similar" screenshots (see `reports/`
   sample or rerun for a fresh copy).
3. **Real page in this app**: `admin-login` audited against
   `public-site/design-ref/Phase1 08 AdminLogin.png` (live dev server,
   heuristic-only spec - no authored spec was written for this page).
   Result: **72% overall, confidence 43%**, status `NEEDS FIX`, with
   components/typography/spacing honestly excluded ("no usable evidence")
   rather than guessed, and one real P0 layout finding (structural/visual
   rhythm diverges from the mockup). Baseline save/regression-diff was also
   exercised against this page (`--save-baseline`, then a second run
   correctly reported `72% -> 72% (+0%)`, no false regression).

5 unit tests also cover scoring exclusion/renormalization, severity
threshold classification (including the "critical vs. non-critical missing
element" branch), color-distance parsing (`rgb()` vs hex), pixel-diff
correctness on synthetic images, and the fix-planner's file-location logic.

## Future extension points

- True sequence-aware layout ordering (longest-common-subsequence over DOM
  order vs. an authored `expectedOrder`), not just presence.
- A pluggable "wiring detector" adapter per framework (e.g. a
  React-DevTools-aware check) instead of the current static-attribute
  heuristic, for projects that don't use inline `onclick`.
- Accepting multiple reference images per page (e.g. per-breakpoint mockups)
  instead of one reference + generic overflow checks for responsiveness.
- A `--diff-only` mode that renders just the visual diff overlay for quick
  human review without the full report.
