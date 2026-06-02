# Changelog

All notable changes to EZone Logistics are documented here, per the project working rule
(documentation for every change and every commit). Newest first.

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
