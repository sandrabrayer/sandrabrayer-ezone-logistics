# EZone Logistics

Standalone logistics, procurement, and maintenance app for the EZone balance houses (בתים מאזנים).
Owns the full lifecycle of a request — purchase / repair / replacement — from submission through
approval, execution, and closure.

- **Primary user:** Roy (רועי) — manages the domain day to day: routes, defers, assigns execution, closes.
- **Approver:** Olga (אולגה) — approves / rejects requests at any amount with her **approver code**.
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

## Approval rules — chain B v3 (summary)

**אולגה approves everything.** Routing returns a **role** (from `src/roles.js`) with two rules, evaluated in
order — no amount tier, no house-status branch, no ceo:

| # | Case | Role |
|---|---|---|
| 1 | Emergency (חירום) | Auto-approved, bypasses approval |
| 2 | Everything else (any cost, incl. blank) | `ops_manager` |
| — | Defer to date (נדחה לתאריך) | `field_ops` / `ops_manager`, any amount; on wake-up rules 1–2 apply again |

PR 2 removed the `field_ops` approval tier (≤ threshold) and the `ceo` role entirely (routing, role
predicates, the inspector list, the Users seed — an existing סנדרה row is set `active=FALSE` on the next
`setupSheet()` run, never deleted). `approval_threshold` stays in `Config` as a **legacy key that nothing
reads**; `ceo_ceiling` is no longer seeded. The routing logic is `src/approval.js`, mirrored verbatim in
`apps-script/Code.gs`.

Only `ops_manager` may approve/reject. Since the single login (PR 1) every session *is* ops_manager, so the
role alone never decides: approve / reject additionally require the **approver code** (next section).
Enforcement is server-side **and** in Code.gs — the UI may hide buttons, but hiding is never the control.

## Authentication — single login + approver code (PR 1)

**One password for the whole app.** `POST /api/login` with `{ pin }` (no name — there is no user picker)
checks the code against `SHARED_ACCESS_CODE` (constant-time) and returns an HMAC-signed session token for
the **one app identity**: name `רועי`, role `ops_manager`, no house scope. That identity is what gets
stamped as `created_by` on requests filed from the dashboard and as the AuditLog `by` on non-approval
actions (defer / assign / close / block). The login path **never reads the Users sheet** and never calls
Apps Script, so an upstream outage, a roster edit or a deploy window cannot break login or delay a page.

**Approvals need a second secret.** Every approve / reject that needs a human approver must carry the
**approver code** (`APPROVER_CODE`, held by אולגה). The dashboard asks for it on אישור / לא אושר (kept in
memory for that page only, never stored), Node verifies it constant-time and refuses a wrong or missing
code with **403** and no upstream call, then forwards it; `apps-script/Code.gs` verifies it **again**
against its own `APPROVER_CODE` Script Property (Node is never trusted) and records the approval as
`approved_by = אולגה` / AuditLog `by = אולגה`. Emergency (חירום) requests keep their auto approval: no code,
recorded by the session actor. Defer, dispatch, block and close never need the code. A client `by` field is
stripped from every write — the actor is always the token.

A wrong/empty login code returns the **same generic 401**; login is rate-limited to 8 attempts / 15 min
per IP (fail-closed); neither code is ever logged; the server **refuses to start** if `SHARED_ACCESS_CODE`
or `APPROVER_CODE` is unset, and Code.gs refuses every non-emergency approval while its `APPROVER_CODE`
property is unset. **Code.gs still trusts only the signed token + the code it verifies itself.**

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
| `SHARED_ACCESS_CODE` | Railway env | THE one login password for the whole app. Trimmed on load |
| `APPROVER_CODE` | Railway env **and** Apps Script Script Property | אולגה's approver code for approve / reject; identical in both places. Trimmed on load |
| `SESSION_SECRET` | Railway env **and** Apps Script Script Property | ≥ 32 chars; identical in both places |
| `SESSION_DAYS` | Railway env | Token lifetime in days |

Secrets live only in Railway env vars / Apps Script Script Properties — never in the repo. See
`.env.example`.

## Read cache (perf round-4)

`src/server.js` caches every Apps Script read except `users` in process memory (houses / config /
technicians 120 s; everything else 60 s), serves a stale copy for up to 10 minutes when Apps Script
fails (`X-Cache: STALE`, never a 502 while a copy exists), dedupes concurrent misses into one upstream
call, and clears every dynamic entry on any write. `?fresh=1` bypasses the cache. Responses carry
`X-Cache: HIT | MISS | STALE`. The `/management` POST is cached per period the same way. Each screen is
one upstream call cold and zero warm; digest rebuilds run off the write path (see `DEPLOY.md`).

## Develop

```bash
npm install      # no runtime deps yet; installs nothing beyond what's listed
npm test         # runs the node:test unit suite (test/*.test.js)
```

The suite covers the data model (`schema`), config coercion (`config`), request build/validation
(`request`), the approval engine + status transitions (`approval`), and the frontend HTTP server
routes + env-URL injection (`server`). Tests are fully offline — they never contact the live Google
Apps Script backend and contain no real secrets (the server tests use a dummy `.invalid` exec URL).

**Continuous integration:** `.github/workflows/test.yml` runs `npm test` on every pull request and
every push to `main`, across Node 18 and 20. A green check means the whole suite passed on both.

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

It checks: `GET /version` (the live commit on each leg); `GET /` returns 200 with the login shim;
`POST /api/login` with a bogus user returns a proper JSON **401** (the whole Node→Apps Script auth path
responds); and — when you also pass real credentials — one authenticated read succeeds end-to-end:

```bash
APP_URL=https://<your-deployed-app> SMOKE_USER='רועי' SMOKE_PIN='<password>' node test/smoke-live.js
```

### Version truth (which commit is live?)

`GET /version` returns the git SHA live on each leg — `{ node: { commit, builtAt }, appsScript: { commit } }`
— and every page (incl. login) shows a small gray `node <sha> · gs <sha>` footer. Each deploy is
**self-verifying**: `deploy-apps-script.yml` asserts the live `action=version == GITHUB_SHA`,
`verify-live.yml` asserts the live `/version` `node.commit == GITHUB_SHA`, and the service-worker cache
name carries the commit so every deploy purges stale caches. See **DEPLOY.md → Version truth**.

Exit code is non-zero if any check fails, so it can gate a deploy. This is the guard for the login
regressions (#59, #61-branch, #62) that all passed unit tests but broke in production.

## Apps Script deployment

1. Create a new Google Sheet (this app's own — not the Dashboard one).
2. Extensions → Apps Script → paste `apps-script/Code.gs` and `apps-script/setup.gs`.
3. Run `setupSheet()` to create and seed the tabs. It is idempotent: re-running never duplicates a
   row and never overwrites an edited one. **Re-run it after upgrading** — PR 2 sets an existing
   סנדרה row to `active=FALSE` (retired role; the row is kept).
4. Per-user passwords are gone: `setUserPin()` is **retired** (it now throws) and `Users.pin_hash` is a
   legacy, append-only column that nothing writes or reads — the one login password lives only in the
   Railway `SHARED_ACCESS_CODE`, the approver code in `APPROVER_CODE`.
5. Project Settings → Script Properties → add `SESSION_SECRET` with the **same** value as the Node
   `SESSION_SECRET` env var (so Code.gs can verify session tokens), and `APPROVER_CODE` with the **same**
   value as the Node `APPROVER_CODE` env var (so Code.gs can verify the approver code independently).
   The old `STAFF_WRITE_TOKEN` property is no longer used and can be removed.
6. Deploy → New deployment → Web app. Record the deployment ID and `/exec` URL.
7. Put the `/exec` URL and the other required env vars in the frontend `.env` (see `.env.example`)
   — **never commit real secrets.**

After every redeploy, verify via DevTools → Network → Response (ecosystem discipline).

## Working rules

Documentation per commit · security best practices · tests for every feature.
See `CHANGELOG.md` and the spec in the Claude Project knowledge.
