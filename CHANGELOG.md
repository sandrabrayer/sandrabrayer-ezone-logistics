# Changelog

All notable changes to EZone Logistics are documented here, per the project working rule
(documentation for every change and every commit). Newest first.

## [Increment 11] — UI fixes, per-house defect consolidation, weekly work orders

**Repo repair (pre-existing corruption on `main`)**
- `src/config.js` had been overwritten with the full CHANGELOG text (commit "Update config.js"),
  breaking `config.test.js`. Restored the correct module from the increment-1 scaffold.
- `rating.test.js` and `defer.test.js` were committed under a broken nested path
  `src/test/test/` with wrong import depth. Moved to `test/` (imports now resolve).
- Removed the stray GitHub attachment link from the top of this CHANGELOG.

**Dashboard (`src/dashboard.html`)**
- Removed the dead "לא ידוע" cost label from request cards (cost field no longer exists).
- Renamed the approved group "מאושר — להקצאה" → "מאושר וממתין להקצאה לאחראי".
- Removed the dead-end suggested-defects board block; replaced with a **per-house consolidation
  panel** of open inspection defects, de-duplicated by text (no duplicate requests), each row
  linking straight to opening a request. Now loads inspections to resolve each finding's house.
- All dates shown as DD/MM/YYYY (new `fmtDate`), no ISO timestamps.

**Inspection (`src/inspection.html`)**
- Up-front "מה נבדק בבקרה" summary: the fixed checklist is shown by domain before starting.
- New **בקרה חוזרת** date field: auto-set one month after the inspection date, editable;
  recomputes if the inspection date changes (unless manually overridden). Sent as `reinspect_date`.

**Reports (`src/reports.html`)**
- Clean DD/MM/YYYY dates in the list and report header (was the long ISO timestamp).
- Report header now shows the planned re-inspection date when set.

**Weekly work orders (NEW — `src/workorders.html`, route `/workorders`)**
- Roy generates a weekly task list per maintenance lead (רמי / צחי): all open items for that
  lead (approved-unassigned requests + open inspection defects), **bundled by house**, urgent
  items first within a house, hottest house on top. Printable / save-as-PDF. Staff-PIN gated.
- Nav link "משימות שבועיות" added across dashboard / inspection / reports / workorders.

**Logic + tests**
- `src/workorders.js` — pure module: `urgencyRank`, `houseLeadMap`, `collectLeadItems`,
  `buildWeeklyOrder`, `weeklyOrderForLead`. `test/workorders.test.js` covers lead filtering,
  the two item sources, house-first grouping, and urgency ordering.
- `src/inspection.js` — added `nextInspectionDate` (clamps month overflow) and
  `consolidateDefectsByHouse` (de-dup by normalized text, with counts). Tests added.

**Backend (`apps-script/Code.gs`, `apps-script/setup.gs`, `src/schema.js`)**
- `Inspections` gains a `reinspect_date` column; `createInspection` persists it.

**Security:** no secrets added; work-orders page is read-only and behind the staff PIN; all
existing server-side validation/authority/audit rules unchanged.

**Deploy notes:**
1. Paste `apps-script/Code.gs` into the Apps Script editor and redeploy as a NEW VERSION.
2. Re-run `setupSheet()` once — it appends the new `reinspect_date` column to Inspections.
3. Set Railway env vars as before (`APPS_SCRIPT_EXEC_URL`, `STAFF_PIN`).
4. Confirm your local `src/config.js` is the restored version before merging, so the corruption
   doesn't return.

---

# Changelog

All notable changes to EZone Logistics are documented here, per the project working rule
(documentation for every change and every commit). Newest first.

## [Increment 10] — Roy-only approval, checklist ratings, calendar deferral, lead roll-up

**Request form (`src/index.html`)**
- Removed the עלות משוערת (estimated cost) field. Requests no longer carry a cost; everything
  routes to Roy (consistent with Roy-only approval below).

**Dashboard (`src/dashboard.html`)**
- Removed Sandra from the user picker — **Roy approves alone**; `whoApproves`/`canApprove`
  simplified (emergencies still auto-approve). Delete button is Roy-only.
- Reject button relabelled **לא אושר** (was דחייה); prompt reworded to "סיבת אי-האישור".
- **Deferral is now a calendar modal** — date picker + "תזכורת כמה ימים לפני" (default 7) with a
  live hint of the computed reminder date. Sends `deferred_until`, `remind_days`, `remind_on`.

**Inspection (`src/inspection.html`, `src/inspection.js`)**
- Each checklist item now has a **1–5 rating** dropdown (5 מצוין … 1 ליקוי) instead of a checkbox.
- **A rating of 1 or 2 auto-creates a physical-defect finding → Roy referral**, flowing through the
  same suggest-then-confirm pipeline as manual defects. 3–5 are recorded as ratings only.
- `inspection.js`: added `ratingIsDefect`, `ratingToFinding`, `RATING_DEFECT_THRESHOLD` (testable).

**Reports (`src/reports.html`)**
- New **"ריכוז ליקויים פתוחים לפי איש אחזקה"** section: all open (unlinked) defects grouped by the
  house's maintenance lead (Rami/Tzachi), and within each lead by house — a work list per lead.
  Loads `houses` to map house → lead.

**Backend (`apps-script/Code.gs`, `apps-script/setup.gs`)**
- `setup.gs`: Requests gains `remind_on`, `remind_days`, `reminder_fired`; new `InspectionRatings`
  sheet (`id, inspection_id, domain, item_text, score`). Re-running `setupSheet()` appends the new
  columns/sheet without data loss.
- `Code.gs`: `defer` stores remind fields; `createInspection` persists the ratings array; new
  `ratings` GET action; **daily reminder trigger** — `installDeferralReminderTrigger()` (run once)
  schedules `checkDeferralReminders()` which stamps `reminder_fired` + writes an AuditLog entry when
  a deferred request reaches its `remind_on` date.

**Tests** — `test/rating.test.js` (1–2 → defect, 3–5 → none) and `test/defer.test.js`
(7-days-before math, rollover, due-check). Suite: 60 pass.

**DEPLOY NOTES (Apps Script):** paste `Code.gs` + `setup.gs`, run `setupSheet()` once (adds the new
columns/sheet), run `installDeferralReminderTrigger()` once, then redeploy as a **New Version**.

## [Increment 9] — In-app attention panel (notifications)

**What:** A per-user "דורש את תשומת לבך" panel at the top of the dashboard surfacing what the
logged-in user (Roy or Sandra) needs to act on. In-app only — no email.

**Changed**
- `src/dashboard.html` — new attention panel that computes, for the selected user: requests
  awaiting their approval (by the §6 routing — Sandra sees >threshold, Roy the rest), new requests
  just received (Roy), deferral reminders whose date has arrived/passed, and pending inspection
  defects awaiting confirmation into a request (Roy). Shows a count badge per item, or "אין פעולות
  הממתינות לך כרגע ✓" when clear. Updates live when the user picker or filters change.

**Why:** the board showed everything but didn't tell each person what was *theirs* to do. The panel
turns the dashboard from a list you scan into one that says "here's what needs you." In-app chosen
first (zero setup, immediate); email delivery can follow as a later increment.

**Note:** frontend-only — no backend, schema, or test changes; reuses the existing data feeds and
the client-side §6 routing mirror.

---

## [Increment 8] — Navigation bar

**What:** A shared top navigation linking all four pages, so the app feels like one product
instead of separate URLs.

**Changed**
- `src/index.html`, `src/dashboard.html`, `src/inspection.html`, `src/reports.html` — each page's
  single tab label replaced with a nav (דרישה חדשה / לוח בקרה / בקרה / דוחות), current page marked
  active in the teal accent. Frontend-only; no backend, schema, or test changes.

**Why:** the app had grown to multiple pages with no menu between them — users had to type
`/dashboard`, `/inspection`, `/reports` by hand. The nav makes every page reachable from every
other.

---

## [Increment 7] — Real submitters + report recommendations summary

**What:** Corrected who submits requests (the house coordinators, not maintenance leads) with
house auto-lock, and added a consolidated recommendations section to the inspection report.

**Changed**
- `src/index.html` — submitter picker is now the house coordinators: שירה (עפרוני), יעקב (ריהאב),
  אורן (רעננה), אביב (רמות), צחי (צפון), plus רועי. **רמי removed** (he executes, doesn't submit).
  Selecting a single-house coordinator auto-fills and **locks** their house; צחי and רועי choose
  freely (north covers two houses / Roy files anywhere).
- `src/request.js` + `apps-script/Code.gs` — `SUBMITTERS` updated to the coordinator list.
- `test/request.test.js` — fixture uses a valid coordinator.
- `src/reports.html` — report now ends with **ריכוז המלצות לטיפול**: all physical defects as one
  to-do list, each showing its category and either the request already opened for it or a
  "פתח דרישה" button to open one from the report (button hidden when printing to PDF).

**Why:** the request originators are the per-house רכזים, and locking their house prevents
wrong-house filing. The report needed a closing action list so a defect found in a בקרה turns
directly into a tracked request.

**Spec:** §-form submitter list changed from the maintenance leads to the coordinators — update the
project-knowledge spec accordingly.

---

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
