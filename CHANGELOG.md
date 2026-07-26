# Changelog

All notable changes to EZone Logistics are documented here, per the project working rule
(documentation for every change and every commit). Newest first.

## [Increment 28] — Users, roles, and the new approval chain

**What:** Replaces the old Roy→Sandra threshold split with a role-based approval chain, adds a
`Users` sheet as the identity roster, and enforces roles server-side on every write action (not
just in the UI). Also a small header cleanup: the topbar drops the "E-ZONE" text for an emblem +
the app's Hebrew name.

**Added**
- `Users` sheet (`name | role | house | active`) — roles `coordinator / maintenance / field_ops /
  ops_manager / ceo`. `house` encodes scope: `*` = all houses, `cluster:a+b` = maintenance
  clusters, a literal house name = a coordinator's own house. Seeded (all active): רועי field_ops,
  אולגה ops_manager, סנדרה ceo, רמי maintenance (sharon), צחי maintenance (caesarea+north), and the
  four house coordinators (שירה/יעקב/אורן/אביב). `setupSheet()` seeds by name/key, so reruns add
  only missing rows — never duplicates.
- `ceo_ceiling` Config key (default blank = disabled). Intentionally **not** a numeric key: blank
  must stay blank (coercing `''`→`0` would route everything to the CEO).
- `src/roles.js` — pure identity + authorization module: `isActive`, `findUser`, `userCoversHouse`
  (all / cluster / literal), and `authorizeAction` (the per-action role matrix). Fail-closed:
  unknown or inactive user is authorized for nothing.
- `test/roles.test.js` — role rejection on every write action, fail-closed identity, coordinator
  cross-house rejection, and the cluster/literal/all scope resolution.
- `?action=users` feed (active users only) powering the form's submitter picker and the dashboard.
- An `inventoryCount` action — plumbing that proves the inventory role gate end-to-end
  (coordinator own-house only, maintenance backstop, ops roles anywhere); audit-logged for now.

**Changed**
- `src/approval.js` — the §6 chain (evaluated in order for arrival AND deferred wake-up):
  **(a)** חירום → `auto` (emergency bypass); **(b)** house is טרום-פתיחה OR `ceo_ceiling` set and
  `cost > ceo_ceiling` → `ceo`; **(c)** `cost > approval_threshold` → `ops_manager`;
  **(d)** otherwise, incl. blank cost → `field_ops`. `approvalRequired` is now derived from the
  chain (true iff it resolves to ops_manager/ceo); `canApprove(role, resolved)` gates by role
  (CEO can approve anything). `test/approval.test.js` rewritten to cover a–d incl. blank cost,
  `ceo_ceiling` disabled-vs-set, pre-opening→ceo, emergency bypass, and wake-up re-check.
- `apps-script/Code.gs` — the mirror of the above. Every write handler
  (`approve`/`reject`/`defer`/`assign`/`setStatus`/`createRequest`/`inventoryCount`) now looks up
  the acting user in `Users`, runs `authorizeAction_`, and fails closed on unknown/inactive. The
  approve/reject gate resolves the approver from the request's house pre-opening status + config;
  defer/assign/dispatch require field_ops+; coordinators are house-scoped on create/inventory.
  Emergency approvals are logged as an emergency bypass. `AuditLog` notes now carry the acting
  user's role.
- `src/request.js` — `created_by` is no longer a hardcoded roster; the pure builder only checks
  presence, and "any active user (coordinator own-house only)" is enforced server-side.
- `src/index.html` / `src/dashboard.html` — header: emblem (a teal package mark reusing the exact
  `--accent-grad`, ~30px desktop / 28px mobile) + "לוגיסטיקה", RTL-correct, no-wrap; the "E-ZONE"
  text is gone. Form: submitter picker loads from `?action=users` and locks the house for
  coordinators. Dashboard: user picker loads active users; approval buttons render **only** for the
  request's resolved approver (others see a "waiting for <role>" label); defer/assign/complete/close
  render only for dispatch-tier roles; a "ממתין לאישור שלי" toggle + counter and an ops-manager
  pending-count badge (Olga's entry point) were added.

**Why:** Approval routing is the core rule of the app; moving it from two named people to roles +
a Users roster lets the org change who fills each seat without code edits, and server-side
enforcement means the UI is a convenience, not the security boundary. The pre-opening and CEO-
ceiling rules give the CEO the specific oversight the business wants without funneling everything
through her.

**Security:** every write action is authorized server-side against the Users sheet and fails closed
on unknown/inactive users; coordinators are house-scoped server-side (cross-house writes rejected);
approve/reject is limited to the resolved approver role (plus CEO); all actions stay audit-logged,
now with the acting user's role.

**Deploy note:** rerun `setupSheet()` once (idempotent) to create/seed `Users` and add the
`ceo_ceiling` key, then repaste `apps-script/Code.gs` and redeploy a NEW version — Apps Script does
not auto-update from GitHub.

**Not yet done:** a real inventory-count sheet behind the `inventoryCount` gate; notifications/
reminders; smart batching.

---

## [Increment 3 · step 2] — Roy/Sandra dashboard (board + actions)

**What:** The dashboard where Roy and Sandra see requests by status and act on them. Wires to the
step-1 backend handlers.

**Added**
- `src/dashboard.html` — teal-themed RTL board: requests grouped by status (pending / deferred /
  approved-for-assignment / in-progress / done / rejected), summary counters, filters by house and
  maintenance lead, and a user picker (רועי / Sandra). Action buttons per request: approve, reject
  (with reason), defer-to-date, assign-to-lead, mark completed, close. The approve button is
  disabled and labelled "(סנדרה)" when the amount requires Sandra and the current user is Roy —
  mirroring the §6 rule client-side; the server enforces it regardless.

**Changed**
- `src/server.js` — now serves the dashboard at `/dashboard` (and `/dashboard.html`) in addition to
  the form at `/`, injecting `APPS_SCRIPT_EXEC_URL` into both.

**Why:** Roy needs a place to see open/closed/pending/deferred at a glance and act, and Sandra
needs the same board filtered to what she must approve. Client-side authority hints improve UX;
the step-1 server handlers are the real enforcement (status legality + approver tier + audit).

**Deploy note:** the updated `apps-script/Code.gs` (step 1) must be pasted into the Apps Script
editor and redeployed as a NEW VERSION for the dashboard actions to work live (Apps Script does not
auto-update from GitHub).

**Not yet done:** notifications/reminders (later increment); smart batching (later increment);
inspection module (§13, increment 4).

---

## [Increment 3 · step 1] — Approval engine + status transitions (backend)

**What:** The backend heart of the app — approval routing (§6) and status-transition rules, with
audit logging. No UI yet (the dashboard board + actions are steps 2–3).

**Added**
- `src/approval.js` — pure, testable module: `whoApproves` (≤ threshold → Roy, > threshold →
  Sandra, emergency → auto), `approvalRequired`, `canApprove` (Roy can't approve above threshold,
  Sandra can), `canTransition` (legal status moves), `validateApproval`.
- `test/approval.test.js` — 14 tests covering the threshold boundary (3000 → Roy, 3001 → Sandra),
  emergency bypass, blank cost → Roy, Sandra-vs-Roy authority, deferred wake-up re-check, and legal
  vs. illegal status transitions.

**Changed**
- `apps-script/Code.gs` — `doPost` is now a multi-action router (`createRequest`, `approve`,
  `reject`, `defer`, `assign`, `setStatus`). Mirrors the approval engine; each transition validates
  status + authority, updates the row, and writes an `AuditLog` entry (who/when/from→to).
  `createRequest` now also stamps the derived `approval_required` flag.

**Why:** Approval routing is the core rule of the app and must be locked by tests before any UI
sits on top of it. Building the engine as a pure module (like config/request) keeps it verifiable
under `node:test`; the dashboard (step 2) and its action buttons (step 3) call into it.

**Security:** every transition validated server-side (status legality + approver authority);
client cannot force an illegal state or approve above its tier; all actions audit-logged.

**Not yet done:** the dashboard board (step 2), the action buttons wired to these handlers (step 3).

---

## [Increment 2a] — Request submission form (no photo)

**What:** The Hebrew RTL form a maintenance lead uses to submit a request, plus the server-side
request-creation logic. A submitted request lands as a `דרישה` row. No approval logic yet (inc. 3).

**Added**
- `src/request.js` — pure, testable `validateNewRequest` + `buildNewRequest` + `generateRequestId`.
  Mirrors the `config.js` pattern so the rules run under `node:test`.
- `src/index.html` — Hebrew RTL form: submitted-by picker (controlled list), house dropdown from
  the live `?action=houses` feed, category/urgency segmented controls, description, location,
  and estimated cost (**blank allowed**). Client validation mirrors the server.
- `src/server.js` — zero-dependency Node static server; injects `APPS_SCRIPT_EXEC_URL` from env
  at serve time so the URL is never hardcoded or committed.
- `test/request.test.js` — covers blank cost accepted and kept blank, numeric cost stored as a
  number, unknown category/urgency/created_by rejected, status stamped `דרישה`, server id/time
  present, approval fields left blank.

**Changed**
- `apps-script/Code.gs` — `createRequest` now owns `id`, `status` (`דרישה`), and `created_at`
  server-side; the client no longer sends them. `validateNewRequest_` hardened against the
  controlled vocabularies (category, urgency, created_by). `approval_required` still left blank.
- `package.json` — added a `start` script (`node src/server.js`) so Railway can boot the
  frontend. `APPS_SCRIPT_EXEC_URL` (the form's submit target) is read from the environment at
  serve time and must be set as a Railway env var; it is already documented in `.env.example`.
- `src/index.html` — UI restyled to match the EZone family dark theme (cement-gray signature accent, amber/red urgency color-coding). Style/markup only; no JavaScript or form logic changed.
- `src/index.html` — Changed Logistics signature accent from cement-gray to teal. Style/markup only; no JavaScript or form logic changed.

**Why:** Requests must exist before approval routing can be meaningfully built or tested, so the
form precedes approval (inc. 3). Server-owned id/status removes collision risk and prevents the
client from spoofing lifecycle state; controlled `created_by` keeps later deferral-reminder
routing reliable.

**Security:** server-side stamping (client can't set status/id); inputs validated and
vocabularies whitelisted before write; exec URL injected from env, never committed.

**Not yet done:** optional photo upload (2b, wired to Drive); approval routing (inc. 3).

---

## [Increment 1] — Data model scaffold

**What:** Foundation for the whole app — the five-sheet Google Sheet structure, the Apps Script
read/write layer, seed data, and the supporting repo scaffolding.

**Added**
- `src/schema.js` — single source of truth for every sheet's column headers and the seed data
  (six houses, two internal maintenance leads, Config defaults). Shared by the Sheet setup
  script and the test suite so structure can't drift between them.
- `apps-script/setup.gs` — `setupSheet()` creates and seeds the five tabs (`Requests`, `Houses`,
  `Config`, `Technicians`, `AuditLog`) in a fresh Sheet, idempotently.
- `apps-script/Code.gs` — read/write layer only (no lifecycle/approval logic yet):
  `getConfig`/`getAllConfig` (with centralized type coercion), `getHouses`, `getTechnicians`,
  `getRequests`, `getRequestById`, `appendRequest`, `writeAuditEntry`; plus `doGet`/`doPost`
  router stub with input validation and least-privilege notes.
- `src/config.js` — pure, runtime-agnostic coercion helper (`coerceConfigValue`) extracted so it
  is unit-testable under Node without an Apps Script runtime. `Code.gs` mirrors the same rule.
- `test/` — foundation tests: schema integrity (six houses, correct cluster↔lead mapping
  including the Tzachi caesarea-vs-north split), and Config coercion (threshold returns a
  `number`, emergency-bypass returns a boolean).
- Repo scaffolding: `README.md`, `.gitignore`, `.env.example` (placeholder names only),
  `package.json`.

**Why:** Everything downstream — request submission, approval routing, assignment, batching —
reads and writes these sheets and depends on `Config` being typed correctly. Seeding `Config`
and the cluster/lead distinction now, and locking both with tests, means later increments have
nothing to hardcode and the two most error-prone rules (threshold typing, cluster ≠ lead) are
enforced structurally from day one.

**Security**
- No secrets committed. `.env.example` carries placeholder names only; real Sheet ID / Apps
  Script URL stay in the untracked `.env` (gitignored).
- Inputs validated in the `doPost` router stub before any write.
- Least-privilege intent documented in `Code.gs` (bind to this app's Sheet only).

**Not yet done (next increments):** request submission form, approval logic, assignment + status
flow, smart batching, notifications/reports.
