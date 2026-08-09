<!-- Fill in the summary, then complete the checklist. Delete nothing — reviewers read the checklist. -->

## What & why

<!-- One or two sentences: what changes and the reason. -->

## How

<!-- The mechanism. Name the files/functions touched and any contract/schema impact. -->

## Regression-hardening checklist

- [ ] **Baseline verified** — `npm run baseline` passes (top-3 CHANGELOG headings + test count match `BASELINE.md`).
- [ ] **Tests green** — `npm test` passes locally (0 fail); new behavior has a test that locks it.
- [ ] **CHANGELOG updated** — an `## [Unreleased] — …` entry describes this change.
- [ ] **`BASELINE.md` updated** — re-anchored to this PR's resulting top-3 headings + test count (do this as the last step so the number is final).
- [ ] **Mirror drift** — if `src/*.js` shared logic changed, its `apps-script` mirror changed too (the `test/mirror-drift.test.js` guards stay green).

## `setupSheet()` needed after merge?

<!-- A schema/header change (a new/renamed column) requires a one-time setupSheet() run on the live sheets. -->

- [ ] **No** — no sheet header/schema change.
- [ ] **Yes** — a column was added/renamed; run `setupSheet()` after merge. Column(s): `…`
