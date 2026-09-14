# AyurNova Requirements Guardian

An independent, self-contained product-quality agent that audits whether the
implemented AyurNova product actually matches what has already been
**approved** - product requirements, business rules, domain rules, API/data
contracts, state machines, and feature-flag rules recorded in this
repository's own approved documentation and code. It lives at
[`quality-agents/requirements-guardian/`](../quality-agents/requirements-guardian/)
with its own `package.json` and tests, and runs standalone via
`npm run requirements` inside that directory (or `npm run
requirements:guardian` from the repo root).

## Purpose, and how it differs from UI Judge / Wiring Guardian

AyurNova now has three independent quality agents:

```
AyurNova Product Quality System
    +-- UI Judge              "Does it LOOK/BEHAVE right?"        (quality-agents/ui-judge/)
    +-- Wiring Guardian       "Does the PRODUCT actually WORK end-to-end?"  (quality-agents/wiring-guardian/)
    +-- Requirements Guardian "Does the implementation match what was APPROVED?" (quality-agents/requirements-guardian/)
```

UI Judge compares a rendered page against a design reference. Wiring
Guardian traces UI -> API -> DB -> business rule -> state -> event and
verifies the product is actually wired together end-to-end. Requirements
Guardian asks a different question entirely: given what the business/product
already **decided and approved** (in `docs/`, `docs/product-strategy/`, and
the code's own stated invariants), does the current implementation still
match it? It does not do screenshot comparison (UI Judge's job) or verify
that a button calls the right API (Wiring Guardian's job) - it verifies that
an already-approved requirement (e.g. "COD must be gated server-side", "the
order status enum is exactly these six values", "notify() must never block
the transaction that triggered it") is still true today, was not accidentally
changed, and that nothing unapproved was quietly implemented in its place.

The three agents may reference the same underlying evidence but each is
independently runnable - Requirements Guardian does not import from or
depend on `quality-agents/ui-judge/` or `quality-agents/wiring-guardian/`
executing first (see "Ecosystem interoperability" below for the one
explicit, optional exception).

## The non-negotiable principle: approved requirements are the authority

Requirements Guardian never invents a product decision. Its authority order,
highest first:

1. Explicitly approved current product requirements/business decisions
2. Approved domain/business rules
3. Approved architecture/workflow/state rules
4. Security requirements
5. Feature-flag requirements
6. API/data contracts
7. Current implementation
8. Tests
9. Agent inference

Implementation does **not** become the requirement merely because the code
currently behaves that way, and a passing test does not itself constitute
product authority. When the Guardian cannot determine something safely, it
reports `NEEDS_REVIEW` - it never guesses, and it never silently resolves a
conflict between two authoritative sources by picking one.

## Requirement registry

Every requirement lives in
[`src/registry/requirements.data.js`](../quality-agents/requirements-guardian/src/registry/requirements.data.js)
as a record with a real citation - a `sourceReference.file`/`line` pointing
at the actual doc or code that established it. Nothing in that file is
invented; growing the registry means finding a real approved decision and
citing it, not writing a plausible-sounding rule. As of this writing it holds
28 requirements curated from `docs/AYURVEDICSTORE-PHASE-0/1/2/3-*.md` and
`docs/product-strategy/AYURNOVA-PHASE-9*.md`, spanning COD/payments/legal
CMS/orders/shipments/returns/notifications/tax/RBAC/discovery/architecture.

Each record carries:

- `category` - one of `PRODUCT_REQUIREMENT`, `BUSINESS_RULE`, `DOMAIN_RULE`,
  `APPROVED_DECISION`, `API_CONTRACT`, `DATA_CONTRACT`, `STATE_RULE`,
  `FEATURE_FLAG_RULE`, `SECURITY_REQUIREMENT`, `UX_BEHAVIOR_REQUIREMENT`,
  `FUTURE_FEATURE`, `DEPRECATED_REQUIREMENT`, `HISTORICAL_REFERENCE`, or
  `UNKNOWN`.
- `lifecycle` - `ACTIVE`, `DEPRECATED`, `FUTURE`, `HISTORICAL`, `CONFLICTED`,
  or `NEEDS_REVIEW`.
- `sourceReference` - the file/line this requirement is traced to. Required;
  a record without one fails structural validation
  ([`src/registry/schema.js`](../quality-agents/requirements-guardian/src/registry/schema.js))
  and is dropped from the active set, never silently included half-formed.
- `checkerId` (optional) - names a function in
  [`src/compliance/checkers/index.js`](../quality-agents/requirements-guardian/src/compliance/checkers/index.js)
  that performs the automated check. A requirement without one is not
  mechanically verifiable (business content authorship, live database state,
  another agent's scope) and is reported `NEEDS_REVIEW`/`NOT_APPLICABLE`
  with an explicit reason - never a fabricated pass.

`npm run requirements -- scan` lists the full registry with its
lifecycle/category/priority, and fails (`structuralErrors`) if any record is
malformed or a duplicate id/evidence pair exists.

## Lifecycle-aware compliance

[`src/compliance/runCompliance.js`](../quality-agents/requirements-guardian/src/compliance/runCompliance.js)
applies different rules depending on lifecycle, so a deliberately deferred
feature is never reported as a defect:

| Lifecycle | Checker's job | Never reported as |
|---|---|---|
| `ACTIVE` | Verify the requirement still holds | - |
| `FUTURE` | Detect **premature/unapproved** implementation only | "missing" (absence is correct) |
| `DEPRECATED` | Detect **residual old behavior** only | anything else |
| `HISTORICAL` | Not evaluated at all | anything |
| `CONFLICTED` | Never auto-resolved | a clean pass |
| `NEEDS_REVIEW` | Runs its checker (if any) for supporting evidence only | a clean pass |

Compliance statuses: `IMPLEMENTED`, `PARTIALLY_IMPLEMENTED`,
`NOT_IMPLEMENTED`, `ACCIDENTALLY_CHANGED`, `CONFLICTING`, `AFFECTED`,
`UNAPPROVED`, `NEEDS_REVIEW`, `NOT_APPLICABLE`. A `FUTURE` requirement whose
checker finds it already implemented is reported `UNAPPROVED` (spec example:
if a "deferred" feature quietly shipped without approval, that is itself a
finding). A `LOW`-confidence violation is always downgraded to
`NEEDS_REVIEW` - a static-analysis lead is never allowed to stand as a hard
P0/P1 defect on its own.

Coverage is not compliance: a requirement being *located* in the registry
does not mean it passes, and a checker running does not mean the underlying
business rule is actually satisfied - each finding's evidence connects
Requirement -> Implementation -> Observed behavior explicitly.

## Checkers: read-only, evidence-cited, honest about their own limits

Every checker in `src/compliance/checkers/index.js` reads real files through
[`src/discovery/codeDiscovery.js`](../quality-agents/requirements-guardian/src/discovery/codeDiscovery.js)
- the only module that touches the filesystem - and returns a verdict with
concrete `evidence: [{file, line, detail}]`. Some examples:

- `codFeatureFlagServerEnforced` - confirms `server/src/routes/public.js`
  actually rejects a `payment_method:"cod"` checkout when
  `settings.trust_badges.cod` is `false`, not just that the storefront badge
  is hidden.
- `secretsFailFast` / `seedAdminPasswordSafety` - confirm
  `server/src/config.js` / `server/src/scripts/seedAdmin.js` fail fast on a
  missing/weak/placeholder secret and never echo it. The password-echo check
  specifically looks for `${password}` interpolated into a log call, not
  merely the word "password" appearing in a safe instructional message - an
  earlier version of this checker false-positived on exactly that distinction
  (see `tests/unit/checkers.test.js`).
- `ordersStatusEnum` / `paymentStatusEnum` / `refundStatusEnum` /
  `returnRequestStatusEnum` / `shipmentStatusEnum` - each extracts the LIVE
  CHECK constraint for its own table (scoped to that table's own `create
  table (...)` block or `alter table ... add constraint` clause) across
  `supabase/schema.sql` + every migration in applied order, and compares it
  to the approved enum. Table-scoping matters: an earlier version of this
  checker searched for the column name (`status`) unscoped and wrongly
  matched `payments`/`refunds`/`return_requests` against **shipments'**
  enum, since every lifecycle table happens to share that column name - a
  real false positive this build hit and fixed during its own first
  self-audit (see "Initial audit results" below).
- `notifyNeverThrows` - confirms `server/src/notify/notificationService.js`'s
  own documented invariant (its own docstring: "notify() NEVER throws") by
  checking the function body is try/wrapped and its catch never re-throws.
- `deterministicNoAiDependency` / `noMarketplaceSellerTables` - negative
  checks: no AI/ML/LLM SDK reference anywhere under `server/src`, no
  seller/vendor/marketplace table in the schema. Absence of evidence *for* a
  prohibited thing is the expected, healthy state here.
- `rbacDeferredToWiringGuardian` - deliberately does **not** implement its
  own RBAC sweep (Wiring Guardian's security-engine already owns that scope
  in full - duplicating it would violate the ecosystem's independence rule
  in the opposite direction, "don't re-verify another agent's whole job").
  It optionally reads Wiring Guardian's own latest JSON report if present,
  and reports `NEEDS_REVIEW` (never a silent pass) if that report doesn't
  exist.

A missing file, an unparseable pattern, or an ambiguous match never crashes
and never fabricates a pass - it degrades to `NEEDS_REVIEW` at `LOW`
confidence with an explicit reason.

## Conflict detection

[`src/conflict/detectConflicts.js`](../quality-agents/requirements-guardian/src/conflict/detectConflicts.js)
surfaces (never resolves): structural registry errors, duplicate
ids/evidence, and any requirement explicitly marked `CONFLICTED`. Per the
non-negotiable principle above, a genuine conflict between two authoritative
sources is reported with both sides cited, and the Guardian stops there -
resolving it is a human decision.

## Change impact analysis

`npm run requirements -- impact [--base <ref>]` diffs the working tree
(uncommitted + untracked changes by default, or against a given ref) and
maps changed files to affected requirements at three confidence levels
(never claims impact without evidence):

- **DIRECT** - the file is a known target of that requirement's own compliance
  checker (a maintained map in
  [`src/impact/changeImpact.js`](../quality-agents/requirements-guardian/src/impact/changeImpact.js)),
  or is the requirement's own cited source file.
- **INDIRECT** - the file's path matches one of the requirement's scope tags
  (word-boundary matched, e.g. the tag `cod` does **not** match
  `codeDiscovery.js` - another real false positive this build hit and fixed).
- **POSSIBLE** - a schema/migration file changed and the requirement is a
  `STATE_RULE`/`DATA_CONTRACT` category, worth a re-check even with no direct
  file match.

## Baseline and regression

`npm run requirements -- audit --baseline` snapshots every requirement's
verification result. `npm run requirements -- regression` (or any `audit`
once a baseline exists) compares by `(requirementId, compliance)` identity:
an unchanged `NOT_IMPLEMENTED`/`NEEDS_REVIEW` requirement is an accepted,
already-known limitation, not a new regression - only a requirement whose
compliance *changed for the worse* (or whose severity escalated) is reported
as new.

## Fix planning - audit only, no exceptions

Requirements Guardian has **no** `--apply-fixes` mode and no `SAFE_AUTO_FIX`
bucket at all, unlike Wiring Guardian. Every finding is classified
`NEVER_AUTO_FIX` (anything touching payment/tax/refund/order/inventory/auth/
RBAC/schema/migration/secrets) or `REVIEW_REQUIRED` (everything else) by
[`src/fix-planner/planFixes.js`](../quality-agents/requirements-guardian/src/fix-planner/planFixes.js).
`npm run requirements -- fixplan` emits a deterministic Fix Plan (problem,
affected files, why it violates the requirement, suggested direction, risk,
required validation, `humanApprovalRequired: true` on every entry) - never an
actual patch, and never applies anything.

## Ecosystem interoperability

Requirements Guardian can optionally read
`quality-agents/wiring-guardian/reports/wiring-guardian.latest.json` (only
for the one RBAC requirement above) if that report exists on disk, but never
imports Wiring Guardian's source, never requires it to run first, and
operates fully standalone if that file is absent (reporting `NEEDS_REVIEW`
instead of silently skipping). See
[`docs/quality/AYURNOVA-AGENT-ECOSYSTEM.md`](quality/AYURNOVA-AGENT-ECOSYSTEM.md)
for the shared independence rule all three agents follow.

## CLI

```bash
npm run requirements                              # full audit (default)
npm run requirements -- scan                      # list the registry only, no compliance run
npm run requirements -- audit                     # full compliance audit + report
npm run requirements -- audit --baseline          # audit, then save as the regression baseline
npm run requirements -- impact                    # change-impact analysis (uncommitted vs HEAD)
npm run requirements -- impact --base <ref>       # change-impact analysis vs a specific ref/commit
npm run requirements -- regression                # audit + compare vs saved baseline
npm run requirements -- fixplan                   # emit a Fix Plan (audit-only)
npm run requirements -- --scope <tag>             # scope any mode to one requirement scope tag
npm test                                          # Guardian's own unit tests
```

From the repo root: `npm run requirements:guardian -- <args>`.

## Reports

Every audit/impact/regression run writes a timestamped JSON+Markdown pair to
`quality-agents/requirements-guardian/reports/`, plus
`requirements-guardian.latest.{json,md}`. `reports/baseline/baseline.json` is
the regression baseline. Both are generated, gitignored artifacts (same
convention as `ui-judge/reports/` and `wiring-guardian/reports/`). The
report's headline **Decision** is one of `PASS`, `PASS WITH WARNINGS`,
`BLOCKED`, or `NEEDS REVIEW` - `BLOCKED` requires a confirmed
(non-`LOW`-confidence) `P0` violation; `NEEDS REVIEW` fires on any open
`P0`/`P1` `NEEDS_REVIEW` item even with zero confirmed violations - the
Guardian never reports a fake `PASS` over unresolved ambiguity.

## Initial audit results (first self-run against this repository)

The first real audit against this repository found the registry's 28
requirements resolved to: 18 `IMPLEMENTED`, 8 `NOT_APPLICABLE` (correctly
deferred/historical/deprecated - not defects), and exactly 2 genuine
`NEEDS_REVIEW` items, both already known, open business/ops decisions
documented in `docs/product-strategy/AYURNOVA-PHASE-9-*-AUDIT.md`:
`CORS_ORIGIN` still defaults to a wildcard (an ops config action, not a code
defect) and production-vs-dev Supabase project identity has never been
explicitly confirmed by the business. Zero `P0`/confirmed violations -
**Decision: NEEDS REVIEW** (correctly not a fake `PASS`, since two open
questions remain; correctly not `BLOCKED`, since neither is a confirmed code
defect).

Three real false positives were found and fixed during this same first
self-audit (all covered by regression tests in `tests/unit/`):

1. The enum checker was not table-scoped, so `payments.status`,
   `refunds.status`, and `return_requests.status` all wrongly matched
   `shipments.status`'s CHECK constraint (same column name, different
   table) - fixed by scoping the search to each table's own `create table`
   block.
2. The password-echo checker flagged a safe instructional log message
   (`"...log in with the password you set..."`) merely for containing the
   word "password" - fixed to only match actual `${password}` variable
   interpolation.
3. The `notify()` never-throws checker's "outer try" detection used too
   short a fixed character window and false-negatived against the real
   file's long destructured parameter list - fixed with a wider window.

This mirrors Wiring Guardian's own documented experience of finding and
fixing real bugs in its first pass (see `docs/WIRING-GUARDIAN.md`) - an
honest account of what a static-analysis-first build actually needs to get
right, not a claim of having been correct on the first attempt.

## Limitations

- Checkers are regex/string-pattern based against this repo's actual,
  consistent coding conventions - not a full SQL/JS parser. Every checker's
  confidence field is explicit about this; a `LOW`-confidence result is
  never allowed to stand as a hard violation.
- Static analysis cannot see live database state (e.g. whether an admin has
  actually published real legal-page content, or the current value of
  `settings.tax_profile.gst_registered`) - those requirements are correctly
  reported `NEEDS_REVIEW` with an explicit "this requires a live check"
  reason, never a fabricated pass or fail.
- The RBAC requirement intentionally does not implement its own sweep and
  depends on Wiring Guardian's own report when present - this is a scope
  boundary, not an oversight.
- The registry (28 requirements) is a curated starting set traced to the
  documentation read during this build (Phase 0-3, Phase 9 audits); it is
  not a claim of having captured every approved decision ever made in this
  project. Growing it further means finding and citing another real
  approved source, per "Requirement registry" above.
