# BASELINE

The committed record of `main`'s expected state. `npm run baseline` (`scripts/baseline.mjs`) recomputes
the actual state and **exits non-zero on any mismatch** — so a task can gate on it before starting, and a
drifted checkout or a dropped CHANGELOG entry is caught immediately.

**Re-anchor this file as the last step of every PR** (see `.github/PULL_REQUEST_TEMPLATE.md`): update the
three headings below to the PR's resulting `CHANGELOG.md` top-3, and `tests-passing` to the `npm test`
count after the PR's changes. Because it is committed, the anchor moves forward exactly as `main` does.

## Top 3 CHANGELOG headings

1. ## [Notifications] — Hebrew e-mail notifications from Apps Script (MailApp), fail-safe and deduped (PR 5)
2. ## [Budget] — עמידה בתקציב made auditable: one server spend rule, Israel-time months, visible data source (PR 4)
3. ## [Perf] — Read cache with stale fallback, one-call pages, deferred digest rebuild (PR 3)

## Test count

`npm test` (the CI gate, `node --test test/*.test.js` — excludes the live `smoke-live.js`):

tests-passing: 824
