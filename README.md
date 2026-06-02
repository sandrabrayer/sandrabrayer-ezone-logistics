# EZone Logistics

Standalone logistics, procurement, and maintenance app for the EZone balance houses (בתים מאזנים).
Owns the full lifecycle of a request — purchase / repair / replacement — from submission through
approval, execution, and closure.

- **Primary user:** Roy (רועי) — manages the domain, approves up to the threshold, assigns execution.
- **Secondary approver:** Sandra — approves requests above the cost threshold.
- **UI:** Hebrew, right-to-left (RTL).

## Architecture

Fully standalone, matching the Outpatient pattern. Does **not** touch the shared
Dashboard/Managers `Code.gs` or their deployments.

- **Repo:** `sandrabrayer/ezone-logistics`
- **Backend:** Google Apps Script (`apps-script/Code.gs`) bound to its own Google Sheet
- **Frontend:** Node.js
- **Deploy:** Railway → own URL for Roy
- **Source of truth:** GitHub repo + Google Sheet (cloud). Each PC needs only a browser.

Houses are **self-owned** — seeded into this app's own `Houses` sheet, not read from the
Dashboard feed (pre-opening houses already have activity and aren't all in that feed yet).

## Data model (Google Sheet)

Five tabs: `Requests`, `Houses`, `Config`, `Technicians`, `AuditLog`.
Header definitions live in `src/schema.js` (single source of truth shared by the Sheet
setup script and the tests). See `apps-script/setup.gs` to provision a fresh Sheet.

## Approval rules (summary)

Routing depends **only** on amount, every time:

| Case | Who |
|---|---|
| Cost ≤ threshold (or blank/unknown) | Roy |
| Cost > threshold | Sandra |
| Emergency (חירום) | Auto-approved, bypasses approval |
| Defer to date (נדחה לתאריך) | Roy, any amount |

Threshold lives in `Config.approval_threshold` (₪3,000) — **configurable, never hardcoded**.

## Develop

```bash
npm install      # no runtime deps yet; installs nothing beyond what's listed
npm test         # runs the node:test suite in test/
```

> **Test runner note:** this scaffold uses Node's built-in `node:test` (zero dependencies).
> When you open the Claude Code session, confirm what `sandrabrayer/ezone-outpatient` uses
> (`cat package.json` → `scripts`/`devDependencies`). If Outpatient standardizes on another
> runner, swap it here — only the imports and `npm test` script change, not the test logic.

## Apps Script deployment

1. Create a new Google Sheet (this app's own — not the Dashboard one).
2. Extensions → Apps Script → paste `apps-script/Code.gs` and `apps-script/setup.gs`.
3. Run `setupSheet()` once to create and seed the five tabs.
4. Deploy → New deployment → Web app. Record the deployment ID and `/exec` URL.
5. Put the `/exec` URL in the frontend `.env` (see `.env.example`) — **never commit the real URL.**

After every redeploy, verify via DevTools → Network → Response (ecosystem discipline).

## Working rules

Documentation per commit · security best practices · tests for every feature.
See `CHANGELOG.md` and the spec in the Claude Project knowledge.
