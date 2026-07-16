# EZone Logistics — Ecosystem Status

> **Reconstructed doc.** The original `EZONE-ECOSYSTEM-STATUS.md` was lost. This version was
> rebuilt on **2026-07-16** by inspecting the repository plus the Increment-25 patch supplied by
> the maintainer. It is a **draft for correction** — every claim is tagged with how it was
> verified. Correct the ⚠️ items and re-tag them, then commit as the canonical version.

## Verification legend

| Tag | Meaning |
|---|---|
| ✅ | **Verified from the repo** — read directly from files on the fetched branch (Increment 3). |
| 🟡 | **Verified from the Increment-25 patch** — read from the diff the maintainer supplied. Reflects the real current local state, which is **not yet pushed** to the branches I can fetch. |
| ⚠️ | **Unverified** — inferred from context, referenced but not read, or known to be stale. Needs confirmation. |

---

## ⚠️ Reconciliation notice — read first

There is a **large gap between what is on GitHub and what actually exists.**

- ✅ Both fetchable branches — `claude/awesome-keller-u0l53` (reported as the repo default) and
  `claude/ezone-ecosystem-status-doc-dgsrbb` — are at **Increment 3**. Identical history, 13 files,
  latest commit `fe01241` "Merge pull request #4 from sandrabrayer/main."
- 🟡 The supplied patch is **Increment 25**, built on an Increment-24 base that already contains
  `workorders.html`, `inspection.html`, `reports.html`, `auth.js`, an execution-status model, a
  staff-token gate, and the inspection module. None of that is in the fetchable repo.
- ⚠️ Therefore the true codebase lives **in the maintainer's local copy** (the lost
  `..\ezone-logistics\`), roughly **22 increments ahead of origin**. Anything below that is tagged
  ✅ describes the Increment-3 snapshot and **may be superseded** by later increments not visible to
  me. The clearest example: the approval rule (see §7).

**Action item for the maintainer:** confirm whether the Increment-4…25 work has been pushed
anywhere I can reach, or whether origin genuinely trails local by 22 increments.

---

## 1. What the app is

✅ Standalone logistics, procurement, and maintenance app for the EZone **balance houses**
(בתים מאזנים). It owns the full lifecycle of a request — purchase (רכישה) / repair (תיקון) /
replacement (החלפה) — from submission through approval, execution, and closure. UI is **Hebrew,
right-to-left**.

**Personas**

| Person | Role | Source |
|---|---|---|
| Roy (רועי) | Manages the domain, approves, assigns execution | ✅ README |
| Sandra | Second approver (above cost threshold) | ✅ README / ⚠️ possibly changed by Inc 10 — see §7 |
| Rami (רמי) | Internal maintenance lead — Sharon cluster | ✅ schema seed |
| Tzachi (צחי) | Internal maintenance lead — Caesarea **and** North clusters | ✅ schema seed |
| Olga | Inspector — fills the per-visit inspection checklist | ⚠️ inferred from patch comments |

---

## 2. Stack

- ✅ **Backend:** Google Apps Script (`apps-script/Code.gs`), container-bound to this app's **own**
  Google Sheet. Read/write layer + HTTP router (`doGet`/`doPost`).
- ✅ **Frontend:** Node.js **zero-dependency** static server (`src/server.js`, `node:http`). No
  framework, no build step. Serves hand-written HTML pages and injects the Apps Script URL at
  request time.
- ✅ **Data store:** a single Google Sheet with multiple tabs (§5). No database.
- ✅ **Language/runtime:** ES modules (`"type": "module"`), Node **>=18**.
- ✅ **Tests:** Node's built-in `node:test` (`npm test` → `node --test`). Zero test deps.
- 🟡 **Deploy:** Railway (frontend) + Apps Script web app (backend) — see §4.

Pure-logic modules (`config.js`, `request.js`, `approval.js`, 🟡 `auth.js`, 🟡 `inventory.js`) are
runtime-agnostic so they run under `node:test`; **`Code.gs` mirrors each of them by hand** and is
the real enforcement point. Keeping the mirror in sync is a load-bearing convention (§9).

---

## 3. Architecture

- ✅ **Fully standalone**, matching the "Outpatient" sibling app's pattern. Does **not** touch the
  shared Dashboard/Managers `Code.gs` or their deployments or spreadsheets.
- ✅ **Self-owned houses:** the house list is seeded into this app's own `Houses` sheet, **not**
  read from the Dashboard feed (pre-opening houses aren't all in that feed yet).
- ✅ **Source of truth:** GitHub repo + the Google Sheet. Each PC needs only a browser.
- ✅ **Secret handling:** the Apps Script `/exec` URL and Sheet ID live in an untracked `.env`
  (gitignored); `.env.example` carries placeholder names only. `server.js` injects
  `APPS_SCRIPT_EXEC_URL` into the HTML at serve time via `window.__EXEC_URL__` — never hardcoded,
  never committed.

---

## 4. Deployment

- 🟡 **Railway auto-deploys the frontend from the `main` branch** (stated in the Increment-25
  CHANGELOG deploy steps). ⚠️ Note: **no `main` branch is visible** in the remote I can fetch (only
  the two `claude/*` branches), and git reports `claude/awesome-keller-u0l53` as the default — so
  `main` exists in the real remote but not in my view. Confirm the real default/deploy branch.
- ✅ **No Railway config file in the repo** (`railway.json`/`toml`, `Procfile`, `nixpacks`,
  Dockerfile all absent). Deploy relies on Railway's Nixpacks auto-detection + the `start` script
  (`node src/server.js`) and `PORT` from the environment.
- ✅ Required Railway env vars: `APPS_SCRIPT_EXEC_URL`, `PORT` (and `SHEET_ID` per `.env.example`).
  🟡 Plus a staff-token secret on the Apps Script side (§6).

### Apps Script redeploy discipline (🟡 verified from patch, ✅ echoed in Inc-3 CHANGELOG)

Apps Script does **not** auto-update from GitHub. After merging backend changes:

1. Copy `apps-script/Code.gs` from the **raw GitHub `main` view** → paste into the Apps Script
   editor → **Save**.
2. Deploy a **New Version of the EXISTING deployment** — **never a new deployment** (a new
   deployment mints a new `/exec` URL and breaks the frontend).
3. Repeat for `setup.gs` when the schema changed, then run `setupSheet()` once.
4. **Verify via DevTools → Network → Response:** the action's response row must be `{ok:true,...}`.
   This post-redeploy check is standing "ecosystem discipline."

---

## 5. Data model (Google Sheet)

Header definitions live in `src/schema.js` — the **single source of truth**, shared by
`apps-script/setup.gs` (provisioning) and the tests (structure lock). `setupSheet()` is idempotent:
creates missing tabs, writes headers if absent, seeds reference tabs only when empty.

**Sheets present at Increment 25** 🟡 (locked by `schema.test.js` in the patch):

| Sheet | Purpose | Verified |
|---|---|---|
| `Requests` | Core lifecycle table, one row per request (22 columns) | ✅ |
| `Houses` | Self-owned house list: `name, technician, cluster, status` | ✅ |
| `Config` | Key/value rules (typed on read) | ✅ |
| `Technicians` | Internal leads + external suppliers | ✅ |
| `AuditLog` | Every status transition / write: `request_id, from_status, to_status, by, timestamp, note` | ✅ |
| `ChecklistItems` | Fixed inspection checklist: `domain, item_text, active` | 🟡 |
| `Inspections` | Inspection visit records | ⚠️ referenced, headers not fully seen |
| `InspectionFindings` | Per-visit findings; incl. `linked_request_id, confirmed_by, confirmed_at` | ⚠️ partial |
| `InventoryItems` | Countable-item catalog: `category, item_text, active` | 🟡 |
| `InventoryCounts` | Monthly stock counts: `count_id, house, month, counted_by, counted_at, category, item, quantity, notes` | 🟡 |

**`Requests` columns** ✅ (Increment 3): `id, created_at, created_by, house, category, description,
location_in_house, urgency, estimated_cost, attachment_url, status, approval_required, approved_by,
approved_at, rejection_reason, deferred_until, assigned_to, assignment_type, batch_id, completed_at,
actual_cost, completion_notes`. ⚠️ Later increments (execution status, etc.) may have added columns
not seen.

**Seed reference data** ✅:
- **Houses (6):** רעננה·רמי·sharon·open, רמות השבים·רמי·sharon·open, הפרדס·רמי·sharon·**pre-opening**,
  קיסריה עפרוני·צחי·caesarea·open, ריהאב·צחי·caesarea·open, שדה אליעזר·צחי·north·**pre-opening**.
- **Locked distinction:** `technician` (internal assignment) ≠ `cluster` (external batching axis).
  Tzachi covers both `caesarea` and `north`, but they are **separate clusters** so a far-north visit
  is never auto-batched with the coastal two. A test asserts exactly this.
- **Config:** `approval_threshold = 3000` (₪), `emergency_bypasses_approval = TRUE`,
  `batching_window_days` (reserved).
- 🟡 **Inventory catalog:** ~27 seeded items across `טואלטיקה` / `חומרי ניקוי` / `מזון`, editable in
  the Sheet (`active=FALSE` hides, new rows extend — no code change).

**Config typing** ✅: Apps Script reads every cell as a string. `src/config.js`
(`coerceConfigValue`) coerces known keys — `NUMERIC_KEYS` (`approval_threshold`,
`batching_window_days`), `BOOLEAN_KEYS` (`emergency_bypasses_approval`) — so the approval math never
compares against a raw string. `Code.gs` mirrors the same lists.

---

## 6. Auth pattern

The auth model **evolved** across increments:

**Increment 3 (✅ repo) — identity by selection, no secret.**
There is no login. The acting user is a dropdown value (`רמי / צחי / רועי / sandra`). The client
sends `by` in the POST body; the server trusts the string. Authorization for approval is enforced
server-side purely from `by` + amount tier (`canApprove_`). Requests to Apps Script use
`Content-Type: text/plain` to avoid a CORS preflight.

**Increment 25 (🟡 patch) — shared staff token gate on mutating writes.**
- `src/auth.js` exports `STAFF_WRITE_ACTIONS` (the gated actions) and `writeRequiresToken(action)`.
  `Code.gs` mirrors this as `STAFF_WRITE_ACTIONS_` + `writeRequiresToken_`.
- **Gated actions (Inc 25):** `approve, reject, defer, assign, markExternal, assignBatch, setStatus,
  createInspection, addFinding, confirmFinding, deleteRequest, editRequest, setExecution,
  submitInventory`. The **public** `createRequest` (the submission form) is deliberately **not**
  gated.
- The token is verified **server-side, constant-time, fail-closed** against a `STAFF_WRITE_TOKEN`
  secret (⚠️ presumed an Apps Script Script Property — not seen).
- GET `?action=verifyToken&token=…` returns **only a boolean** — never echoes the secret.
- Frontend `staffGate()`: prompts for the code, verifies it, caches it in `sessionStorage`
  (`ezone_staff_token`), and sends it in the POST body `{action, token, payload}`. Three failed
  tries → redirect to `/`.
- ⚠️ **Nuance:** the token gates *whether* you may write; the `by` / `counted_by` dropdown still
  declares *who* you are and is not cryptographically bound to the token. Approval-tier authority
  (Roy vs Sandra) therefore still rests on a self-declared identity string. Worth a hardening
  review.

---

## 7. Approval rules ⚠️ (state uncertain — reconcile before trusting)

**Increment 3 (✅ repo):** routing depends **only** on amount, every time (first arrival and
deferred wake-up):

| Case | Who approves |
|---|---|
| Cost ≤ threshold (or blank/unknown) | Roy |
| Cost > threshold | Sandra |
| Emergency (חירום) | Auto-approved, bypasses approval |
| Defer to date (נדחה לתאריך) | Roy, any amount |

Threshold is `Config.approval_threshold` (₪3,000) — **configurable, never hardcoded**. Enforced by
`src/approval.js` (`whoApproves`, `approvalRequired`, `canApprove`, `canTransition`,
`validateApproval`) and mirrored in `Code.gs`. Roy cannot approve above threshold; Sandra can.

**⚠️ Likely superseded:** the Increment-25 CHANGELOG contains a heading **"Increment 10 — Roy-only
approval, …"**, which strongly implies the Sandra-above-threshold split was **replaced by Roy-only
approval** at some point. I could not read Increment 10's body. **Do not trust the table above as
current** until you confirm whether approval is now Roy-only (and, if so, what became of the
threshold/Sandra tier).

---

## 8. Request status lifecycle ✅ (Increment 3; ⚠️ may have grown)

Statuses (Hebrew display value = stored value): `דרישה` (request) → `ממתין לאישור`
(pending) / `מאושר` (approved) / `לא מאושר` (rejected, terminal) / `נדחה לתאריך` (deferred) →
`בביצוע` (in progress) → `הושלם` (completed) → `סגור` (closed, terminal).

Legal transitions are a fixed map (`TRANSITIONS`), validated server-side on every action; the client
cannot force an illegal state. There is no separate "assigned" status — approved → in-progress on
assignment. Deferred wakes back up and is re-decided by amount.

🟡 Increment 25 adds a **separate execution-status axis** (`EXECUTION_STATUS`,
`EXECUTION_STATUS_CHOICES`, `setExecution` action) layered on the lifecycle. ⚠️ Its exact values and
semantics were not seen.

---

## 9. Apps Script backend conventions ✅/🟡

- **Router shape:** `doGet` switches on `?action=` (reads: `houses, technicians, requests, config`,
  🟡 `checklist, inspections, findings, inventoryItems, inventoryCounts, verifyToken`). `doPost`
  parses a JSON body and dispatches on a **whitelisted** `action`; unknown actions are rejected.
- **Server owns identity fields:** `createRequest` stamps `id`, `status` (`דרישה`), and `created_at`
  server-side — the client never supplies them. Inputs are validated against controlled
  vocabularies (category, urgency, submitter) before any write.
- **ID generation:** ✅ Inc 3 had `generateRequestId_()` (`REQ-<timestamp>-<rand>`). 🟡 By Inc 25 this
  is generalized to `genId_(prefix)` (e.g. `INV-…` for inventory).
- **Audit everything:** every mutation writes one `AuditLog` entry (who / when / from→to / note) —
  one entry **per submission**, not per row.
- **Batched writes:** multi-row writes use a single `setValues` range, not N × `appendRow`
  (🟡 inventory does this).
- **Mirror discipline:** each pure JS module has a hand-kept mirror in `Code.gs`; the server is the
  real gate. 🟡 The Inc-25 patch explicitly fixes a drift where `setExecution` was gated in `Code.gs`
  but missing from the `auth.js` mirror — the two lists now match, locked by `auth.test.js`.
- **Output:** `jsonOut_()` returns `ContentService` JSON `{ok:true,…}` / `{ok:false,error:…}`.
- **Least privilege:** the script is bound to this app's spreadsheet only; no `eval`, no arbitrary
  sheet writes; documented intent not to reach the Dashboard/Managers sheets.

---

## 10. Frontend / pages 🟡

Six pages, shared RTL dark theme (teal signature accent), a common top nav, and a mobile
media-query block on every page (locked by `mobile-css.test.js`):

| Route | File | Purpose | Gated? |
|---|---|---|---|
| `/` | `index.html` | דרישה חדשה — request submission form | ✅ public |
| `/dashboard` | `dashboard.html` | דשבורד — approve/reject/defer/assign board | 🟡 staff |
| `/workorders` | `workorders.html` | משימות פתוחות וסטטוס — open tasks & status | 🟡 staff |
| `/inventory` | `inventory.html` | מלאי — monthly stock count | 🟡 staff |
| `/inspection` | `inspection.html` | בקרה — inspection/checklist | 🟡 staff |
| `/reports` | `reports.html` | דוחות — reports | ⚠️ unknown |

✅ `server.js` maps these via a static `HTML_ROUTES` table and injects `window.__EXEC_URL__` into
each. ⚠️ Internals of `workorders.html`, `inspection.html`, and `reports.html` were referenced but
not read — treat their behavior as unverified.

**Inventory module (🟡 Increment 25, fully in the patch):** staff-gated `/inventory`; monthly count
per house by its maintenance lead across `טואלטיקה` / `חומרי ניקוי` / `מזון`. One `InventoryCounts`
row per item sharing a `count_id`; re-submitting the same house+month **appends a new count**
(non-destructive; latest `counted_at` wins on display). Pure logic in `src/inventory.js`, mirrored
in `Code.gs handleSubmitInventory_`. 19 new tests.

---

## 11. Testing ✅/🟡

- ✅ Runner: `node --test` (built-in `node:test`, zero deps). `npm test` / `npm run test:watch`.
- 🟡 **149 tests pass** at Increment 25 (was 130 before the inventory module).
- Pattern: pure logic modules are unit-tested; schema/vocab/auth-list/mobile-css **locks** assert
  structure so the hand-kept `Code.gs` mirror can't silently drift.

---

## 12. Security posture (summary)

- ✅ No secrets committed; `.gitignore` covers `.env*`, keys, service-account/credentials JSON,
  clasp files.
- ✅ Server-side stamping of `id`/`status`/`created_at`; input validation + whitelisted vocabularies
  before writes; every transition validated for legality + authority; full audit trail.
- 🟡 Mutating actions require a staff token, verified server-side (constant-time, fail-closed);
  `verifyToken` never echoes the secret; rendered values HTML-escaped (`esc()`).
- ⚠️ Open hardening question: approver identity (`by`) is self-declared and not bound to the token
  (§6).

---

## 13. Increment history (from CHANGELOG)

✅ In the fetched repo: **1** (data-model scaffold) · **2a** (request form) · **3** (approval engine
+ status transitions + dashboard).

🟡 Referenced by the Increment-25 patch but **not present in the fetched repo**: **10** (Roy-only
approval, checklist ratings, calendar deferral, lead roll-up) · **24** (dashboard refer picker + nav
rename/reorder) · **25** (monthly inventory count). ⚠️ Increments 4–9, 11–23 exist by implication but
were not seen. ⚠️ Minor anomaly: the patched `CHANGELOG.md` appears to contain the header block and
entries **twice** (a likely merge artifact) — worth a cleanup pass.

---

## 14. Consolidated open questions (⚠️)

1. **Push state:** is Increment 4–25 work pushed anywhere reachable, or does origin really trail
   local by ~22 increments? (Highest priority — everything else depends on the real source.)
2. **Approval rule:** is approval now **Roy-only** (Inc 10) or still the Roy/Sandra threshold split
   (Inc 3)? What happened to the ₪3,000 tier and Sandra's role?
3. **Deploy branch:** confirm Railway deploys from `main`, and reconcile why the fetchable default is
   `claude/awesome-keller-u0l53` with no `main` visible.
4. **Execution status:** exact `EXECUTION_STATUS` values and how they relate to the lifecycle in §8.
5. **Unread pages:** confirm the behavior/gating of `workorders.html`, `inspection.html`,
   `reports.html`, and the `Inspections` / `InspectionFindings` sheet headers.
6. **Olga persona:** confirm the inspector role and her exact permissions.
7. **Staff token:** confirm `STAFF_WRITE_TOKEN` is stored as an Apps Script Script Property and how
   it's rotated.
8. **CHANGELOG duplication:** de-dupe the doubled changelog content.

---

*Reconstructed 2026-07-16. Tags: ✅ repo (Inc 3) · 🟡 Increment-25 patch · ⚠️ unverified. Correct the
⚠️ items, re-tag, and commit as canonical.*
