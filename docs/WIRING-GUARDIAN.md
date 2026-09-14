# AyurNova Wiring Guardian

An independent, self-contained product-quality agent that audits whether the
AyurNova product is actually **wired together** - from a single button
through complete end-to-end business workflows - not just whether individual
APIs, modules, or database tables exist in isolation. It lives at
[`quality-agents/wiring-guardian/`](../quality-agents/wiring-guardian/) with its own `package.json` and
tests, and runs standalone via `npm run guardian` inside that directory.

## Purpose, and how it differs from UI Judge

AyurNova now has two independent quality agents:

```
AyurNova Product Quality System
    +-- UI Judge         "Does it LOOK/BEHAVE right?"   (quality-agents/ui-judge/)
    +-- Wiring Guardian   "Does the PRODUCT actually WORK end-to-end?"  (quality-agents/wiring-guardian/)
```

UI Judge compares a rendered page against an approved design reference and
produces a visual-fidelity score. Wiring Guardian never does screenshot
comparison, pixel scoring, or design-reference analysis - that responsibility
stays entirely with UI Judge. Wiring Guardian instead traces:

```
UI action -> API -> business rule -> database state -> event -> next module -> user/admin outcome
```

...and validates that chain at five scales at once (micro click, feature,
full business transaction, cross-module, and full customer/admin lifecycle -
see "Workflow levels" below).

The two agents may reference the same underlying evidence (routes, schema,
business rules) but Wiring Guardian is independently runnable - it does not
import from or depend on `quality-agents/ui-judge/` executing first, and it was built
without modifying UI Judge's own code or reports.

## Architecture

```
wiring-guardian/
  config/
    workflows.config.json   data-driven workflow registry (section "Workflow registry")
    modules.config.json     route-file -> product-module mapping (real routes, not invented)
    states.config.json      curated lifecycle state machines, cross-checked against the live schema
  src/
    discovery/               static parsers - the ONLY place that reads app source/schema
      serverDiscovery.js      parses server/src/index.js (mounts + phase-comment tags) + every route file
      routeDiscovery.js       per-file Express route parser (method, path, middleware, inline guards)
      frontendDiscovery.js    parses admin/ + public-site/ (HTML + JS) for every API call site
      schemaDiscovery.js      parses supabase/schema.sql + migrations/*.sql for tables/CHECK constraints/RLS/FKs
      notifyDiscovery.js      finds every notify("event", ...) call site across routes/services/notify
    contract-engine/          Layer 1 (UI -> API): frontend call <-> backend route matching
    security-engine/          Layer 5 (RBAC): admin auth+permission, customer-data gating
    feature-flag-engine/      Layer 4 (business rules): COD/GST flags enforced at every required layer
    cache-engine/              section 17: SSR page-cache keys vs their discovered invalidation path
    integration-engine/        section 19: every provider dispatched through PROVIDERS[x].method() implements it
    state-engine/             states.config.json validated against the LIVE schema (drift detection)
    module-graph/             Layer 3 (module -> module) via FK-derived structural edges
    workflow-engine/          walks workflows.config.json, evaluates each step against all of the above
    evidence/Finding.js        one finding shape every engine emits (see "Evidence model")
    severity/classify.js       severity ordering + transparent per-category/overall health scoring
    fix-planner/                SAFE_AUTO_FIX / REVIEW_REQUIRED / NEVER_AUTO_FIX policy + fixers/
    baseline/, reporter/        regression comparison + JSON/Markdown report rendering
  bin/wiring-guardian.js       CLI
  tests/                      Guardian's own deterministic unit tests (fixtures, no live server/DB)
```

Every discovery parser is regex/string based against the repo's actual,
consistent coding conventions (documented at the top of each file) - not a
full JS/AST parser. This is a deliberate trade-off: it is transparent about
its own limits (every finding carries a `confidence` field), and low-
confidence findings never move the health score (see "Evidence model").

## Workflow levels

Every workflow in `config/workflows.config.json` declares a `level`:

| Level | Meaning | Example in this repo |
|---|---|---|
| MICRO | one click/one call | `customer.cart.reprice_lookup` |
| FEATURE | one self-contained feature | `customer.wishlist.full_cycle` |
| BUSINESS | one complete business transaction | `customer.checkout.purchase`, `business_rule.cod_gate` |
| CROSS_MODULE | spans admin + customer + >=2 modules | `admin.order.fulfillment`, `customer.return.refund_cycle` |
| FULL_LIFECYCLE | discovery through final resolution | `full_lifecycle.new_customer_purchase_to_resolution` |

A `FULL_LIFECYCLE` workflow lists the lower-level workflows it composes
(`composesWorkflows`) rather than re-describing every step - so the full
customer journey (discover -> cart -> checkout -> payment -> order -> admin
fulfillment -> shipment -> delivery -> return -> refund -> final state) stays
a thin composition of already-verified pieces, not a duplicate 20-step block.

## Workflow registry (`config/workflows.config.json`)

Every workflow is data, not code. Each step has a `check` the workflow
engine evaluates against real discovery evidence:

- `{"type":"route", "method", "path", "expectActor"?}` - a matching backend
  route must exist (and optionally classify as the expected actor type).
- `{"type":"table", "table"}` - the table must exist in the live schema.
- `{"type":"state", "entity", "value"}` - the value must be listed in
  `states.config.json` **and** currently allowed by the live CHECK constraint.
- `{"type":"event", "event"}` - a `notify("event", ...)` call site must exist
  somewhere under `server/src/{routes,services,notify}`.
- `{"type":"featureFlag", "flag"}` - defers to the feature-flag engine's own
  findings for that flag.
- `{"type":"rbacSweep", "scope"}` - defers to the RBAC engine's findings for
  that scope (`admin-auth` / `admin-permission` / `customer-auth`).

A workflow is `CONFIRMED` (every step passed), `PARTIAL` (some failed),
`BROKEN` (all failed), or `NOT_EXECUTED` when its `testStrategy` is declared
`NOT_EXECUTED_ENV_LIMITATION` up front - used for workflows that genuinely
require a live payment sandbox or running server (e.g.
`customer.payment.prepaid_verify`, which instead points at the real coverage
already in `server/dev-harness/test-phase9b-payment-retry-cap.js`). A
`NOT_EXECUTED` workflow is never silently reported as passing.

## Module graph

Nodes are product modules (`config/modules.config.json`, one entry per real
route-file grouping - catalog, checkout-orders, payments, returns-refunds,
shipping-fulfillment, etc.). Edges are derived automatically: if module A's
routes touch table X, module B's routes touch table Y, and `schemaDiscovery`
found a real foreign key from X to Y, an edge A -> B exists. A module with
zero edges into or out of it is flagged as a low-confidence lead to check
(some are legitimately standalone reference data - the finding never asserts
a defect, only that it's worth a human glance).

## State engine

`config/states.config.json` is curated product knowledge (which values a
lifecycle column allows, which service/route is authoritative for each
value, which table holds transition history) extracted from the real code
and its own comments - e.g. the locked "shipment status is authoritative,
not a direct order-status edit" rule from `server/src/routes/orders.js`.
Every audit run cross-checks that file against the **live** schema
(`schemaDiscovery`'s CHECK-constraint scan): if the schema has drifted from
what's curated, that is itself a finding, not a silent pass. Notably: this
schema has a dedicated transition-audit table (`shipment_events`, with
`previous_status`/`new_status`) for shipments only - orders/payments/returns
have no equivalent history table, which the state engine surfaces as a
documented limitation rather than assuming one exists.

## Cache and integration wiring

Two smaller, evidence-only engines round out the layers from the build
brief:

- **`src/cache-engine/checkCache.js`** (section 17) discovers every
  `cached(key, ...)` call site in the SSR page router and classifies each
  key as content-derived (e.g. `` `legal:${slug}:${page.updated_at}` `` -
  self-invalidating by construction, since editing the row changes the key)
  or static. For a static key, it parses the discovered invalidator
  function's own body (`invalidateCatalogCache()` in `pages.js`) for which
  literal keys/prefixes it actually clears, and flags any static key that
  function doesn't cover. This is fully generic - it does not hardcode
  "faq" or any other key name, it reads whatever `pages.js` actually
  contains.
- **`src/integration-engine/checkIntegrations.js`** (section 19) parses
  `integrationsAdmin.js`'s generic `PROVIDERS[provider].method(...)`
  dispatch pattern and the `PROVIDERS` map itself (including the spread of
  `SHIPPING_PROVIDERS` from `shipping/registry.js`), then verifies every
  registered provider module actually exports every method the dispatch
  calls unconditionally. A method the route itself guards with
  `typeof x.method !== "function"` before calling (this repo's own pattern
  for `runDiagnostics`, documented in `integrationsAdmin.js` as
  "currently Razorpay [only]") is correctly treated as optional-per-provider,
  not a universal requirement - calibrated against a real false-positive
  this build hit and fixed during its own first audit.

## Evidence model

Every finding (`src/evidence/Finding.js`) carries: `layer`, `module`,
`workflow`, `file`/`line`, `route`, `observed` vs `expected`, `evidence`
(the literal grep/match that produced it), `severity` (P0-P3), `confidence`
(high/medium/low), `category`, `recommendedFix`, `autoFixed`, and
`verification`. Severity is never inflated for something merely imperfect -
P3 is reserved for genuinely low-impact/exploratory leads.

**Confidence gates the score, not the report.** A `confidence:"low"`
finding (this build only ever assigns that to leads like "no frontend caller
found for this route - confirm intentionally") is always shown in full in
the Markdown/JSON report, but does not subtract from any category's health
score - a batch of such leads should read as "worth a glance," never as "this
layer is broken," which is exactly the kind of misleading single number
section 32 of the build brief warns against.

### Health scoring (transparent, never a hidden single number)

```
categoryScore = 100 - (P0*40 + P1*15 + P2*5 + P3*1), over confidence:high|medium findings only, floored at 0
overallScore  = min(all category scores)   -- never an average; one broken layer caps the whole number
```

Six categories are always reported separately (Module, Contract, State,
Security, FeatureFlag, Workflow) alongside the overall score, and any
category with an open P0 sets `anyCritical: true` on the overall result -
impossible to hide behind a high aggregate number.

## Safe self-healing policy

`src/fix-planner/planFixes.js` classifies every finding:

- **NEVER_AUTO_FIX** (default for anything matching payment/refund/tax/GST,
  `server/src/auth/`, `server/src/integrations/`, `supabase/` schema or
  migrations, or `.env`) - regardless of severity.
- **REVIEW_REQUIRED** - the default for everything else, including every
  P0/P1 finding that isn't on the explicit whitelist below. SAFE_AUTO_FIX is
  opt-in only; nothing reaches it by falling through.
- **SAFE_AUTO_FIX** - only an explicit `{category, filePattern} -> fixerId`
  whitelist, each backed by a real, tested fixer under
  `src/fix-planner/fixers/`. Two are registered from this build's first real
  audit (see "Initial audit results" below): `codRadioGate` and
  `adminStaffPath`.

`--apply-fixes` applies every `SAFE_AUTO_FIX` finding with a registered
fixer, then **re-runs the entire discovery+engine pipeline from scratch**
(not a diff heuristic) and only reports a finding as resolved if it
genuinely no longer reproduces on that fresh pass - the AUDIT -> FIX -> RE-
AUDIT loop the build brief requires, never "applied" without verification.

## CLI

```bash
npm run guardian                                    # full audit
npm run guardian -- --workflow <id>                  # scope to one workflow
npm run guardian -- --module <name>                  # scope to one module
npm run guardian -- --apply-fixes                    # apply safe fixes, then re-audit
npm run guardian -- --baseline                        # save this run as the regression baseline
npm run guardian -- --regression                      # (default) compare against the saved baseline
npm test                                              # Guardian's own unit tests
```

## Reports and baseline

Every run writes a timestamped JSON+Markdown pair to `quality-agents/wiring-guardian/reports/`
plus `wiring-guardian.latest.{json,md}`. `reports/baseline/baseline.json` is
the regression baseline (compared by finding *shape* - layer+category+file+
route+observed - not by auto-incrementing id, since ids aren't stable
across runs). Both are generated artifacts, gitignored the same way
`quality-agents/ui-judge/reports/` and `quality-agents/ui-judge/baselines/` already are in this repo.

## Initial audit: Phase 1-2 baseline

Per the build brief, Phase 1-2 (customer commerce foundation + payments) is
the **initial baseline scope only** - discovery and every check ran against
the FULL repository (188 backend routes across 37 files, 51 database
tables, 168+ frontend call sites), not just files named after those phases,
because a Phase 1-2 workflow's real dependencies (inventory/batches from
Phase 5A, returns from Phase 6B, shipping from Phase 8B, etc.) already exist
and had to be traced honestly rather than ignored.

Two real, evidence-backed defects were found and safely auto-fixed:

1. **`admin/users.html` called the wrong API path.** Every staff-management
   action (list/change-role/deactivate/invite) called `Api.get("/staff")`
   etc, which resolves to `GET /api/admin/staff` - but the actual routes are
   defined inside `adminAuthRoutes.js`, mounted at `/api/admin/auth`, so the
   real path is `/api/admin/auth/staff`. The entire Admin > Users page was
   silently 404ing on every action. Fixed by correcting the four call sites
   (`src/fix-planner/fixers/adminStaffPath.js`).
2. **The COD checkout radio wasn't gated by the same flag its own trust
   badge already reads.** `public-site/cart.html` fetches
   `settings.trust_badges.cod` and correctly hides the "COD Available" trust
   badge when it's off, but the actual COD radio button was always rendered
   and pre-selected regardless - a customer could still choose COD, submit,
   and only then get a late "Cash on Delivery is currently unavailable"
   rejection (the server-side gate in `server/src/routes/public.js`, the
   Phase 9B P1-3 fix, was and remains correct - this was a client-side
   business-rule wiring gap, not a security hole). Fixed by reusing the same
   already-fetched settings response to hide the option and auto-select
   prepaid (`src/fix-planner/fixers/codRadioGate.js`).

A third real gap was found and left `REVIEW_REQUIRED` (not auto-fixed, by
design):

3. **Global FAQs have no cache-invalidation path at all.** `GET /faq` is
   cached under the static key `"faq"` with the same TTL as Home/Shop, but
   `invalidateCatalogCache()` (the function Phase 9F P1-7 added specifically
   to fix this exact class of bug for products/categories) only clears
   `home`/`sitemap`/`shop:*` - `faqs.js`'s admin CRUD routes never call it,
   and the FAQ cache key has no content-derived component (unlike the legal-
   page cache, which embeds `page.updated_at`). An admin publishing or
   editing a global FAQ can leave the public `/faq` page stale for up to the
   cache TTL. Left as `REVIEW_REQUIRED` rather than auto-fixed: the correct
   fix touches two files (adding the "faq" key to `invalidateCatalogCache`'s
   shared clear-list in `pages.js`, plus calling it from `faqs.js`), and that
   shared function is relied on by other routes - exactly the kind of
   small-blast-radius-but-shared-code change this build treats as a human
   call, not an auto-fix, even though the fix pattern itself is proven and
   low-risk.

The first two were verified resolved by a full re-audit before being
reported as fixed. Everything else found in the initial run was P3, low-confidence, and
correctly left as informational leads (mostly "no frontend caller found for
this admin/public route" - legitimate reasons are common: SSR-only pages,
endpoints not yet wired to a second admin surface, or a dynamic path this
scanner's regex-based matching can't fully resolve, e.g. a route built from
a computed variable rather than a literal template segment).

## Future phase expansion

Nothing in this architecture assumes Phase 1-2 is permanent. Discovery
already reads the entire repo; `config/workflows.config.json`,
`modules.config.json`, and `states.config.json` are plain data files -
adding Phase 3+ coverage (Ayurveda discovery/knowledge, personalization,
manufacturing/batch/QC depth, wellness recommendations, etc.) means adding
more entries to those three files and, where a genuinely new check type is
needed, a new `check.type` case in `src/workflow-engine/runWorkflows.js`.
No engine, discovery pass, or reporting code needs to change shape as phase
coverage grows - the phase tag on a workflow/module is metadata only, never
a scope boundary the code enforces.
