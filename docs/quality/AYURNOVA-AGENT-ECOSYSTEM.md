# AyurNova Quality Agent Ecosystem

Central architecture document for AyurNova's independent quality agents -
audit-only tools that verify the product without ever changing application
behavior.

## Purpose

As AyurNova grows, more than one automated quality agent is needed: one for
visual fidelity, one for end-to-end wiring, and (planned) others for
security, requirements, regression, data integrity, performance, SEO, and
release readiness. Each agent answers a different question about product
quality. This document defines where they live, how they relate to each
other, and the rules that keep them independently useful as the set grows.

## Centralized structure

All quality agents live under one root, `quality-agents/`, each as its own
self-contained Node project (own `package.json`, dependencies, config,
tests, CLI):

```
quality-agents/
├── shared/                    reserved cross-agent infrastructure (see below) - currently empty
│   ├── contracts/
│   ├── evidence/
│   ├── severity/
│   ├── impact/
│   ├── workflows/
│   ├── baselines/
│   ├── reporting/
│   └── utils/
├── ui-judge/                  IMPLEMENTED - visual/behavioral fidelity auditor
├── wiring-guardian/           IMPLEMENTED - end-to-end product wiring auditor
└── requirements-guardian/     IMPLEMENTED - approved-requirements/business-rule compliance auditor
```

## Current agents

### UI Judge (`quality-agents/ui-judge/`)

Compares an approved design reference (screenshot/mockup) against a real
rendered page and produces an evidence-based fidelity score, ranked
deviations, and a fix plan. Audit-only - never edits application code.
Full docs: [docs/UI-JUDGE.md](../UI-JUDGE.md).

### Wiring Guardian (`quality-agents/wiring-guardian/`)

Verifies the product is actually wired end-to-end - UI -> API -> DB ->
business rule -> state -> event -> next module - across the full workflow
lifecycle, not just that individual pieces exist in isolation. Audit-first;
only applies deterministic, evidence-backed, low-risk fixes when explicitly
asked to (`--apply-fixes`), and always re-audits after fixing to confirm the
fix actually resolved the finding. Full docs:
[docs/WIRING-GUARDIAN.md](../WIRING-GUARDIAN.md).

### Requirements Guardian (`quality-agents/requirements-guardian/`)

Audits whether the implemented product matches what has already been
**approved** - product requirements, business rules, domain rules, API/data
contracts, state machines, and feature-flag rules recorded in this
repository's own approved documentation and code. Never invents a
requirement; an authoritative conflict or insufficient evidence is always
reported `NEEDS_REVIEW`, never silently resolved. Audit-only - no
`--apply-fixes` mode exists at all for this agent. Full docs:
[docs/REQUIREMENTS-GUARDIAN.md](../REQUIREMENTS-GUARDIAN.md).

## Planned agents (reserved, not implemented)

The following are reserved names in this architecture. They do **not** exist
as directories or code yet - no package.json, no tests, no CLI - only as an
entry in this document, so that adding one later means creating a new
sibling under `quality-agents/`, never retrofitting an existing agent.

| Agent | Question it will answer |
|---|---|
| `security-guardian` | Are there exploitable security gaps beyond Wiring Guardian's RBAC checks? |
| `regression-guardian` | Did this change break something that used to work? |
| `data-guardian` | Is stored data internally consistent and free of integrity drift? |
| `performance-guardian` | Does the product meet performance/latency budgets? |
| `seo-guardian` | Is public-facing content correctly optimized for discovery? |
| `release-guardian` | Is a given change set actually safe to ship? |

## Agent boundaries and independence

**An agent must never import another agent's internal implementation.**

```
BAD:  quality-agents/security-guardian  -->  quality-agents/ui-judge/src/...
BAD:  quality-agents/wiring-guardian    -->  quality-agents/security-guardian/src/...
```

Today, UI Judge, Wiring Guardian, and Requirements Guardian already satisfy
this: none imports another's source, none calls another to run, and each is
independently installable and runnable (own `package.json`, own `npm test`,
own CLI). This was verified for UI Judge/Wiring Guardian as part of their
relocation migration (see "Migration status" below), and Requirements
Guardian was built natively inside `quality-agents/` from the start with the
same independence property. This must remain true as new agents are added.

Any future interoperability between agents (e.g. a security finding that
references a wiring-graph edge) must go through `quality-agents/shared/`, or
through a standardized evidence/report file both agents can read/write
independently - never through direct source imports. Requirements Guardian's
one RBAC requirement follows exactly this pattern: it optionally reads
Wiring Guardian's own generated JSON report file if present, and never
imports its source or requires it to run first.

## The shared layer

`quality-agents/shared/` exists to hold genuinely cross-agent infrastructure
- not a dumping ground, and not populated preemptively. It stays empty until
a second agent needs the *exact* contract or utility an existing agent
already has, at which point that logic is extracted into the relevant
`shared/` subfolder and both agents depend on it instead of on each other.
See [quality-agents/shared/README.md](../../quality-agents/shared/README.md)
for the reserved subfolder list and the rule that governs adding to it.

## Execution model

Every agent is runnable two ways, and both must keep working after any
future change:

1. From the repo root, via a root `package.json` pass-through script
   (e.g. `npm run ui:judge --`, `npm run wiring:guardian --`).
2. Directly from its own directory (`cd quality-agents/<agent> && npm run
   <script>`), for local iteration without the root wrapper.

Each agent resolves its own project root via `import.meta.url` /
`__dirname` (never a hardcoded absolute path), and resolves the repository
root relative to its own directory. This is why the agent's location inside
the repo matters: moving an agent to a different nesting depth requires
updating however many `..` segments its own root-finding logic uses - this
migration updated exactly those spots (see "Migration status").

## Evidence model direction

Wiring Guardian already has a mature evidence model: every finding carries
`layer`, `category`, `file`, `route`, and `observed`, used both for
reporting and for baseline-vs-regression comparison by finding *shape*
(never by auto-incrementing id, since ids are not stable across runs). As
more agents are added, this shape - or a generalized version of it in
`quality-agents/shared/contracts/` - is the intended common language between
agents' reports, so a future dashboard or release-guardian could read every
agent's findings without understanding each agent's internals.

## Migration status

As of this document, the ecosystem has been established and the two
existing agents relocated into it from the repo root:

- `ui-judge/` -> `quality-agents/ui-judge/`
- `wiring-guardian/` -> `quality-agents/wiring-guardian/`

No application code, business logic, UI, authentication, payments, tax,
orders, inventory, shipping, refunds, APIs, or database schema was touched.
Only the two agents' own internal path-resolution logic and the root
`package.json` scripts were updated to account for the new nesting depth,
and their own documentation was updated to reflect their new location. See
the migration's final report for the full before/after test/CLI validation
matrix.

Planned agents remain unimplemented placeholders in this document only,
per the "No functional improvement" scope rule for this migration - adding
any of them is separate future work.
