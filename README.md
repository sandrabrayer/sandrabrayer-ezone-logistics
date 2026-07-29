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

## Approval rules — chain B (summary)

Routing returns a **role** (from `src/roles.js`), not a person. Rules are evaluated in order:

| # | Case | Role |
|---|---|---|
| 1 | Emergency (חירום) | Auto-approved, bypasses approval |
| 2 | House is pre-opening (טרום-פתיחה), **or** `ceo_ceiling` set and cost exceeds it | `ceo` |
| 3 | Cost > `approval_threshold` | `ops_manager` |
| 4 | Otherwise (incl. blank/unknown cost) | `field_ops` |
| — | Defer to date (נדחה לתאריך) | `field_ops` / `ops_manager` / `ceo`, any amount |

On a deferral wake-up the amount is re-checked through rules 1–4 from scratch. Both values live in
`Config` (`approval_threshold` = ₪3,000; `ceo_ceiling` = blank/disabled) — **configurable, never
hardcoded**. The routing logic is `src/approval.js`, mirrored verbatim in `apps-script/Code.gs`.

Only the role a request resolves to may approve/reject it (the CEO may always approve); enforcement
is server-side **and** in Code.gs — the UI may hide buttons, but hiding is never the control.

## Authentication

Login is identity-based (increment 30, matching the ezone-managers / ezone-staffing standard):

- `POST /api/login` with `{ name, pin }` → an HMAC-signed session token carrying the user's name +
  role + issued-at. The role comes from the `Users` sheet (source of truth); the PIN is the shared
  gate (constant-time compare). Login is rate-limited to 8 attempts / 15 min per IP (fail-closed).
- Every data request is Bearer-authenticated; the token is never put in a query string, the page
  source, or browser storage that could leak it (it lives in memory only). Tokens expire after
  `SESSION_DAYS` days — expired / tampered / missing tokens are rejected with 401.
- `apps-script/Code.gs` verifies the **same** token independently against its `SESSION_SECRET`
  Script Property — the Node layer is never trusted. (The old shared `STAFF_WRITE_TOKEN` is removed.)

### Required environment variables (fail-closed at startup)

The server **refuses to start** if any is missing or empty — set them **before** deploying:

| Var | Where | Notes |
|---|---|---|
| `APPS_SCRIPT_EXEC_URL` | Railway env | This app's `/exec` URL |
| `APP_PIN` | Railway env | Shared login PIN |
| `SESSION_SECRET` | Railway env **and** Apps Script Script Property | ≥ 32 chars; identical in both places |
| `SESSION_DAYS` | Railway env | Token lifetime in days |

Secrets live only in Railway env vars / Apps Script Script Properties — never in the repo. See
`.env.example`.

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
3. Run `setupSheet()` to create and seed the tabs. It is idempotent: re-running never duplicates a
   row and never overwrites an edited one. **Re-run it after upgrading to increment 30** to add the
   new `Users` sheet and the new `ceo_ceiling` Config key.
4. Project Settings → Script Properties → add `SESSION_SECRET` with the **same** value as the Node
   `SESSION_SECRET` env var (so Code.gs can verify session tokens). The old `STAFF_WRITE_TOKEN`
   property is no longer used and can be removed.
5. Deploy → New deployment → Web app. Record the deployment ID and `/exec` URL.
6. Put the `/exec` URL and the other required env vars in the frontend `.env` (see `.env.example`)
   — **never commit real secrets.**

After every redeploy, verify via DevTools → Network → Response (ecosystem discipline).

## Working rules

Documentation per commit · security best practices · tests for every feature.
See `CHANGELOG.md` and the spec in the Claude Project knowledge.
