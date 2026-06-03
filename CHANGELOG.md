# Changelog

All notable changes to EZone Logistics are documented here, per the project working rule
(documentation for every change and every commit). Newest first.

## [Increment 6] — Inspection reports + context fields

**What:** A reports page that turns each saved inspection into a clean, printable report (save as
PDF from the browser), plus background/context fields on the inspection, and two fixes.

**Added**
- `src/reports.html` — `/reports`: list of past inspections (house, date, inspector, # findings,
  defect badge) → click opens a formatted report (background block, three domains with summaries and
  findings grouped by location, defects flagged, links to any request a defect became) → "הדפסה /
  שמירה כ-PDF" via browser print (works from any computer, no backend).

**Changed**
- `src/schema.js` + `apps-script/setup.gs` — `Inspections` gains `patient_count`, `staff_present`,
  `start_time`, `cleaner_present` (the "background" of Olga's report).
- `apps-script/Code.gs` — `createInspection` persists the new fields.
- `src/inspection.html` — new fields on the form (patient count = 0–40 dropdown; start time; staff
  present; cleaner/hours); inspector picker reduced to **אולגה / רועי**; save-validation message now
  scrolls into view (fixes the "nothing happens when house is empty" confusion).
- `src/server.js` — serves `/reports`.

**Why:** Olga used to hand-write and email a report; the app now generates it. Context fields make
the report match what she actually records. PDF (browser print) chosen for now — zero backend, works
everywhere; Word export can come later if needed.

**Deploy note:** `Inspections` got new columns, and `setupSheet()` now patches missing columns onto
existing sheets (appends any new schema column it finds absent, without touching data). So: paste the
updated `Code.gs` + `setup.gs`, run `setupSheet()` once (it adds the four new `Inspections` columns),
redeploy New Version.

---

## [Increment 5] — Edit & delete requests

**What:** Roy or Sandra can delete a request (one quick, audited action — for clearing test/junk
rows), and anyone can edit a request's details before it's approved.

**Added**
- `src/edit.js` — pure rules: `canDelete` (Roy/Sandra only), `canEdit` (only `דרישה` /
  `ממתין לאישור`), editable-fields whitelist.
- `test/edit.test.js` — delete authority, edit-only-before-approval, editable-fields whitelist.
- `apps-script/Code.gs` — `deleteRequest` (authorized, audit-logged before row removal) and
  `editRequest` (pre-approval only; revalidates vocabularies; recomputes `approval_required`).
- `src/dashboard.html` — "עריכה" button (pre-approval requests) and "מחיקה" button (Roy/Sandra),
  with a confirm on delete.

**Why:** the lifecycle was forward-only with no way to fix a typo or remove test data. Edit is
locked after approval so cost/scope can't be changed to bypass the §6 routing; delete is owner-only
and audit-logged so there's still a record of what was removed.

**Security:** delete authorized server-side (Roy/Sandra); deletion audit-logged before removal;
edit revalidates against controlled vocabularies and recomputes the approval flag, and is rejected
once a request is approved.

---

## [Increment 4] — Inspections module (בקרות, §13)

**What:** Olga's on-site inspection brought into the app as a checklist, with physical defects
routed into the existing request pipeline via suggest-then-confirm.

**Added**
- `src/schema.js` — three new sheets (`Inspections`, `InspectionFindings`, `ChecklistItems`),
  inspection vocabularies (domains, finding types, severity), and a seeded fixed checklist drafted
  from Olga's real report (16 items across treatment / cleanliness / kitchen).
- `src/inspection.js` — pure logic: validate inspection + findings, `canBecomeRequest` (only
  unlinked physical defects), `findingToRequestPayload` (blank cost → routes to Roy).
- `test/inspection.test.js` — 10 tests: validation, finding-type rules, process-note can't convert,
  defect→request payload shape.
- `src/inspection.html` — teal RTL checklist screen: inspector/house/date, three domain cards with
  fixed checklist items + per-domain summary + ad-hoc findings (process_note vs physical_defect,
  location, suggested category).
- `apps-script/Code.gs` — read actions (`checklist`, `inspections`, `findings`) and write handlers
  (`createInspection`, `addFinding`, `confirmFinding`). `confirmFinding` creates a request through
  the SAME `buildNewRequest_`/approval path and links the finding ↔ request, audit-logged.
- `apps-script/setup.gs` — provisions + seeds the three new sheets (checklist seeded).
- `src/server.js` — serves `/inspection`.
- `src/dashboard.html` — "ליקויים מבקרות — לאישור לדרישה" section: unconfirmed physical defects
  with a "פתח דרישה" button (Roy confirms → request created via the pipeline).

**Why:** Inspection defects are repair/replacement requests; suggest-then-confirm lets Olga flag
them and Roy decide which become tracked requests, all flowing through the existing §6 approval
rule (origin doesn't change the rules). Ad-hoc inspections, in-app record (no .docx). Email alerts
for problem findings are deferred to the notifications increment (data carries severity/type ready).

**Security:** all inspection inputs validated + vocabularies whitelisted server-side; a defect can
only convert once (linked_request_id guard); request creation reuses the audited pipeline.

**Deploy note:** the updated `Code.gs` and `setup.gs` must be pasted into Apps Script; run
`setupSheet()` once to add the three new sheets + checklist, then redeploy as a New Version.

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
