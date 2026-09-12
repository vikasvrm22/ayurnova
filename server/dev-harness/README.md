# DEV Harness

Lightweight developer-facing verification tools. Lives inside the DEV
(application) repository because it's for day-to-day development use, not
for QA automation - see `../../ayurvedicstore-qa/` (sibling directory,
separate git repository) for the full QA Harness (Playwright-based
smoke/API/E2E/security/regression suites).

## What's here

- **`healthcheck.js`** - read-only smoke check. Hits a running server
  instance's key routes (health, homepage, shop, static pages, 404
  behaviour, the new public catalog API, admin-auth gating) and prints
  PASS/FAIL per route. Never writes anything.

  ```bash
  npm run dev:healthcheck
  # or against a different instance:
  BASE_URL=https://staging.example.com npm run dev:healthcheck
  ```

- **`seed-test-data.js`** - deterministic local test data. **Does nothing
  by default.** Only inserts rows when `DEV_HARNESS_ALLOW_WRITE=true` is
  explicitly set, and even then only ever adds one clearly-marked,
  `draft`-status fixture category + product (drafts never appear on the
  public storefront - every public query filters `status = 'published'`).
  Idempotent - safe to run repeatedly.

  ```bash
  DEV_HARNESS_ALLOW_WRITE=true npm run dev:seed-test-data
  ```

## Environment separation (DEV / QA / PRODUCTION)

This project currently has **one** configured Supabase project (the one in
`server/.env`). Phase 0 could not confirm whether that project is a
throwaway dev project or already considered production (see Phase 0
report §21, open question #1) - the user opted to rotate its credentials
themselves rather than resolve that question in this session.

Until a dedicated QA/staging Supabase project exists:

- **DEV** = this repository, run locally (`npm start` / `npm run dev`)
  against whichever Supabase project is in `server/.env`.
- **QA** = the separate `ayurvedicstore-qa` repository's Playwright suite,
  intended to run against a DEV server instance (`QA_BASE_URL`, see that
  repo's README) - **not** against a separate database today, because
  none is configured. Its tests are written to be safe to run against
  the same database DEV uses (read-mostly; the one write path it exercises,
  the DEV-harness fixture above, is additive/idempotent/never-published),
  but this is a documented limitation, not a real QA/PROD split.
- **PRODUCTION** = wherever this app is eventually deployed. No production
  deployment exists yet (Phase 0 found no CI/CD, no hosting configured).

**Do not** point `seed-test-data.js`, the QA harness, or any automated
test at a database you cannot afford to have extra draft rows appear in.
None of this project's automation performs destructive writes (update/
delete) against pre-existing data, but until a real separate QA project
exists, "safe to run" rests on that additive-only discipline, not on
environment isolation.
