# AyurNova Wiring Guardian

Independent product-wiring auditor for the AyurNova AyurvedicStore codebase.

UI Judge asks *"does it look/behave right?"*. Wiring Guardian asks *"is the
product actually connected and working, end to end?"* - button -> API ->
database -> business rule -> state -> event -> next module -> user/admin
outcome, at every scale from a single click up to a full customer lifecycle.

Full architecture, workflow-level model, and design rationale:
[docs/WIRING-GUARDIAN.md](../docs/WIRING-GUARDIAN.md).

## Quick start

From the repo root: `npm run wiring:guardian -- <args>` (pass-through, same
convention as `npm run ui:judge`). Or directly:

```bash
cd wiring-guardian
npm run guardian                                   # full audit, JSON+MD reports
npm run guardian -- --workflow customer.checkout.purchase
npm run guardian -- --module payments
npm run guardian -- --apply-fixes                  # apply SAFE_AUTO_FIX findings, then re-audit
npm run guardian -- --baseline                      # save this run as the regression baseline
npm run guardian -- --regression                    # (default behaviour) compare against the saved baseline
npm test                                            # Guardian's own unit tests
```

Reports land in `reports/` as timestamped JSON+Markdown pairs, plus
`wiring-guardian.latest.{json,md}`. The regression baseline lives at
`reports/baseline/baseline.json`. Both are generated artifacts (gitignored,
like `ui-judge/reports/` and `ui-judge/baselines/`) - re-run `--baseline`
after intentionally accepting a new state.

## What it does NOT do

- No visual/screenshot comparison - that's UI Judge's job (`ui-judge/`).
- No schema, RBAC-policy, payment, refund, or tax logic changes, ever -
  those are always `REVIEW_REQUIRED` or `NEVER_AUTO_FIX` (see
  `src/fix-planner/planFixes.js`).
- No live payment-gateway/webhook traffic is simulated; workflows that need
  that are marked `NOT_EXECUTED - ENVIRONMENT LIMITATION` and point at the
  real coverage that already exists in `server/dev-harness/`.

## Layout

```
config/                 workflows.config.json, modules.config.json, states.config.json - all data-driven
src/discovery/           static parsers: server routes, frontend calls, DB schema, notify() events
src/contract-engine/      Layer 1 (UI -> API) - frontend/backend path matching
src/security-engine/      Layer 5 (RBAC) - admin auth + permission + customer-data gating
src/feature-flag-engine/  Layer 4 (business rules) - COD/GST flags enforced where they must be
src/cache-engine/         SSR page-cache keys vs their discovered invalidation path
src/integration-engine/   every PROVIDERS[x].method() dispatch actually implemented by that provider
src/state-engine/         curated state machines cross-checked against the live schema
src/module-graph/         Layer 3 (module -> module) via FK-derived edges
src/workflow-engine/       walks config/workflows.config.json against all of the above
src/severity/, src/evidence/   finding shape + transparent per-category health scoring
src/fix-planner/           SAFE_AUTO_FIX / REVIEW_REQUIRED / NEVER_AUTO_FIX policy + registered fixers
src/baseline/, src/reporter/   regression compare + JSON/MD report rendering
bin/wiring-guardian.js     CLI
tests/                    Guardian's own deterministic unit tests (node tests/runAll.js)
```
