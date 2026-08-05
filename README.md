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

## Approval rules — chain B v2 (summary)

Routing returns a **role** (from `src/roles.js`) by **amount only**. Rules are evaluated in order:

| # | Case | Role |
|---|---|---|
| 1 | Emergency (חירום) | Auto-approved, bypasses approval |
| 2 | Cost > `approval_threshold` | `ops_manager` |
| 3 | Otherwise (incl. blank/unknown cost) | `field_ops` |
| — | Defer to date (נדחה לתאריך) | `field_ops` / `ops_manager` / `ceo`, any amount |

Increment 31 removed the pre-opening→`ceo` and `ceo_ceiling` branches: **pre-opening houses route
by amount exactly like open houses.** The `ceo` role constant and the `ceo_ceiling` Config key are
kept but **dormant** — routing does not read them. On a deferral wake-up the amount is re-checked
through rules 1–3. `approval_threshold` (= ₪3,000) lives in `Config` — **configurable, never
hardcoded**. The routing logic is `src/approval.js`, mirrored verbatim in `apps-script/Code.gs`.

Only the role a request resolves to may approve/reject it (the CEO may always approve); enforcement
is server-side **and** in Code.gs — the UI may hide buttons, but hiding is never the control.

## Authentication — two tiers (increment 31)

Login is identity-based (matching the ezone-managers / ezone-staffing standard). `POST /api/login`
with `{ name, pin }` returns an HMAC-signed session token carrying the user's **name + role +
house/cluster scope + issued-at**. The tier is data-driven off the `Users` sheet:

- **Tier A — managers (רועי, אולגה):** each has a **personal password**, hashed (salted PBKDF2) in
  the `Users.pin_hash` column and set via the `setUserPin()` Apps Script helper. Their password is
  verified against **their own** `pin_hash`.
- **Tier B — everyone else (coordinators + maintenance):** the **shared `APP_PIN`**.
- **סנדרה (ceo):** no password, **cannot log in** (row stays in `Users`).

Wrong tier/credential combinations all return the **same generic 401** — the response never reveals
which tier a name belongs to. Login is rate-limited to 8 attempts / 15 min per IP (fail-closed), and
the PIN/password is never logged. Passwords are verified **only in Node** at login; **Code.gs trusts
only the signed token** (it does not re-hash passwords). The hash-bearing roster is returned by Apps
Script only to a server-to-server HMAC proof — the world-callable `/exec` never leaks `pin_hash`.

- Every data request is Bearer-authenticated; the token is never in a query string, the page source,
  or persisted browser storage (memory only). Tokens expire after `SESSION_DAYS` days.
- `apps-script/Code.gs` verifies the **same** token independently against its `SESSION_SECRET`
  Script Property — the Node layer is never trusted.

### Restricted staff view (tier B)

A tier-B session is scoped by the token, enforced server-side and in Code.gs (never UI-only):

- **Reads:** `requests` are filtered to the user's in-scope houses — a coordinator sees their own
  house, a maintenance lead sees their cluster(s)' houses (resolved from `Houses`). Out-of-scope
  rows are filtered out server-side, not merely hidden. Manager-only reads (dashboard/reports/
  inventory/inspections/technicians) return **403**; the `users` roster is manager-only and never
  includes `pin_hash`.
- **Writes:** `createRequest` must target a house in the actor's scope (from the token) or it is
  **403**'d; approve / reject / defer / assign / dispatch / batching are refused for tier B (403,
  no state change, no success AuditLog row).

### Required environment variables (fail-closed at startup)

The server **refuses to start** if any is missing or empty — set them **before** deploying:

| Var | Where | Notes |
|---|---|---|
| `APPS_SCRIPT_EXEC_URL` | Railway env | This app's `/exec` URL |
| `APP_PIN` | Railway env | **Tier-B shared PIN only** (coordinators + maintenance). Tier-A managers use personal `pin_hash` passwords |
| `SESSION_SECRET` | Railway env **and** Apps Script Script Property | ≥ 32 chars; identical in both places |
| `SESSION_DAYS` | Railway env | Token lifetime in days |

Secrets live only in Railway env vars / Apps Script Script Properties — never in the repo. See
`.env.example`.

## Develop

```bash
npm install      # no runtime deps yet; installs nothing beyond what's listed
npm test         # runs the node:test unit suite (test/*.test.js)
```

> **Test runner note:** this scaffold uses Node's built-in `node:test` (zero dependencies).
> `npm test` runs `node --test test/*.test.js`, so `test/smoke-live.js` (a live-URL script, not a
> unit test) is deliberately excluded. CI (`.github/workflows/test.yml`) runs `npm test` on every
> PR and every push to `main` — nothing merges or lands red.

### Post-deploy smoke test (run after EVERY merge)

Unit tests mock Apps Script, so they cannot catch a broken **live** chain (Node on Railway → Apps
Script `/exec` 302 → Sheets) or a mixed-version deploy window. After each merge, hit the real app:

```bash
APP_URL=https://<your-deployed-app> node test/smoke-live.js
```

It checks: `GET /` returns 200 with the login shim; `POST /api/login` with a bogus user returns a
proper JSON **401** (the whole Node→Apps Script auth path responds); and — when you also pass real
credentials — one authenticated read succeeds end-to-end:

```bash
APP_URL=https://<your-deployed-app> SMOKE_USER='רועי' SMOKE_PIN='<password>' node test/smoke-live.js
```

Exit code is non-zero if any check fails, so it can gate a deploy. This is the guard for the login
regressions (#59, #61-branch, #62) that all passed unit tests but broke in production.

**Automated** — `.github/workflows/smoke-live.yml` runs this on **every push to `main`** (after a short
delay for Railway to finish deploying) and via manual **Run workflow** dispatch. Set these repository
secrets under **Settings → Secrets and variables → Actions**:

| Secret | Required | Value |
|---|---|---|
| `APP_URL` | yes | the deployed URL, e.g. `https://ezone-logistics.up.railway.app` |
| `SMOKE_USER` | optional | a real login name (e.g. `רועי`) — enables the end-to-end authenticated-read check |
| `SMOKE_PIN` | optional | that user's password/PIN |

Without `APP_URL` the job fails loudly (so it can't silently pass). Without `SMOKE_USER`/`SMOKE_PIN` the
authenticated-read check is skipped and the other two checks still run. The GitHub runner has open egress,
so it can reach Railway (the Claude Code sandbox cannot — its egress policy blocks arbitrary hosts).

## Apps Script deployment

1. Create a new Google Sheet (this app's own — not the Dashboard one).
2. Extensions → Apps Script → paste `apps-script/Code.gs` and `apps-script/setup.gs`.
3. Run `setupSheet()` to create and seed the tabs. It is idempotent: re-running never duplicates a
   row and never overwrites an edited one. **Re-run it after upgrading** — increment 30 adds the
   `Users` sheet and the `ceo_ceiling` Config key; **increment 31 appends the `Users.pin_hash`
   column** (existing rows keep their data).
4. **Set the tier-A managers' passwords** (increment 31): in the Apps Script editor run
   `setUserPin('רועי', '…')` and `setUserPin('אולגה', '…')` once each. It hashes (salted PBKDF2) and
   writes `pin_hash`; it never logs the plaintext. Without this, neither manager can log in.
5. Project Settings → Script Properties → add `SESSION_SECRET` with the **same** value as the Node
   `SESSION_SECRET` env var (so Code.gs can verify session tokens). The old `STAFF_WRITE_TOKEN`
   property is no longer used and can be removed.
6. Deploy → New deployment → Web app. Record the deployment ID and `/exec` URL.
7. Put the `/exec` URL and the other required env vars in the frontend `.env` (see `.env.example`)
   — **never commit real secrets.**

After every redeploy, verify via DevTools → Network → Response (ecosystem discipline).

## Working rules

Documentation per commit · security best practices · tests for every feature.
See `CHANGELOG.md` and the spec in the Claude Project knowledge.
