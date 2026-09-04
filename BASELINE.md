# BASELINE

The committed record of `main`'s expected state. `npm run baseline` (`scripts/baseline.mjs`) recomputes
the actual state and **exits non-zero on any mismatch** — so a task can gate on it before starting, and a
drifted checkout or a dropped CHANGELOG entry is caught immediately.

**Re-anchor this file as the last step of every PR** (see `.github/PULL_REQUEST_TEMPLATE.md`): update the
three headings below to the PR's resulting `CHANGELOG.md` top-3, and `tests-passing` to the `npm test`
count after the PR's changes. Because it is committed, the anchor moves forward exactly as `main` does.

## Top 3 CHANGELOG headings

1. ## [Approvals] — אולגה approves everything (chain B v3); סנדרה / ceo removed (PR 2)
2. ## [Auth] — Single login + approver code (PR 1): one password for the app, אולגה approves with a second code
3. ## [Data/Docs] — רעננה הפרדס (pardes) opened: status flips to `open` across every enumeration

## Test count

`npm test` (the CI gate, `node --test test/*.test.js` — excludes the live `smoke-live.js`):

tests-passing: 732
