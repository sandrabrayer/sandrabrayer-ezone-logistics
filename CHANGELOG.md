# Changelog

All notable changes to EZone Logistics are documented here, per the project working rule
(documentation for every change and every commit). Newest first.

## [Unreleased] — UX — login button loading state (spinner + disabled, no dead moment)

**Why.** Clicking **כניסה** (or pressing Enter) had no immediate feedback — on a slow login the button
looked inert, inviting a second click. Now it shows an in-progress state the instant it's pressed.

**What (in the injected auth shim's login overlay, `src/server.js`).**
- **On click / Enter:** the button is **immediately disabled** and shows a **spinner inside the button**
  (label cleared, `aria-busy="true"`). A guard makes a second Enter/click while in-flight a no-op, so a
  slow login can't be double-submitted.
- **On failure** (401 / 429 / network): the button is **restored** (label back, re-enabled) and the
  existing Hebrew error is shown — unchanged copy.
- **On success:** the button **stays disabled/spinning through the redirect** (overlay close + nav mount)
  — no dead moment where it flips back to idle before the page changes.
- The spinner keyframes ride in a `<style>` appended inside the overlay (inline styles can't define
  `@keyframes`); the spinner is `aria-hidden`, dark-on-teal to match the button.

**Scope.** Only the login button. The dashboard **approve/reject** buttons already reload on success and
live in a separate file (`dashboard.html`) with their own flow — no shared helper made it trivial to extend
without editing those handlers, so per the "only if cheap" guidance they're left as-is.

**Tests.** New `test/login-button.test.js` (4) renders the real shim in a DOM sandbox with a **deferred**
`/api/login`: the button is disabled + shows a spinner **while in flight**; **re-enabled with the label
restored and the error shown on failure**; a second click in-flight fires no duplicate request; and on
success the overlay closes without the button flipping back to an idle state. `node --test` green
(**598 tests**). No secrets; `src/server.js` + one test only.

## [Unreleased] — three small UI/roster changes (management note removed, login = רועי+אולגה, bigger hub cards)

**1. `/management` — data-source note removed.** Deleted the explanatory sub-line ("מוצג רק מה שיש לו מקור
נתונים אמיתי בלוגיסטיקה — מדד ללא מקור מסומן במפורש כ״לא זמין״…"). No "לא זמין" placeholder cards render
(the render path already returns "אין נתונים" per panel, never a "לא זמין" card), so nothing else was needed;
the now-dead `.unavail` CSS was removed too. The hub cards themselves are unchanged.

**2. Login dropdown = רועי + אולגה only (`LOGIN_ROLES` → field_ops + ops_manager).** This is JUST the
login-roster filter — the **Users sheet is untouched** and **no token/role/scope logic changed**. Removed
from login: **ceo (סנדרה)** and **maintenance (רמי/צחי)** (coordinators were already out). The picker
(`loginRosterNames`) and the `DEFAULT_LOGIN_NAMES` fallback follow the filter.
- **⚠ What this breaks for רמי/צחי:** every page requires a session token from login, so with maintenance
  out of the roster **רמי/צחי can no longer log in at all** — they lose access to the whole app, **including
  their #73 `/workorders` preventive-daily entry** (the maintenance leads' daily checklist). The `/workorders`
  page, the `updatePreventiveItem` write gate (maintenance-allowed), and the `PreventiveDaily` sheet are all
  **still in place and unchanged** — only the login door is closed. To restore them, add `'maintenance'` back
  to the single `LOGIN_ROLES` set in `src/server.js` (one line); nothing else changes.

**3. `/management` hub — bigger topic cards.** Larger cards (min column 230→**320px**, padding 18→**30px**,
radius 16→**20px**, min-height **190px**, grid gap 14→**22px**), larger KPI numbers (1.7→**2.9rem**), titles
(1.05→**1.5rem**) and icons (1.5→**2.4rem**), roomier line spacing, and a subtle hover lift. Still responsive
— `auto-fit`/`minmax` reflows and the mobile breakpoint collapses to a single column.

**Tests.** `login-roster.test.js` updated to the manager-only roster (picker = רועי+אולגה; ceo/maintenance/
coordinators all fail closed; fallback synced to active field_ops+ops_manager seeds). `dashboard-approve` /
`management-writes` now **mint** the maintenance token directly (רמי can't log in) to keep exercising the
gateway gates. `node --test` green (**588 tests**).

## [Unreleased] — deploy provenance — /version on both legs, self-verifying deploys, commit-stamped SW cache

**Why.** The app's failure history is **version mismatch** across three independent deploy legs (Railway
Node / clasp Apps Script / service-worker cache). This makes the live version of each leg **provable at a
glance** and makes every deploy **self-verifying**, so a green deploy can't hide a stale leg.

**Live diagnosis at the time of this change (evidence, no live curl needed).**
- **Apps Script (clasp) leg = green + current with `main`.** The #73-merge deploy run (`69ac46de`, 10:10)
  concluded **success**, and its post-deploy step probes the live `/exec` for the recent-only `bundle`
  action (fails the run otherwise) → new code was live. `git diff 69ac46de..main -- apps-script/` is
  **empty** → `Code.gs` is byte-identical to `main`; no `apps-script/**` has merged since. So the clasp leg
  is **not** the mismatch.
- **Node (Railway) leg = unverifiable from the agent sandbox.** The public app URL resolves, but this
  environment's **egress policy denies `ezone-logistics.up.railway.app`** (proxy 403 on CONNECT — must not
  be routed around). So the Node-leg live check is wired into **CI** (a GitHub runner can reach Railway)
  instead of curled by hand.
- **Service worker** had a hardcoded `CACHE='ezone-logistics-v3'` — no per-deploy invalidation.

**1. Version truth.**
- **Node `GET /version`** (unauthenticated, non-secret) → `{ node:{ commit, builtAt }, appsScript:{ commit } }`.
  `node.commit` = `RAILWAY_GIT_COMMIT_SHA` (injected by Railway at build; `unknown` locally); `builtAt` =
  instance boot time; `appsScript.commit` = the live `/exec` `action=version`, cached ~60s (`unreachable`
  if `/exec` is down — never throws).
- **Apps Script `action=version`** → `{ commit: DEPLOY_COMMIT }`. `DEPLOY_COMMIT` defaults to `'DEV'`; the
  clasp workflow **stamps `GITHUB_SHA`** into it right before `clasp push`.
- **Footer** on every page (incl. login): a small gray `node <sha> · gs <sha>`, injected by the auth shim
  from `/version` (`pointer-events:none`, never blocks the UI).

**2. Self-verifying deploys.**
- **Railway leg** — new **`verify-live.yml`**: on push to `main` (and on-demand) it polls the live
  `/version` until `node.commit == GITHUB_SHA`, then runs `smoke-live.js`; fails (with a Railway-stale /
  crash-loop hint) if it never matches. `smoke-live.js` gains a `/version` check gated on `EXPECTED_COMMIT`.
  The app URL defaults to the public Railway host (override via an `APP_URL` repo variable).
- **clasp leg** — `deploy-apps-script.yml` now **stamps** the SHA into `Code.gs` and its post-deploy step
  asserts the live `action=version == GITHUB_SHA` (strongest check), keeping `bundle`/`users` as
  diagnostics. The `APPS_SCRIPT_EXEC_URL` **secret** is already required by the workflow's secret gate — it
  stays a secret (never pasted into a PR).
- **Service worker** — Node **stamps the running commit** into the SW cache name at serve time
  (`ezone-logistics-<commit>`), so every deploy changes it → the SW's `activate()` purges all prior caches
  → returning visitors and incognito first-loads both get fresh documents.

**Tests.** New `test/version.test.js` (6): `/version` returns both legs + `builtAt` and is `no-store`;
`appsScript` degrades to `unreachable`; `/sw.js` carries `ezone-logistics-<commit>` (v3 replaced); the shim
footer + a served page read `/version`; and the real `Code.gs` `doGet('version')` returns `DEPLOY_COMMIT`
(`DEV` before CI stamps it). Both edited/added workflows pass the `pyyaml` validator. `node --test` green
(**594 tests**). No secrets in the repo.

**Definition of done (fills after this merges + both deploys run).** `deploy-apps-script.yml` proves the
Apps Script leg (`action=version == merge SHA`); `verify-live.yml` proves the Node leg
(`/version node.commit == merge SHA`); the SW cache name proves itself (`/sw.js` carries the commit). The
`/version` footer lets anyone confirm all three match `main` at a glance.

## [Unreleased] — login — ONE shared access code (replaces per-user pin_hash + tier-B APP_PIN)

**Why.** The per-user login kept failing in production ("שם או קוד שגויים" for רועי with the correct code)
while every test passed — a live-only, data/env-dependent failure. Coordinators no longer log into this app,
so login is simplified to **pick a user + enter ONE shared access code** (`SHARED_ACCESS_CODE`, a Railway
env var; the server refuses to start if it is unset). Identity and role STILL come from the selected roster
user (the signed token is issued exactly as before); only the per-user secret check is replaced.

**Live-bug hypothesis pass (tests pass, prod fails — the env/data-dependent differences).** The per-user
path did three fragile, live-only things; the shared-code path removes or hardens each:
- **H1 — roster PROOF / `SESSION_SECRET` drift → `pin_hash` stripped (most likely).** `handleLogin` read the
  roster WITH a server-to-server proof = `HMAC(SESSION_SECRET, 'roster:users')`; Code.gs returns `pin_hash`
  ONLY when its own Script-Property `SESSION_SECRET` recomputes the same proof. If Railway's secret and the
  Apps Script Script Property ever diverged, the proof mismatched, `pin_hash` came back **blank**, and every
  tier-A manager (Roy/Olga — role not coordinator/maintenance) fell through to `ok=false` → generic 401.
  Tests always matched (one Node secret on both sides). **Removed:** the shared-code path reads the roster
  **publicly (no proof)** and never touches `pin_hash`, so this can't break login.
- **H2 — Apps-Script-vs-Node hashing mismatch.** `pin_hash` is produced by Apps Script `setUserPin()` and
  verified by Node `verifyPin` (PBKDF2). Any encoding/iteration divergence fails in prod while Node-hash +
  Node-verify tests always agree. **Removed** (no hashing in login anymore).
- **H3 — the stored `pin_hash` is stale/for a different password.** Someone re-set or cleared Roy's cell.
  **Removed** (login no longer reads it).
- **H4 — trailing/hidden whitespace in the live `Users.name` cell** ("רועי ") → `name` lookup misses → 401.
  This would ALSO break the shared-code path (still matches by name), so it's **fixed first**: the name is
  matched **trimmed** on both sides.
- **H5 — `active` column drift.** `isActiveUser` already tolerates `TRUE`/`true`/`1`/boolean + whitespace;
  a genuinely blank `active` cell is a data issue that would (correctly) drop the user from the roster.
- **H6 — trailing newline in the Railway value.** `SHARED_ACCESS_CODE` is **trimmed on load** so a stray
  `"2026\n"` can't length-mismatch every `checkPin` and fail all logins.

**What changed (`src/server.js`).**
- `SHARED_ACCESS_CODE` env (trimmed) replaces `APP_PIN`; startup fail-closed now requires it.
- `handleLogin` = public roster read → find the ACTIVE, `LOGIN_ROLES`, trimmed-name-matched user → one
  constant-time `checkPin` against the shared code → issue the same identity token. Kept: rate limiting
  (8/15min per IP), session expiry (`SESSION_DAYS`), sign-out, generic 401s.
- **Roster = active NON-coordinator users** (`LOGIN_ROLES` = field_ops, ops_manager, ceo, **maintenance**).
  Coordinators are dropped from the picker and refused login. **סנדרה (ceo)** can now log in (she had no
  `pin_hash`, so the old scheme locked her out). The picker (`loginRosterNames`) + `DEFAULT_LOGIN_NAMES`
  fallback are filtered to `LOGIN_ROLES`. *(Maintenance is included so the leads רמי/צחי keep their
  `/workorders` preventive-daily entry from the hub redesign; to restrict to strictly manager-tier, drop
  `'maintenance'` from the single `LOGIN_ROLES` set — nothing else changes.)*
- Chain-B role gates, scope filtering, and the token format are **unchanged**. `pin_hash`/`setUserPin` stay
  in the sheet/Apps Script but are dormant.

**Docs/UX.** `.env.example`, README, `src/schema.js`, and the ecosystem status doc updated (`APP_PIN` →
`SHARED_ACCESS_CODE`); the login overlay placeholder is now "קוד גישה".

**Tests.** `login-roster.test.js` rewritten to the shared-code contract (picker = active non-coordinator
roster; login succeeds for every roster user with the code; coordinators / wrong / empty code fail closed;
role in token matches the selected user; **trimmed-name** login; fallback in sync with the seed). New
`login-shared-unset.test.js` (fail-closed when the code is unset). `staff-tiers.test.js` reworked to mint
tokens directly (scope/gate coverage kept, obsolete per-user-password tests removed). `dashboard-approve` /
`management-writes` swapped to the shared code (+ minted coordinator tokens for the gate checks).
`node --test` green (**588 tests**). No secrets in the repo.

## [Unreleased] — Task 1: field_ops dashboard 403 fix + perf round-3 cache + nav cleanup

Three production follow-ups after the deploy chain was confirmed current.

**1. BUG — the field_ops "Forbidden" banner, fixed in the UI (the ₪3000 approval control is UNCHANGED).**
The chain-B gate is intentional and stays exactly as it was: field_ops (Roy) approves/rejects **only ≤ the
`approval_threshold`; above it → ops_manager (Olga); ceo may always**. `canApprove` / `handleDeleteRequest_`
(exec-only delete) are untouched on the server. The production banner ("הפעולה נכשלה — Forbidden: role not
authorized…") did **not** come from a load-time action — an exhaustive trace confirms the dashboard's only
load call is the `pageData` GET; every write is behind a click. It came from Roy **clicking אישור on an
over-threshold request** (the client `whoApproves` was stale — "Roy approves alone", so the buttons showed
regardless of amount), and the error banner never auto-clears, so it looked like it was there on load. Fix,
all client-side (`src/dashboard.html`):
- `whoApproves` now MIRRORS chain B (emergency → auto; over threshold → ops_manager; else field_ops).
- On an over-threshold request a field_ops session sees a **disabled `ממתין לאישור אולגה`** instead of a
  clickable אישור / לא אושר — no click-then-403. Execs (ops_manager/ceo) still see the real buttons.
- The **delete** button is now exec-only in the UI too (`isExecUI`), matching the server `isManagement_`.
- `post()` maps any residual permission error to a clean Hebrew "אין לך הרשאה לפעולה זו." — never the raw
  upstream English.

Tests: `roles.test.js` / `enforcement.test.js` keep the threshold-gate assertions (restored); new
`test/dashboard-approve-gate.test.js` renders the real dashboard headless and asserts **no error banner on
load**, the disabled `ממתין לאישור אולגה` for field_ops on an over-threshold request, real approve for a
≤threshold one and for a ceo on both, and delete visible only to execs.

**2. PERF (round-3) — short-TTL, write-invalidated cache for the hot reads.** Investigation (a
call-counting probe against the real gateway) found the bundle path healthy — 1 call/page, never
`degraded` — but the micro-cache only trimmed the bundle payload; every tab switch still made **1 blocking
`/exec` round-trip** because `requests`/`findings`/`inspections` were never cached. Added an ~8s cache for
those, INVALIDATED on every write (`handleAction`), so a burst of tab switches reuses one read while a
write still forces fresh data. The per-role scope filter STILL runs on a cache hit (a cached raw `requests`
list is never returned unscoped to tier B). Numbers, one manager session (login → dashboard → workorders →
inventory → reports → dashboard → approve):

| | before | after |
| --- | --- | --- |
| repeat dashboard load | 1 `/exec` call | **0** |
| tab switch (workorders/reports/back) | 1 call each | **0** each |
| total `/exec` GETs in the walk | **9** | **5** |
| post-write reload | refetches | **still refetches (freshness kept)** |

At live Apps Script latency (~1–3s/call incl. 302 + cold start) that turns multi-second tab switches into
instant ones. `src/server.js`; tests in `pagedata.test.js` (cache hit, write-invalidation, scope-filter-on-hit).

**3. NAV cleanup (Logistics → managers-only).** The standalone **דרישה חדשה** tab is removed from the nav;
managers file requests from a new **in-dashboard create modal** (button + modal on `/dashboard`;
`created_by` is stamped from the token, never the client). **אירועים חריגים** (`/events`) is removed
entirely — nav link, the `events.html` page, the HTML route, and the service-worker route. `'/'` (index.html)
is kept AS-IS as the root/login landing (the entry-flow/root rework is the separate architecture session).
The events **backend** (createEvent/updateEvent handlers, the `MIRROR:events` logic in `src/events.js`, the
Events sheet) is left dormant, not removed. `src/access.js` / `src/server.js` / `src/public/sw.js` /
`src/dashboard.html`; tests: `access.test.js` / `access-server.test.js` / `nav-events.test.js` updated,
new `test/dashboard-create.test.js`.

`node --test` green (**599 tests**). No secrets; explicit-path adds.

## [Unreleased] — /management redesigned as a HUB + topic views, and two new field checklists

**Why.** Olga's one long /management page became a **dashboard hub**: a compact KPI/gauge summary per topic,
each opening its own view with **client-side switching (no reload)**. Two field-side checklists were added so
the data behind the hub is entered by the people who own it.

**1. Hub layout.** `/management` opens as a grid of topic cards (each shows a headline KPI): **SLA וליקויים**,
**עמידה בתקציב**, **מוכנות בתים לפתיחה**, **מוכנות לשעת חירום**, **תחזוקה מונעת**, **מעקב הדרכות**. Clicking a
card switches to that topic's full view (a "← חזרה למרכז" button returns) — all from ONE `managementData` load,
no re-fetch. (אירועים חריגים was already gone; confirmed absent.)

**2. עמידה בתקציב.** Per house: **actual spend = completed/closed `actual_cost`** for the selected month vs the
budget from the existing `Budgets` sheet, shown as a bar + % used. UI note that food spend arrives later from
the Kitchen digest (not wired). `budgetAdherenceByHouse` / `budgetTotalPercent` (pure, tested).

**3. מוכנות בתים לפתיחה.** Data ENTRY moved to **Roy (field_ops)** — a new tab in `/workorders` with a **fixed
template per pre-opening house** (`ריהוט`, `מכשירי חשמל`, `חיבור תשתיות`, `ציוד בטיחות`, `מסמכי רישוי`, `ניקיון`,
`מפתחות`), seeded into `OpeningChecklist` (idempotent). Olga's hub view is **read-only completion %**.

**4. מוכנות לשעת חירום.** Per-house `EmergencyReadiness` checklist, now **editable by field_ops + ops_manager**
(field_ops from `/workorders`, ops_manager from the hub). Olga's hub shows **% ready per house**.

**5. תחזוקה מונעת → daily checklist.** NEW sheet **`PreventiveDaily`** (`house, date, item, done, by`). A short
fixed daily template (`בדיקת דוד/גז`, `סבב מפגעים`, `תאורה`, `מים`) is entered by the maintenance leads (רמי /
צחי) from a `/workorders` tab — **scoped to their own houses, today's date server-stamped**. Olga's view shows
completion per house per day (last 7 days). The MaintenancePlan panel is kept alongside it.

**6. מעקב הדרכות** (rename of עמידה באמות מידה). New sheet **`Trainings`** (`id, topic, house, date, attended,
by`) — MANUAL entry for now (a later increment feeds it from the Coordinators digest; NOT wired). The panel
lists trainings per house with **delete (confirm + audit-logged)**, the same behavior the compliance panel had.

**Role gates.** Hub + `deleteTraining` + `deleteCompliance` are exec-only (ops_manager + ceo). The readiness
writes are now manager-tier (field_ops included). `updatePreventiveItem` is allowed for maintenance (own houses,
enforced by `houseInScope`) + managers; the item must be in the fixed template; the date is server-stamped —
enforced at the Node gateway AND independently in Code.gs. Reads: `preventiveDaily` is maintenance+manager and
scope-filtered like requests; `openingChecklist` / `emergencyReadiness` / `trainings` are manager-tier.

**⚠️ After merge:** re-run **`setupSheet()` once** — it adds `PreventiveDaily` + `Trainings` and seeds the
`OpeningChecklist` template (idempotent; existing data untouched). Apps Script deploys via clasp CI.

**Tests.** Pure logic (budget %, readiness %, preventive completion, trainings) in `management.test.js`; the real
Code.gs handlers (preventive scope + date-stamp + upsert, training delete+audit, re-gated readiness) in
`management-handler.test.js`; gateway role gates in `management-writes.test.js`; template-seed idempotency in
`setup-seeds.test.js`; and the read/write matrix in `access.test.js`. Both HTML pages render-smoked headless
(hub + every topic view; all three /workorders entry tabs). `node --test` green (**591 tests**). No secrets.

## [Unreleased] — ci — post-deploy verification so a green clasp deploy can never hide a stale production

**Why.** Production symptoms (dashboard hangs on `טוען דרישות`, approve/reject dead, recently merged
changes not visible) pointed at a stale live Apps Script. Investigation of the deploy chain found the
opposite of "CI isn't deploying": the `Deploy Apps Script` workflow **did run and go green** on the only
recent `apps-script/**` merge (PR #72, `Code.gs` + `setup.gs`); the `src/`-only merges (PR #71, #68) correctly
triggered no deploy. The real gap is that the workflow trusted clasp's `Deployed …@<ver>` line and **never
checked the live `/exec`** — so if `DEPLOYMENT_ID` names a *different* deployment than the one production calls
(`APPS_SCRIPT_EXEC_URL`), CI stays green while the live `/exec` serves old code. A green deploy proved a
redeploy happened, not that the new code is what browsers hit.

**What changed — `.github/workflows/deploy-apps-script.yml`.**
- New **post-deploy smoke step** hits the real `/exec` (the URL production uses) and asserts the **recent-only
  `bundle` action** answers `{"ok":true,…}` with a `houses` key. Retries a few times (new versions take a few
  seconds to propagate). It also probes the **baseline `users` action** (present on *every* version) so the
  failure message can distinguish *"URL unreachable / wrong / not Anyone-access"* from *"URL works but the
  deployment behind it is stale"* (the `DEPLOYMENT_ID` ↔ `APPS_SCRIPT_EXEC_URL` mismatch). Fails the workflow
  loudly in either case — a deploy you can't verify no longer passes silently.
- New **required secret `APPS_SCRIPT_EXEC_URL`** (the full live `/exec` URL — the same value already in
  Railway) checked in the fail-loud-early secrets gate alongside `CLASPRC_JSON` / `DEPLOYMENT_ID`.

**Docs.** `DEPLOY.md` documents the new secret and the verification, and states the invariant: `DEPLOYMENT_ID`
must be the `AKfyc…` id *inside* `APPS_SCRIPT_EXEC_URL`, or CI goes green while production stays stale.

**Not changed.** No app code, no `apps-script/**`, no `/exec` contract — CI + docs only. The frontend
(dashboard UI, approve/reject buttons, `/management` hub) is served by **Railway from `src/`**, outside this
workflow; if merged UI changes aren't visible, verify Railway is auto-deploying `main` (see the PR notes).
`node --test` unaffected (**574 tests**, green); every workflow YAML still parses (`validate-workflows`).

## [Unreleased] — PR B: /management cleanup (Olga's screen) + inventory ownership move

**Why.** The network-management screen had grown to include panels with no owned data source (kitchen /
coordinators / training digest cards, a defect-closure rate, an exceptional-events analysis with a
zero-filled monthly trend, and "no data source" placeholders). It read as busier and less trustworthy than
the data behind it. This trims the screen to what Logistics actually owns, and moves non-food inventory
counting to the app that now owns it.

**/management — removed.** Gone entirely: `סגירת ליקויים במועד`, `אירועים חריגים` (incl. the
`מגמה חודשית` trend), the kitchen `חוסרי מזון` **and** the coordinators `דייג׳סט רכזים` cards,
`עמידה בתוכנית הדרכה`, and the `מדדים ללא מקור נתונים` block (`הטמעת מערכות`, `איכות הרשומה`). **No
"לא זמין" placeholder panels remain** — a source that isn't wired simply isn't shown; it returns via its own
increment. (The `/events` reporting page and the underlying pure functions are untouched — only the
/management *panels* were unwired.)

**/management — simplified / added.**
- `רמת הבתים + אירועים חוזרים` → a single **recurring-defects list derived ONLY from Requests** (same house +
  same category/description ≥2 within 90 days). No scores, no levels. (`recurringDefectsFromRequests`.)
- `הוצאות לפי בית` → reframed as a single **`עמידה בתקציב`** panel: actual spend per house (Requests
  `actual_cost`) vs the **existing** period-based `Budgets` sheet — kept as the single source of truth (no new
  sheet, no new columns). A UI note says food spend will arrive later from the Kitchen digest (not wired now).
- `מוכנות בתים לפתיחה` → fed from a new **Logistics-owned `OpeningChecklist`** sheet (id, house, item, done,
  date, by). Created **empty** for the pre-opening houses (`הפרדס`, `שדה אליעזר`); editable from the screen.
- **New `בקרת מוכנות לזמן חירום`** → a per-house emergency checklist from a new **`EmergencyReadiness`** sheet
  (same shape), **seeded** with a default item set per house (generator / gas / water / first-aid / …), editable.
- `עמידה באמות מידה` → each entry can now be **deleted (with confirm), audit-logged** before removal.

**New sheets + writes.** `OpeningChecklist` + `EmergencyReadiness` added to `setupSheet()` (idempotent —
OpeningChecklist empty, EmergencyReadiness seeded). New manager-only write actions (`addReadinessItem` /
`updateReadinessItem` / `deleteReadinessItem` / `deleteCompliance`) are gated `canManage` at the Node gateway
**and** independently in Code.gs; ticking stamps the actor from the verified token, never the client body.

**Inventory ownership.** Non-food counting moved OUT of Logistics to the Coordinators app: the `ספירת מלאי`
count-entry form is **removed** from `/inventory` (the weekly status VIEW stays, read-only).
`DIGEST-CONTRACT.md` gains a v2-compatible **"what Logistics CONSUMES"** section (weekly non-food counts from
coordinators; food shortages from kitchen — read weekly, by header name, no financial fields, unmapped houses
omitted). **Contract text + form removal only — the read wiring is a later increment.**

**⚠️ After merge:** `setupSheet()` must be **re-run once** (adds `OpeningChecklist` + `EmergencyReadiness`;
idempotent — existing data untouched). Apps Script deploys via clasp CI (no manual paste).

**Tests.** `management.test.js` rewritten (SLA, recurring-from-Requests, readiness summarizers);
`management-handler.test.js` rewritten to the trimmed payload + `safePanel_` isolation + the new
add/tick/delete/deleteCompliance handlers (real Code.gs in a sandbox, incl. audit row); new
`management-writes.test.js` (exec-only gate at the gateway) and `inventory-view-only.test.js` (form removed,
view kept). `node --test` green (**564 tests**). No secrets; explicit-path adds.

## [Unreleased] — PR A: production bugs — approve/reject guard, observable (non-permanent) pageData fallback, per-lead task view

**What.** Three production concerns on the dashboard / open-tasks flow, investigated read-only first, then
guarded and fixed with tests for every behavior change.

**1. Approval buttons (אישור / לא אושר) "do nothing" — investigation + regression guard.**
The dashboard cards POST `{action:'approve'|'reject', payload}` to `window.__EXEC_URL__`; the injected auth
shim rewrites that to `POST /api/action` with the session token as `Authorization: Bearer`, and `handleAction`
resolves the actor from the token (never the body) and forwards `{action, payload, token}` to Apps Script.
Reproducing the full chain in a headless DOM against the real gateway showed the **write path is sound** — the
POST leaves the browser with the correct forwarded token — so the live symptom is a **stale Apps Script deploy**
(see #2), not a client/gateway logic bug. Ruled out explicitly: the `bundle`→individual **fallback is
read-only and never touches the POST path**; the service worker never intercepts non-GET; no eval errors; the
Bearer header is attached on every write. Locked with a new end-to-end regression test so this can't silently
break again.

**2. Slow tab switches + intermittent errors — make the fallback OBSERVABLE and prove it isn't permanent.**
Root cause: when the live Apps Script predates the `bundle` action (a deploy-order skew, or clasp CI not
publishing the current `Code.gs`), every manager page falls back to N individual reads — slow, and silent.
`handlePageData` now sets **`degraded: true`** on the 200 response (and warn-logs) whenever the fallback is
taken, so the stale-deploy condition is visible instead of guessed. It is **not sticky** — the next request
re-attempts `bundle` and the flag clears the moment the deploy lands. `test/smoke-live.js` now **fails** a
post-deploy check when `pageData` is degraded — i.e. it verifies clasp actually deployed `bundle`.

**3. "לאן עוברות המשימות של רמי" — a per-lead view on the open-tasks list.**
Assigned tasks were visible on `/workorders` (העברה לביצוע / סטטוס ביצוע) but **mixed across all leads**, so a
maintenance lead couldn't isolate their own. Added a minimal per-lead filter (רמי / צחי / רועי / **הכל**) —
pure `filterByLead()` in `src/workorders.js`, mirrored inline in `workorders.html`, shown only on the two
open-task tabs. No scope/role change; display-only.

**New tests.** `test/dashboard-approve.test.js` (4): a manager's approve/reject reaches the fake upstream with
the correct **forwarded token** (not the body placeholder), reason payload forwarded, unauthenticated → 401 &
nothing forwarded, tier-B refused 403 before any upstream call. `test/pagedata.test.js` (+3): degraded flagged
on fallback, absent on the happy path, and **cleared once bundle is live again** (fallback-not-permanent).
`test/workorders.test.js` (+3): `filterByLead` per-lead isolation, the ALL sentinel, and nullish/mismatch
safety. `node --test` green (562 tests). No new sheets; no secrets.

## [Unreleased] — fix (Bug 3) — login roster comes from the live `doGet('users')`, not a hardcoded copy

**Symptoms.** The login picker could show a wrong/stale roster, and a valid user + the correct code was
rejected with **"שם או קוד שגויים"**.

**Root cause (one, shared).** The login picker was a **hardcoded name list** (`LOGIN_NAMES` in
`src/server.js`) that duplicated the Users roster. It had to be hand-kept in sync with the sheet, so any
roster edit — add / remove / **rename** / deactivate a user — made the dropdown **drift**: it could offer a
name that no longer matched a `Users` row, and selecting it + the correct code failed the exact-name lookup
in `handleLogin` → generic 401. The picker and the login **verifier** were reading two different sources of
truth for "who can log in."

**Fix — one shared users-read path, not per-screen.** The picker is now **derived from the live active
roster** (`doGet('users')`) — the same read the verifier uses — so the two can never disagree:
- `isActiveUser(u)` is the single "who is in the roster" predicate (tolerant of `TRUE`/`true`/`1`/boolean,
  trims whitespace), used by **both** the picker and `handleLogin`.
- `loginRosterNames(users)` derives the picker names from the roster: active-only, trimmed, de-duped.
- The server injects those live names into each page's auth shim (`buildClientShim(names)`), cached briefly
  (names-only, non-secret; TTL matches the micro-cache). Login **verification still reads the roster LIVE
  with the proof** — unchanged — so a just-added/renamed user authenticates immediately.
- **Fail-safe:** if the roster read is unavailable (deploy-window / upstream outage) the picker falls back
  to `DEFAULT_LOGIN_NAMES` (the seeded list) so it is **never empty**; a guard test keeps that fallback in
  sync with `setup.gs` `SEED_USERS`.

**Invariants preserved.** `users` is still **never cached or bundled** as the auth roster (the picker caches
only the derived *name list*, never `pin_hash`); `pin_hash` is still stripped from every public read; all
tier-A/tier-B/scope rules are untouched.

**New tests (`test/login-roster.test.js`, 28 cases).** The roster endpoint returns all active users and the
picker lists exactly them; a deactivated user drops out and a new one appears (no drift); **login succeeds
for every seeded user with the correct code** (tier-A personal password, tier-B `APP_PIN`); **login fails
closed on the wrong code**, on an empty code, and for a deactivated user; the fallback list stays in sync
with the seed. `node --test` green (552 tests).

## [Unreleased] — perf (round 2, safe reapply) — pageData aggregation + Node micro-cache, deploy-window-proof

Reintroduces the #62 performance work (one aggregated `pageData` call per page + a Node micro-cache for
houses/config/technicians) that was reverted for breaking production, WITH the root cause fixed and a
graceful fallback so it can never happen again.

**Root cause of the #62 breakage (a deploy-order race — not a logic bug; all 520 tests passed).** Railway
deploys the Node frontend and clasp deploys `apps-script/**` **independently**, and Railway is faster. #62
made every manager page call a NEW Apps Script `bundle` action, so during the window where new Node was
live but the old Apps Script (no `bundle`) still served, `bundle` returned `{ok:false,'Unknown or missing
action'}` and `handlePageData` turned that into a hard **502** — every manager page hung. The unit tests
mocked the upstream (the mock always knew `bundle`), so they never exercised "old Apps Script doesn't have
bundle." **Login itself never broke** (it reads the roster via `doGet('users')`, which every Apps Script
version knows) — but the app's pages were down, so it was reverted. Reproduced here (new Node + a mock old
Apps Script → the exact 502).

**Fix — graceful fallback (deploy order now irrelevant).** When `bundle` is unavailable (unknown action /
upstream error), Node **automatically falls back to the individual reads** (`fetchActionsIndividually`,
the proven pre-#62 path) and returns the same aggregated shape. A mixed-version window degrades to N reads
(works, just slower) instead of 502; a genuine upstream outage still surfaces as 502. The **login path
depends on no new code** — `handleLogin`/`fetchAppsScriptData('users')` are untouched and never call
`bundle`/`pageData` (locked by a test).

Everything else from #62 is unchanged and re-verified: same `canRead` gate + requests scope-filter as the
individual reads, Node micro-cache never caches users or requests, `users` never bundleable, per-page
round-trips 5/4/3/3/2 → 1 (cold), stable data from cache on warm tab switches. New tests: deploy-window
fallback (200 not 502), fallback still role-gates, real outage still 502, login independent of bundle.
`node --test` green.

## [Unreleased] — ci — permanent guards so login can never silently break again (post-deploy smoke + CI on every PR)

Three login regressions (#59, #61-branch, #62) all passed `node --test` yet broke in production, because
unit tests mock Apps Script and can't see the live chain or a mixed-version deploy window. Two guards:

- **`test/smoke-live.js`** — a post-deploy smoke test against the REAL app (`APP_URL` env var), run by
  hand after every merge (`APP_URL=… node test/smoke-live.js`; documented in the README). It verifies
  `GET /` → 200 with the login shim, `POST /api/login` (bogus user) → a proper JSON **401** (the whole
  Node→Apps Script auth path responds, not a crash/hang/HTML/5xx), and — when `SMOKE_USER`/`SMOKE_PIN`
  are set — one authenticated read end-to-end. Non-zero exit on any failure so it can gate a deploy. It
  is **not** a unit test: `npm test` now runs `node --test test/*.test.js`, excluding it.
- **`.github/workflows/test.yml`** — runs `npm test` (the full unit suite) on every pull request and every
  push to `main`, so nothing can merge or land red. (Previously only the Apps Script deploy + workflow-YAML
  validation ran in CI; the unit suite ran nowhere.)

No app code changed. `npm test` green.

## [Unreleased] — fix — role-visibility branch rebased onto the login fix; login page hardened + guarded

**Symptom.** After the role-based visibility work, the login page appeared dead — clicking כניסה did
nothing, silently.

**Root cause.** The role-visibility branch was cut from `main` **before** the login-regression fix landed
(the "auth roster read live" fix below). So that branch — and anything deployed from it — still carried the
**cached `getUsers()`**, reintroducing the stale-roster login failure the fix had removed. The branch was a
version behind, not a new shim bug: reproduced in real Chromium (`playwright-core` against the actual
server) that the shim's login overlay itself binds, POSTs `/api/login`, saves the session and closes — for
every role — so the client flow was sound; the failure came from the missing server-side fix.

**Fix.** Rebased the role-visibility change onto current `main` so it now includes the login fix
(`getUsers()` reads live). Additionally hardened the new nav redirect so it can **never** interfere with
the login page: it only bounces a KNOWN, authenticated role off a page it may not open — a logged-out view
(no role) and the request form `/` are never redirected, so the login overlay always owns the screen.

**Verified.** In real Chromium, a fresh login on `/` succeeds for coordinator / maintenance / field_ops /
ops_manager / ceo (overlay → POST `/api/login` → session saved → overlay closed, no page errors), and a
coordinator entering on a disallowed page (`/dashboard`) logs in and lands cleanly on `/`. New
`test/login-page.test.js` renders the ACTUAL served `/` (injected shim + index.html scripts) in a DOM
sandbox with real-browser timing and asserts the login submit path works end-to-end for **every role**,
plus that the redirect never fires on a logged-out view. `node --test` green.

## [Unreleased] — fix — login regression: the auth roster (Users) must be read live, never cached

**Symptom (URGENT, live).** Valid users (e.g. אולגה with the correct password) were rejected at login with
"שם או קוד שגויים". Started after the reference-cache perf merge (#59).

**Root cause.** #59 routed `getUsers()` — the **authentication source of truth** — through the new
cross-request reference cache (`readReference_`, CacheService, 120 s TTL). The Node login layer verifies
each password against `Users.pin_hash` read via `doGet('users')`; with Users cached, a login was verified
against a **stale roster**. Any Users edit — a freshly set/hand-edited `pin_hash`, an `active` toggle — was
invisible for up to the TTL, so correct credentials failed. It also wrote `pin_hash` (a secret) into the
shared script cache. Reproduced end-to-end (Node `handleLogin` roster-verify logic + the real `Code.gs`
`doGet('users')`): with a hash set *after* an earlier roster read cached the empty one, a correct password
was rejected.

**Fix.** `getUsers()` reads **live** again (`readObjects_('Users')`), never through `readReference_`. Users
is not a perf hot path — login is rare and `managementData` never reads it, so the #59 wins are untouched
(they came from Config ×4 and Houses ×4 in `managementData`, both still cached). Removed the now-moot
`invalidateReference_('Users')` calls from `setUserPin`/`setupSheet`. Config/Houses stay cached — they hold
no secret and tolerate short staleness; SESSION_SECRET is a Script Property, unaffected either way.

**Verified.** `managementData` 17→11 cold / 15→9 warm and dashboard 5→3 still hold. New
`test/login-path.test.js` drives the FULL live path (Node `verifyPin`/`checkPin`/`rosterProof` + real
`Code.gs` `doGet('users')`): a valid login succeeds, an invalid one still fails, the tier-B shared-PIN path
works, a `pin_hash` set after an earlier read is seen on the next login (the regression — fails against the
pre-fix handler), the public read still strips `pin_hash`, and `pin_hash` is never written to the shared
cache. `test/reference-cache.test.js` updated to assert Users is live. `node --test` green.
## [Unreleased] — feature — role-based page + data-action visibility (owner's required model)

Each role now sees and can reach only what the owner's model permits — enforced server-side (data gate)
AND in Code.gs (write gate), never UI-only, with the nav rendering only the links a role may open.

**Model.** coordinator → ONLY the new-request form (`/`) + their own house's request status (shown ON `/`)
+ event entry (`/events`); NO dashboard/inventory/reports/בקרה/משימות/management. maintenance → unchanged.
field_ops → everything EXCEPT `/management`. ops_manager + ceo → everything, including `/management`.

**New `src/access.js`** — the single source of truth:
- `canWriteAction(role, action)` — the write gate, in a `MIRROR:access` block duplicated verbatim in
  `Code.gs` (drift-guarded). Tier B is limited to `createRequest` (+ `createEvent` for coordinators);
  manager roles pass this early gate and are then subject to each handler's precise gate (canManage,
  canApprove, canDispatch, canBlock, isManagement_) — unchanged. This ALSO **closes a real gap**: several
  write handlers (`createInspection`, `addFinding`, `confirmFinding`, `submitInventory`, `editRequest`)
  had no server-side role check and were protected UI-only; tier B is now refused them server-side.
- `canRead(role, action)` — the read gate: houses/config/requests open to all (requests scope-filtered);
  users + the manager-only reads are manager-tier. (Reads are gated at the session-aware Node proxy; the
  Apps Script doGet carries no identity.)
- `navByRole()` / `canOpenPage(role, path)` — drive the nav shim.

**Enforcement layers.**
1. `src/server.js` — `/api/data` uses `canRead`; `/api/action` uses `canWriteAction` (early) then the
   existing exec checks (`managementData`/`updateEvent` stay exec-only; field_ops still 403 on both).
2. `apps-script/Code.gs` — `dispatchAction_` runs `canWriteAction` before dispatch, independently of the
   proxy, so a direct `/exec` POST from a tier-B role is refused. All existing handler gates untouched.
3. Nav shim — rebuilds `.nav` from `NAV_BY_ROLE` (injected from `navByRole()`, no drift) to show only the
   permitted links, and **redirects** a role away from a page it may not open. Display/UX only.

**`/` (index.html)** gains a coordinator-only "סטטוס הדרישות שלי" section — their own house's requests +
status (the server scope-filters the read); hidden for everyone else, who reach status via `/workorders`.

Not weakened: canManage, canBlock, the events create/edit rules, and the coordinator own-house scope all
still run. New tests: `test/access.test.js` (role × page and role × action matrix + nav ⇔ page-access),
`test/access-server.test.js` (the same matrix at the HTTP layer — 403 vs gate-passed — incl.
managementData/updateEvent staying exec-only and the closed ungated-write gap), `MIRROR:access` drift
guard, and `nav-events`/`nav-management` updated to the unified role-based nav (with a redirect test).
`node --test` green.

## [Unreleased] — perf — cache stable reference sheets (Config/Houses/Users) to cut redundant full-sheet reads

**Symptom.** Pages loaded slowly, `/management` worst. In Apps Script every `getDataRange().getValues()`
is a round-trip to the Sheets backend, so the number of full-sheet reads per request is the dominant cost.

**Measured before (instrumented sandbox driving the real `Code.gs`):**
- `managementData` — **17** sheet reads per request; **Houses read 4×** (direct + maintenance +
  compliance + events, each via `openHouseIds_`) and **Config read 4×** (`getConfig` re-reads the whole
  Config sheet — kitchen/coordinators/training ids + `compliance_reminder_days`). Warm (digest panels
  cached): 15.
- Dashboard load — 5 parallel GETs, and `houses`+`config` are re-read on **every** page load (dashboard,
  inspection, inventory, reports, workorders all fetch `houses`).

**Root cause.** `getConfig`→`getAllConfig`→`readObjects_('Config')` re-read the entire Config sheet on
every call, and `getHouses`/`getUsers` re-read their sheets on every call, with no memoization or caching.

**Fix — a reference-data cache for the STABLE sheets only (Config, Houses, Users).** These are edited by
hand or by `setupSheet()`/`setUserPin()`, never by the per-request write handlers. `readReference_(name)`
layers (1) a **per-execution memo** — dedupes repeated reads inside one request, zero staleness since one
`doPost` is one execution — over (2) **CacheService** with a short **120 s TTL** — dedupes reads across
requests. Every writer of a reference sheet (`setUserPin`, `setupSheet`) calls `invalidateReference_(name)`
so a write is visible on the next read; a hand edit propagates within the TTL. `getHouses`/`getUsers`/
`getAllConfig` now go through it. Requests/Inspections/Events/Budgets/Inventory are **deliberately not
cached** — they change constantly and must read live, so write→read freshness for the core workflow is
unchanged. PR #58's `safePanel_` isolation is untouched (a flaky `CacheService.get` still can't escape a
reader — `readReference_` catches it and falls back to a live read).

**Measured after:**
- `managementData` — **17 → 11** reads cold (Houses 4→1, Config 4→1 via the memo), **15 → 9** warm
  (Houses + Config served entirely from CacheService).
- Dashboard — repeat loads **5 → 3** reads; `houses`/`config` are free on every warm page load app-wide.

Data-freshness note: values on Config/Houses/Users now propagate within ≤120 s of a hand edit (was
immediate). Enforcement/scoping LOGIC is unchanged — the same checks run, against reference data at most
120 s old. New `test/reference-cache.test.js` fixtures the real `.gs` files and locks the memo dedupe,
cross-request cache hit, **write→next-read-fresh invalidation**, per-sheet eviction, and that Requests is
never cached. Service worker already serves static assets cache-first (unchanged). `node --test` green.

## [Unreleased] — fix — /management no longer blanks when a single panel read throws (training-digest fallout)

**Symptom.** After the training-digest consumption shipped and the `training_digest_id` Config row was
added by hand, `/management` failed **entirely** with the generic "שגיאה בטעינה. רענן/י ונסה/י שוב." — the
whole `managementData` call errored, not just the training panel.

**Root cause.** `handleManagementData_` aggregated **nine** reads with **zero fault isolation**, and
`doPost` had **no top-level catch**. `readTrainingCompliance_`'s `try/catch` wrapped only the
`SpreadsheetApp` read — *not* the `CacheService` calls, the `getConfig`, the id→name map, or the pure
shaper. Any throw from those escaped the reader, escaped the handler, and `doPost` returned a **non-JSON**
error page → the client's `res.json()` threw → the client's `catch` blanked the **entire** screen. A
no-access `openById` was already caught (panel degrades correctly); the killer was a throw *outside* that
inner `try`. Reproduced end-to-end by loading the real `.gs` files in a sandbox and driving the full
handler (`test/management-handler.test.js`), not just the pure shaper.

**Fix.**
- New `safePanel_(label, produce, fallback)` in `Code.gs` wraps **every** foreign/derived panel read
  (kitchen, coordinators, training, budget, maintenance, compliance, events). A throw is **logged** (so it
  surfaces in the Apps Script execution log with a stack) and degraded to that panel's own "unavailable"
  fallback — `{ available:false, reason }` for the digest panels, `null` for budget/maintenance/
  compliance/events (matching each panel's render check). One panel failing can **never** blank the screen.
- Hardened `readTrainingCompliance_` **and** `readKitchenShortages_` so the cache read (`cache.get` + parse)
  is inside `try/catch` — a flaky `CacheService` can't escape the reader.
- `doPost` now runs the action dispatch inside a top-level `try/catch` (extracted `dispatchAction_`):
  any uncaught handler error is logged and returned as JSON `{ ok:false, error:'Server error' }` — never a
  non-JSON crash that breaks the client's `res.json()`.

**Reading the real error.** With `safePanel_` in place, the actual thrown error for a failing panel is
written to the Apps Script execution log — Apps Script editor → **Executions**, open the `doPost` run for
the `managementData` call and read the `managementData panel "…" failed: <stack>` line.

New `test/management-handler.test.js` fixtures the full handler in a sandbox: `safePanel_` semantics, the
live-bug reproduction (a throw outside the inner try → `ok:true`, training degraded, other panels intact),
`safePanel_` isolating a panel with no inner guard (events), the happy path, and the `canManage` gate. It
**fails against the pre-fix handler and passes after**. No mirrored logic block changed (the pure training
shaper is untouched); `node --test` green.

## [Unreleased] — feature — /management reads the coordinators TrainingCompliance digest (READ-ONLY)

Replaces the static "עמידה בתוכנית הדרכה — לא זמין" card on `/management` with a **live, read-only** panel
driven by the coordinators-published digest (a **separate** spreadsheet, tab `TrainingCompliance`). Built
exactly like the kitchen food-shortages consumption (`MIRROR:digestconsume`): a pure, drift-guarded shaper
plus a thin cached read in `Code.gs`. This app is a **read-only consumer** — it never writes into the
coordinators' digest.

**New Config key `training_digest_id`** — seeded by `setupSheet()` (upsert by key) with the digest id on
BOTH sides (`src/schema.js` + `apps-script/setup.gs`, same position, drift-guarded). The id is **never
hardcoded in the read path**; a **blank** value renders the panel "לא זמין". Grant the Logistics Apps
Script account VIEWER access to that spreadsheet for the read to work.

**New pure shaper `src/training-digest.js`** (`MIRROR:trainingdigest`, mirrored VERBATIM in `Code.gs`,
asserted by `test/mirror-drift.test.js`). Headers are read **BY NAME** (`house, guideName, firstAidStatus,
firstAidDate, instructorStatus, instructorDate, overallStatus`; `updatedAt` optional) — column order never
matters. Per house: counts by `overallStatus`, compliance percent (`ok / total`), and guides listed
**worst-first** (blocked → notRecorded → warn → ok) with which training is lacking (עזרה ראשונה / הדרכת
מדריכים) and dates as **dd/mm/yyyy**. `notRecorded` is kept **distinct** and never counted as `ok` (a
neutral gray pill in the UI, never green). Every canonical house gets an entry: a house **absent** from
the digest shows "אין נתונים לבית זה" — **distinguished** from the whole digest being unavailable. House
ids that don't map to `HOUSE-IDS.md` are **omitted, never guessed**.

**Read path `readTrainingCompliance_()` in `Code.gs`** — inside the `canManage`-gated `managementData`
handler (ops_manager + ceo; enforced server-side AND in `Code.gs`), cached ~5 min (`CacheService`).
**Fail-visible:** no id / no access / missing tab / header mismatch → an explicit "לא זמין" card with the
reason — never a silent empty state, never a fabricated 0, never crashing the rest of the screen.

`training_adherence` is removed from `UNAVAILABLE_CAPABILITIES` (now a live panel), matching the
food/budget/maintenance precedent. New `test/training-digest.test.js` covers by-name reads, notRecorded
never counting as ok, worst-first ordering, absent-house vs digest-unavailable, header mismatch, and date
formatting; `node --test` green.

## [Unreleased] — feature — exceptional-events register (אירועים חריגים) with a field entry UI + /management analysis

Olga's JD requires מעקב אחר אירועים חריגים, הפקת לקחים ויישום פעולות מתקנות, and her success metric is a
drop in RECURRING exceptional events. This adds a register with a **field entry UI** (unlike the
fill-in-Sheet modules) and a /management analysis panel.

**New `Events` sheet** (`id, created_at, created_by, house, occurred_at, event_type, severity,
description, immediate_action, root_cause, lessons, corrective_request_id, status, closed_at, notes`),
created empty + idempotently by `setupSheet()`. `created_by` is the **session identity** (never
client-supplied); `house` is a canonical id; `event_type` comes from the new Config key **`event_types`**
(seeded `בטיחות|תרופות|התנהגות|תשתיות|תברואה|אחר`, parseable like `sla_days` — malformed → the form falls
back to אחר only, logged). Operational fields ONLY — never any clinical/medical record content.

**Entry UI at `/events`** — a report form (house, occurred_at, type, severity, description,
immediate_action). The auth shim injects an "אירועים חריגים" nav link for every role that may report
(everyone except maintenance). Managers additionally see the register list; ops_manager/ceo get inline
edit/close.

**Permissions (server-side AND Code.gs):** CREATE is allowed for coordinator (**own house only**),
field_ops, ops_manager, ceo — **maintenance cannot** (gateway 403 + Code.gs `forbidden_`). EDIT/close
(root_cause, lessons, corrective_request_id, status) is **ops_manager + ceo only**. Closing REQUIRES
root_cause AND lessons (rejected server-side otherwise). A linked corrective Request id is validated to
exist (no auto-creation this increment). Every create/edit/close is written to AuditLog with actor +
timestamp. `occurred_at` is parsed **day-first** via the shared parser.

**/management panel (canManage-gated):** open events worst-first (severity, then age); **recurrence** —
same event_type + house 2+ times in a trailing 90 days flagged חוזר with its count (the JD success
metric); monthly trend over the last 6 months; events missing lessons highlighted. A house with no open
events shows **"אין אירועים" — a TRUE zero** (the register is always available, distinct from
data-unavailable). No events data enters any digest.

**Mirror + tests:** the pure logic lives in `src/events.js` behind a `MIRROR:events` fence duplicated
verbatim in `apps-script/Code.gs` (drift-guarded); it reuses `houseInScope` (roles.js) and
`maintDateOnly`/`maintDaysBetween` (maintenance.js). New `test/events.test.js` covers create permission
per role incl. coordinator own-house-only + maintenance-blocked, created_by-from-token, close requires
root_cause+lessons, corrective-link validation, event_types fallback, recurrence at exactly 2 in 90 days
(not at 1, not at 91 apart), day-first occurred_at, and panel zero-vs-unavailable. `test/staff-tiers.test.js`
adds the server-side 403 gates; `test/nav-events.test.js` drives the injected nav link; schema +
mirror-drift extended for `Events` and `event_types`. Full `node --test` suite green (436).

> **After this merge:** re-run **`setupSheet()`** once (creates the `Events` sheet and adds the
> `event_types` Config row — existing rows untouched). No trigger. The entry UI lives at **`/events`**
> (nav link auto-appears for all roles except maintenance). Tune the category list by editing the
> `event_types` Config cell — no deploy.

## [Unreleased] — bug fix — Israeli day-first date parsing for Sheet-filled dates

**Problem:** Olga fills dates in the Sheets in the Israeli convention **day/month/year** (e.g. `12/7/2026`
= 12 July). With the spreadsheet in a US locale, Google Sheets parsed that as 7 December — and any cell
stored as *text* never reached the app as a date at all — so the /management screen showed wrong (or
missing) expiry/due dates. The affected fields are the two **hand-typed** Sheet dates: `Compliance.expires_at`
and `MaintenancePlan.last_done`. (`Budgets.period` is `YYYY-MM` — locale-agnostic — and every other date
field comes from an in-app date-picker as ISO, never hand-typed; an audit confirmed no others.)

**Fix — two levels:**

1. **Spreadsheet locale (manual, fixes entry going forward):** set **File ▸ Settings ▸ Locale = Israel** so
   Sheets itself parses `d/m/y` natively and hands the app a real `Date` object.
2. **Code robustness (this PR):** the ONE shared parser `maintDateOnly` (in the `MIRROR:maintenance` block,
   drift-guarded, reused by both maintenance and compliance) now accepts (a) a real **Date** object — trusted
   as-is; (b) an **ISO** `yyyy-mm-dd` string; and (c) an Israeli **DAY-FIRST** text date `d/m/y` or `d.m.y`
   (`12/7/2026`, `12.7.26`, `12/07/2026`) — **always day-first, never month-first**, 2-digit year → `20xx`.
   An impossible date (`13/13/2026`, `31/2/2026`) → `''`, so the caller skips + logs it (never a guessed
   date). The day-first branch is the safety net for cells stored as text; with locale = Israel, branch (a)
   handles it.

**Display:** an audit of every `fmtDate` (management, dashboard, reports) confirmed they *already* render
**dd/mm/yyyy** from the normalized ISO value — no change needed; the bug was purely on the parse side.

**Tests:** the shared parser gains Israeli day-first cases (`12/7/2026` → 12 Jul, `12.7.26` → 12 Jul,
`31/12/2026` valid, `13/13/2026` & `31/2/2026` → skip) plus Date-passthrough / ISO regression; a compliance
test drives a day-first `expires_at` end-to-end through `parseComplianceRow` (parse + skip-and-log the
impossible one). Every existing date-dependent suite stays green; mirror-drift covers the parser. Full
`node --test` suite green (412).

> **After this merge:** no `setupSheet()` re-run and no data migration. Set the **spreadsheet locale to
> Israel** (File ▸ Settings ▸ Locale) so new entries parse natively; the code change already recovers
> existing text-typed `d/m/y` cells on the next read.

## [Unreleased] — rename — compliance display name "עמידה ברגולציה" → "עמידה באמות מידה"

Display-text-only rename of the compliance tracker's user-facing Hebrew name from **"עמידה ברגולציה"**
to **"עמידה באמות מידה"**. Nothing structural changed — the `Compliance` sheet, its columns, the
`compliance_id` Requests column, the `compliance_reminder_days` Config key, and every `compliance*`
function/id keep their names.

Renamed everywhere the user sees it: the /management panel heading, the empty-state / unavailable texts
("אין נתוני אמות מידה", "לא הוגדרו פריטי אמות מידה", the skipped-rows note), and the generated renewal
request's description suffix "(עמידה ברגולציה)" → "(עמידה באמות מידה)".

**`created_by` WAS renamed** "מערכת - רגולציה" → **"מערכת - אמות מידה"** (and the matching AuditLog
author + note). This is safe: the idempotent dedup keys **only** on `compliance_id + house`
(`complianceGenerationPlan`), never on `created_by`, so already-open generated requests — which carry
their `compliance_id` — are still matched and never re-created. The rename touches the `MIRROR:compliance`
string literals identically in `src/compliance.js` and `apps-script/Code.gs`, so the drift guard stays
green.

**Tests:** the `test/compliance.test.js` request-shaping assertions now expect the new description suffix
and `created_by`. Full `node --test` suite green (409). No `setupSheet()` re-run, no data migration — the
change is display text (a code deploy suffices).

## [Unreleased] — feature — compliance tracker (עמידה ברגולציה — תעודות, רישיונות, תוקף ותזכורות) on /management

Olga's "עמידה ברגולציה" was "לא זמין". This adds the data model, a reminder generator, and the
adherence panel so per-house certificates/licenses/inspections (e.g. *רישיון עסק, ביטוח, בדיקת גז,
גלאי עשן, תו תקן מטבח*) with an expiry are **tracked**, **surfaced** when expiring/expired, and turned
into renewal requests **ahead of time**.

**New `Compliance` sheet** (`id, house, item, expires_at, reminder_days, doc_url, notes, active`) —
created empty + idempotently by `setupSheet()`; Olga fills rows in the Sheet (no entry UI this
increment). `house` = a **canonical id** (HOUSE-IDS.md) **or** `all` (every OPEN house). `reminder_days`
blank = the Config default. **`days_to_expiry` / `status` are DERIVED, never stored.** A new append-only
`compliance_id` column on **Requests** links a generated renewal to its row. New Config key
**`compliance_reminder_days`** (seeded **30**), read like `sla_days` — a malformed value is logged and
falls back to the seed, never a silent number beyond it.

**Status:** `בתוקף` (valid) / `פג בקרוב` (expiring — within the reminder window, `0 ≤ days ≤ reminder`,
so the expiry day itself is "expiring") / `פג תוקף` (expired — `days < 0`), worst-first.

**Reminder generation** rides on the **existing daily scan** (`runMaintenanceScan`, 06:00) — **no new
trigger to install.** For each **active** item that is expiring or expired it creates a **normal**
Request — category `תיקון`, urgency **`דחוף` if expired / `רגיל` if expiring**, `created_by` =
"מערכת - רגולציה", description = "חידוש: <item> — <house> (עמידה ברגולציה)" — through the **same approval
chain + SLA**. **Idempotent** (one open request per compliance id + house; a terminal one lets the next
cycle regenerate). An `all` item expands to every open house. **On completion NOTHING is written back** —
the new expiry lives on the new certificate, so Olga updates `expires_at` by hand (the panel keeps
showing expiring/expired until she does). Malformed rows (missing id/item, blank/unparseable
`expires_at`, unknown house id) are skipped and logged.

**Panel:** the /management "עמידה ברגולציה" section (canManage-gated) shows compliance **per house**,
worst-first (expired first, then soonest-to-expire), with days-to-expiry and a **doc link** when
present. A house with **no rows** shows "לא הוגדרו פריטי רגולציה" — never a fabricated 0. **No
compliance data enters any digest.**

**Mirror + enforcement:** pure logic in `src/compliance.js` behind a `MIRROR:compliance` fence
duplicated verbatim in `apps-script/Code.gs` (drift-guarded). It reuses four date/house primitives from
`maintenance.js` (`maintDateOnly`, `maintDaysBetween`, `maintActive`, `expandHouses`) so both features
share one implementation. Role gate enforced server-side and in Code.gs (compliance data rides on the
`managementData` `canManage` gate).

**Tests:** new `test/compliance.test.js` — status derivation incl. the boundaries at **exactly
reminder_days** and at **0**, per-row `reminder_days` override, blank/malformed `expires_at` skipping,
duplicate-prevention (open blocks, terminal doesn't), renewal shaping (`compliance_id` + `דחוף`/`רגיל`),
a guard that the module has **no completion write-back**, inactive rows never generating, `all`
expansion, and the panel's unavailable-vs-zero discipline. Schema + mirror-drift tests extended for
`Compliance`, the `compliance_id` column and the new Config key. Full `node --test` suite green (409).

> **After this merge:** re-run **`setupSheet()`** once (creates the `Compliance` sheet, appends the
> `compliance_id` column to Requests, and adds the `compliance_reminder_days` Config row — existing rows
> untouched). **No new trigger** — the compliance pass runs on the already-installed daily
> `runMaintenanceScan` trigger. Olga fills `Compliance` rows (`house` = canonical id or `all`, an
> `expires_at` date, `active` = `TRUE`; `reminder_days` optional). Nothing is written to any digest.

## [Unreleased] — feature — preventive-maintenance scheduler (תחזוקה מונעת) on /management

Olga's "עמידה בתוכנית תחזוקה מונעת" was "לא זמין" (no recurring-maintenance source existed — every
request was reactive). This adds the data model, the generator, and the adherence panel so recurring
tasks (e.g. *בדיקת מטפי כיבוי כל 6 חודשים*) are tracked and turned into ordinary requests when due.

**New `MaintenancePlan` sheet** (`id, house, task, frequency_months, last_done, active, notes`) —
created empty and idempotently by `setupSheet()`; Olga fills rows in the Sheet (no entry UI this
increment). `house` is a **canonical id** (HOUSE-IDS.md) **or** the literal `all` (every OPEN house).
`last_done` blank = *never done* → due immediately. **`next_due` / `days_until` / `overdue` are DERIVED,
never stored.** A new append-only `plan_id` column on **Requests** links a generated request back to its
plan row (blank for a normal request).

**Generation** — a daily time-based trigger (`installMaintenanceTrigger`, 06:00) runs
`runMaintenanceScan()`: for each **active, due** plan it creates a **normal** Request (category `תיקון`,
urgency `רגיל`, `created_by` = "מערכת - תחזוקה מונעת", description = *task* + " (תחזוקה מונעת)") that flows
through the **same approval chain + SLA** as any request. It is **idempotent** — never a second OPEN
request for the same plan+house (a still-open request blocks; a terminal one — הושלם/סגור/לא מאושר —
lets the next cycle regenerate). An `all` plan expands to every open house. When a generated request
reaches **הושלם** (via either completion path), the plan row's `last_done` is written back — the one
write to the plan sheet. Malformed rows (bad frequency, unknown house id, missing id/task) are skipped
and logged, never miscounted.

**Panel** — the /management "תחזוקה מונעת" section (canManage-gated, same 403 authority) shows
plan adherence **per house**, worst-first (overdue first, then soonest-due), with last-done / next-due
dates. A house with **no plan row** shows "לא הוגדרה תוכנית" — **never a fabricated 0**. No plan/
maintenance data enters any digest.

**Mirror + enforcement:** the pure logic lives in `src/maintenance.js` behind a `MIRROR:maintenance`
fence duplicated verbatim in `apps-script/Code.gs` (drift-guarded). The role gate is enforced
server-side and in Code.gs (maintenance data rides on the `managementData` `canManage` gate).

**Tests:** a new `test/maintenance.test.js` covers next_due derivation (incl. blank last_done → due
now, month-end clamping), due/overdue, duplicate-prevention (open blocks, terminal doesn't), request
shaping (plan_id + normal category/urgency), last_done write-back, inactive/malformed skipping, `all`
expansion to every open house, and the panel's unavailable-vs-zero discipline. Schema + mirror-drift
tests extended for `MaintenancePlan` and the `plan_id` column; the management "unavailable" list drops
`preventive_maintenance` (now live). Full `node --test` suite green (381).

> **After this merge:** re-run **`setupSheet()`** once (creates the `MaintenancePlan` sheet and appends
> the `plan_id` column to Requests — existing rows are untouched), then run **`installMaintenanceTrigger()`**
> once to install the daily scan. Olga fills `MaintenancePlan` rows (house = canonical id or `all`,
> a positive `frequency_months`, `active` = `TRUE`). Nothing is written to any digest.

## [Unreleased] — feature — "ניהול תפעולי רשת" nav link to /management (exec-only, display)

A nav link labeled **"ניהול תפעולי רשת"** → `/management` now appears in the nav on **every** page,
shown **only** when the logged-in session role is `ops_manager` or `ceo` (hidden for coordinator /
field_ops / maintenance). It's **display-only** convenience — the server + Code.gs `canManage` **403**
gate remains the sole authority (unchanged).

The auth shim already knows the session role (`window.__ROLE__`), so it injects the link into each
page's `.nav` for exec roles — **no per-page edits**, and it can't show for a non-exec (the shim never
adds it). The link is marked active on the /management page. The hardcoded `/management` link was
removed from management.html's own nav so it too is exec-gated by the shim. The /management page
**title and heading are now "ניהול תפעולי רשת"**.

**Tests:** a sandbox drives the real injected shim per role and asserts the nav link is present for
ops_manager/ceo, **absent** for coordinator/field_ops/maintenance and for a logged-out session, and
marked active on /management. Full `node --test` suite green (348).

> **After this merge:** no `setupSheet()` re-run, sheet edits, or digest rebuild. Purely a client-side
> nav convenience injected by the gateway; effective on next page load.

## [Unreleased] — feature — budget adherence (עמידה בתקציב) on /management

Olga's "עמידה בתקציב" was "לא זמין" (no budget data existed). This adds the data model + the panel.

**New `Budgets` sheet** (`HEADERS.Budgets = house, period, amount, notes`) — created empty and
idempotently by `setupSheet()`; append-only. One row per house per month: `house` is a CANONICAL id
(HOUSE-IDS.md), `period` is `YYYY-MM`, `amount` is NIS. **Olga fills rows directly in the Sheet** —
no budget-entry UI in this increment.

**Actuals from data we already own — one pure attribution rule (`attributeRequest`):** a request's
spend = `actual_cost`, falling back to `estimated_cost` when actual is blank (**the panel flags which
was used** with `*`), attributed to the request's house (Hebrew name → canonical id; unmapped houses
omitted, never guessed) and to the **month of `completed_at`, else `created_at`**. Rejected requests
(`לא מאושר`) never count as spend.

**Pure logic `src/budget.js`, mirrored into Code.gs under `MIRROR:budget` (drift-guarded):** per house
per period → budget, actual, remaining, percent used, over-budget flag. **A house with no budget row
renders "לא הוגדר תקציב" — never 0, never assumed** (and a house that spent with no budget still shows,
flagged). **Malformed budget rows** (bad `period` format, non-numeric/negative `amount`, unknown house
id) are **skipped and logged**, never silently miscounted.

**/management panel:** current month per house — budget vs actual, % used, over-budget highlighted
**worst-first**, with a **month selector** for past months (re-requests the screen for the chosen month;
the server recomputes). Computed server-side inside the existing **`canManage`-gated** `managementData`
handler (ops_manager + ceo; field_ops/coordinator/maintenance → 403), enforced in `server.js` AND
`Code.gs`. **Financial figures appear ONLY here and are NEVER written to any digest** — a guard test
asserts no budget/financial column exists in the OpenTickets or WeeklyCounts tabs.

**Tests (344 pass):** the attribution rule (actual vs estimated fallback, month bucketing, completed
vs not, rejected/unmapped omitted); adherence math + worst-first; missing budget → not-defined (not 0);
budget-but-no-spend → actual 0; malformed rows skipped+logged; the month-selector period list; the
`MIRROR:budget` drift guard; the `Budgets` header in the schema⇄setup mirror + `SHEET_NAMES`;
managementData 403 for field_ops/coordinator/maintenance; and the no-financial-columns-in-any-digest guard.

> **⚠ After this merge:** re-run **`setupSheet()`** once to create the `Budgets` sheet (empty, with
> headers). Then **Olga fills Budgets rows** — one per house (canonical id) per month (`YYYY-MM`),
> amount in NIS. Until a house/month has a budget row it shows "לא הוגדר תקציב" (never a fake 0). No
> other sheet changes; nothing financial is added to any digest.

## [Unreleased] — feature — /management reads the kitchen digest (read-only) for food shortages

The /management screen (ops_manager + ceo) previously marked food/kitchen data as "לא זמין" because
this repo had no digest-read wiring. It now **reads the ezone-kitchen digest read-only** and shows a
live **food-shortages-per-house** panel, per DIGEST-CONTRACT.md discipline.

**Coordinators digest:** none exists to read — every "coordinators digest" in this repo is the digest
this app *publishes for* the coordinators app, not one they publish for us. So this wires **kitchen
only**; the coordinators panel stays "לא זמין" with a note (and a blank `coordinators_digest_id` Config
key reserved for if one is ever published).

**Config-driven ids (never hardcoded):** new Config keys `kitchen_digest_id` (seeded with the known
kitchen digest id) and `coordinators_digest_id` (blank). A blank id renders that panel "לא זמין".

**Read path (`apps-script/Code.gs`, inside the `canManage`-gated `managementData` handler):**
`SpreadsheetApp.openById(<config id>)` → tab **FoodShortages** → rows read **by header name** →
shaped per house. Cached in `CacheService` for ~5 min so the screen never hammers the foreign sheet.
Every failure mode — no id, no access, missing tab, missing headers — renders **"לא זמין — …"**, never
0 and never a crash of the rest of the screen. It only READS; it never writes into another app.

**Pure shaping (`src/digest-consume.js`, mirrored into Code.gs under `MIRROR:digestconsume`, drift-
guarded):** `summarizeFoodShortages` reads by header name (order-independent), **omits any house whose
id isn't a canonical HOUSE-IDS.md id** (never guessed), returns available-but-empty for an empty tab,
and "unavailable" for a missing header; `foodShortagesPanel` maps a read context (blank id / read error
/ missing tab / rows) to the panel. Houses are keyed by canonical id and displayed with the **city-first
Hebrew names**. No financial fields are read or emitted.

**Tests (330 pass):** header-name mapping robust to reordered columns; house-column/item-column aliases;
unmapped house omitted; empty tab → available-empty; missing header → unavailable; blank config id →
unavailable; read-failure → unavailable (not zero); the `MIRROR:digestconsume` drift guard; the new
Config keys in the schema⇄setup mirror; role gating unchanged (managementData still 403s for
field_ops/maintenance/coordinator).

> **⚠ After this merge:** re-run **`setupSheet()`** once to upsert the two new Config keys
> (`kitchen_digest_id`, `coordinators_digest_id`). **Grant the Logistics Apps Script account VIEWER
> access to the kitchen spreadsheet** (id `1sJ62…zfE`) — until then the panel reads "לא זמין — שגיאת
> קריאה" (loud, never zero). No sheet-column changes; the kitchen digest is read, never written.

## [Unreleased] — feature — sign-out (התנתקות) on every page

A sign-out control is now shown on **every** served page (all 7 routes). It's injected by the auth
shim (which already runs on every route), so it appears without touching each page: a fixed
RTL-Hebrew **"התנתקות"** button in the corner, visible whenever a session is active.

**What it does:** clears the persisted session — the `localStorage` token + expiry AND the in-memory
token/role/scope — then reloads, which drops the user back to the login prompt. **No server call:**
session tokens are **stateless HMAC** (`src/auth.js` signs/verifies them with no server-side session
store or blacklist — verified), so there is nothing to revoke server-side; clearing the client token
is a complete sign-out. The token's own `exp` claim and the server's independent verification remain
the security boundary regardless.

**Tests:** the per-route guard now also asserts every served HTML page carries the sign-out control;
a new sandbox test drives the real injected shim and proves that after a sign-out click the persisted
token is removed, the in-memory session flag is cleared, and the next data call is **unauthenticated**
(blocked behind the login prompt — no Bearer sent). Full `node --test` suite green (320).

> **After this merge:** no `setupSheet()` re-run, sheet edits, or digest rebuild. Purely a client-side
> control injected by the gateway; it takes effect on next page load.

## [Unreleased] — bugfix — service worker served stale HTML on non-shell pages, re-prompting for login

**Follow-up to the #46 session fix.** After one login, the shell pages accepted the persisted session
but a third page still re-prompted for the PIN.

**Root cause — the service worker, not a missing shim.** Every served page *does* carry the persisted
-session auth shim (the Node gateway injects it into `<head>` on all routes — now locked by a guard test
that enumerates every served HTML route). The failure was `src/public/sw.js`: only the shell documents
(`/`, `/index.html`, `/dashboard`) were **network-first**; the other app documents — **`/inspection`,
`/inventory`, `/reports`, `/workorders`, and `/management`** (added in increment 37) — fell through to
**cache-first**. Clients with a pre-#46 cache kept serving the OLD cached HTML for those pages, which
ran the previous in-memory-only shim (no `localStorage` rehydrate) and so re-prompted. The shell pages,
being network-first, fetched the new shim — hence "two pages accept, the third prompts".

**Fix (`src/public/sw.js`):**
- Every app document is now **network-first** — by an explicit route list (each route's extensionless
  AND `.html` form) PLUS a `request.mode === 'navigate'` catch-all, so any page load fetches fresh HTML
  and a newly added page can't silently regress to cache-first.
- Bumped the cache `ezone-logistics-v2` → **`v3`** so the `activate` handler purges the stale v2 entries
  (the old cached documents) on the next service-worker activation.
- Static assets (icons, manifest) stay cache-first for instant loads — unchanged.

**Tests:** a new guard enumerates EVERY served HTML route (from the server's own route table) and
asserts each carries the shim in `<head>` before its page scripts, with the `localStorage` persistence
markers — so a future page that misses the shim fails loudly. The service-worker test now asserts all
app documents are network-first (static assets stay cache-first) and that the cache version was bumped.
Full `node --test` suite green (318).

> **After this merge:** no `setupSheet()` re-run, sheet edits, or digest rebuild. Service workers update
> lazily: the new SW (`skipWaiting` + `clients.claim` already in place) takes over on the next load and
> the v3 bump clears the stale cache on activate. Existing users may need **one refresh** (or to close
> all app tabs once) for the new worker to activate; after that every page shares the one session.

## [Unreleased] — bugfix — session persists across pages; manager-tier request visibility restored

Two owner-reported bugs, one shared root cause in the browser session layer.

**BUG 2 — session did not persist across pages/tabs (root cause).** The client auth shim kept the
session token in an in-memory closure variable only (a deliberate "never store it" choice). Every
full-page navigation started a fresh shim with `TOKEN=null`, so moving to any other tab/page
re-prompted for the password. **Fix (`src/server.js` shim):** the token is now persisted in
`localStorage` with an expiry mirrored from `SESSION_DAYS`, rehydrated BEFORE the page's own scripts
run, and cleared on 401/expiry. One login is now valid across every page and tab until it expires.
`localStorage` (not `sessionStorage`) so it is shared across tabs; the server token's own `exp` claim
stays authoritative.

**BUG 1 — manager-tier roles saw no requests; only a coordinator login worked.** Investigated the read
path end to end. The **server-side scoping was already correct** — reproduced directly: with a valid
token, field_ops and ops_manager both receive ALL houses' requests, a coordinator only their own
(now locked by tests). The real cause was the session layer above: because the token did not persist
(BUG 2), a manager's authenticated identity was lost on the request-listing pages, so their reads were
not authenticated as a manager; in the owner's flow only the coordinator session (shared PIN, easy to
re-enter) "stuck". Persisting the session (above) keeps managers authenticated across all pages, so the
server returns every house's requests as intended.

Two supporting server-side fixes made while here:
- **Fail-closed read scoping (`src/server.js`).** A scoped `requests` read by an authenticated session
  whose role is neither a known manager nor coordinator/maintenance now returns a loud **403** instead
  of a silently-empty filtered list — so any future role/roster mismatch surfaces instead of masquerading
  as "manager sees nothing". Managers (unfiltered) and coordinators/maintenance (scoped) are unchanged.
- **Latent `handleAction` crash (from increment 37).** The `managementData` gate referenced `actor.role`
  but `handleAction` never destructured `actor` from the verified auth — so every POST to `/api/action`
  for `managementData` threw `ReferenceError` and hung (the /management screen's data load). No test had
  POSTed it through the gateway, so it shipped unnoticed. Fixed by resolving `actor` from the token; the
  exec-only gate now works server-side, with `Code.gs` `handleManagementData_` still enforcing independently.

**Tests:** both manager tiers (field_ops + ops_manager) read all houses when logged in as themselves; a
coordinator reads only their house; an unauthenticated scoped read is rejected (401); an unknown-role
session fails closed (403); one login token is accepted across both page endpoints (GET `/api/data` and
POST `/api/action`); and the served shim persists the session (localStorage, rehydrate, expiry). Full
`node --test` suite green (317).

> **After this merge:** no `setupSheet()` re-run, no sheet-cell edits, no digest rebuild. Users will be
> asked to log in once more after deploy (the new persisted-session format), then stay logged in across
> pages/tabs until `SESSION_DAYS`. If a manager still cannot log in *as themselves*, their tier-A
> personal password was never set — run `setUserPin('רועי', …)` / `setUserPin('אולגה', …)` once in the
> Apps Script editor (unrelated to this fix; it is how tier-A passwords are provisioned).

## [Unreleased] — increment 37 — /management network-management screen for the ops manager + CEO

**Why:** Olga's role (מנהלת תפעול, איכות והטמעה רשתית) needs a single network-management view. This
increment builds it from Olga's approved JD — but ONLY the parts that have a real data source in this
repo. Every JD metric that has no source is shown explicitly as **"לא זמין"**, never faked as a number.

**Role-gated to ops_manager + ceo.** New `canManage` predicate (in `MIRROR:roles`, both `src/roles.js`
and `Code.gs`). Data is served via a POST action `managementData` so the token identity is verified
(a `doGet` is not identity-checked); refused **403 in `Code.gs` AND in `server.js`** for every other
role — including field_ops (Roy), who is manager-tier for dispatch but not an exec. Not UI-only.

**JD → capabilities, mapped by data source.** Built (data this repo owns):
- **Delays / SLA** (Roy's הצפת עיכובים): open / overdue / blocked requests, by house, worst-first.
- **סגירת ליקויים במועד** (Olga's headline): physical-defect findings → their linked requests, closed
  on-time vs late; the on-time RATE is **unavailable until a defect closes against a due date** (never 0%).
- **רמת הבתים + recurring exceptions**: per house — last inspection, open defects by severity, and
  defects that recur (same text ≥2×).
- **Spend** (Logistics owns cost): estimated/actual by house + category.
- **Pre-opening readiness**: for pre-opening houses — open requests, open defects, stock counted?

**Reported, NOT built** (no data source in this repo — listed on-screen with what each would need):
עמידה בתקציב (no budget source) · איכות ובטיחות מזון (owned by ezone-kitchen; the kitchen-digest read
is **not wired** here) · תחזוקה מונעת (no preventive-maintenance schedule) · הדרכה · הטמעת מערכות ·
איכות הרשומה/עמידת משרד הבריאות (clinical apps). No kitchen or coordinator digest is read — that
plumbing does not exist in this repo, so it is reported rather than invented.

**Honesty discipline:** nothing on the screen shows a number it cannot source; absent metrics render
as "לא זמין", the same missing-vs-zero rule as elsewhere. The screen writes nothing to any app.

**Files:** new pure `src/management.js` (unit-tested), `src/management.html` (renders via an inline
mirror), a `/management` route, `handleManagementData_` in `Code.gs`, and the `canManage` gate in
`server.js`.

**Tests:** each panel against fixtures; the on-time rate + budget adherence render **unavailable, not
zero**, on empty data; `canManage` gating (ops_manager/ceo pass; field_ops/coordinator/maintenance
refused); the `MIRROR:roles` drift guard covers `canManage`. Full `node --test` suite green (312).

> **After this merge:** no `setupSheet()` re-run, no sheet-cell edits, no digest rebuild — the screen
> only reads existing sheets. Reach it at `/management` (visible to ops_manager + ceo; others get a
> "no access" screen). It is deliberately not linked from the other pages' nav yet.

## [Unreleased] — increment 36 — SLA due dates + aging (overdue / blocked), surfaced on the list and the digest

**Why:** two needs from one build — Roy's הצפת עיכובים (delays surfaced in real time) and Olga's
סגירת ליקויים במועד (closing findings on time). Requests now carry a **due date** derived from urgency,
and the list + digest show what is **overdue** or **blocked** at a glance.

**Schema — APPEND-ONLY (existing rows/positions untouched).** `Requests` gains `due_at`, `blocked`,
`blocked_reason`, `blocked_at`. `Config` gains **`sla_days`** — a parseable `urgency:days` spec
(`חירום:1|דחוף:3|רגיל:14`), tunable in the Sheet with no deploy, read exactly like `allowed_units`:
a malformed spec (or an unknown urgency) yields **no due date, logged**, never a silently wrong default.

**Due date + aging (`src/sla.js`, mirrored verbatim into `Code.gs` under `MIRROR:sla`).**
- `due_at = created_at + days-for-urgency`, derived at creation; **re-derived when urgency changes**.
- **Deferral parks the SLA:** while a request is `נדחה לתאריך` it is never overdue; on **wake-up**
  (approved out of deferral) `due_at` is re-derived from the **deferral date forward**, not from
  creation — a woken request that then passes its new due date IS overdue.
- Derived, never stored: `days_open` (created→now, **freezes at completion**), `overdue` (due passed
  and not completed/closed/deferred), `days_overdue`.

**Blocked is a manual flag, not a pause.** Set by field_ops / ops_manager / ceo (new `setBlocked`
action, gated by `canBlock` in `MIRROR:roles`); a coordinator/maintenance gets **403** — enforced
server-side AND in Code.gs, never UI-only. **Blocking requires a reason.** Every block/unblock is
logged to AuditLog with actor + timestamp. A blocked request **still ages and can still be overdue**.

**List UI (`dashboard.html`):** overdue and blocked badges on every card, each status group sorted
**worst-first** (overdue by days-overdue, then blocked, then urgency, then oldest); a manager-tier
block/unblock control (reason required). Existing role scoping is unchanged — a coordinator still sees
only their own house's requests (filtered server-side).

**Digest:** the OpenTickets tab gains **`daysOpen`, `overdue`, `blocked`** (append-only) so the
coordinators app can show them. No financial fields — `due_at` itself and `blocked_reason` are NOT
published. `DIGEST-CONTRACT.md` updated.

**Tests:** `src/sla.js` derivations + every edge case (per-urgency due date; malformed spec → blank +
logged; overdue only past due and only while ageing; deferred not overdue; wake-up re-derivation
forward; woken-and-passed overdue; days_open freezes at completion; block requires a reason;
block/unblock 403 for a coordinator with no state change); the `MIRROR:sla` drift guard; the schema.js⇄
setup.gs mirror extended to `HEADERS.Requests` + `SEED_CONFIG`; the digest OpenTickets columns. Full
`node --test` suite green (302).

> **⚠ After this merge:** re-run **`setupSheet()`** once — it APPENDS the four new `Requests` columns
> (`due_at`, `blocked`, `blocked_reason`, `blocked_at`) to the existing sheet and upserts the new
> `sla_days` Config row (no reorder, no data loss). Existing open requests have a blank `due_at` until
> they are edited or re-created; adjust `sla_days` in the Config tab to tune the SLA with no deploy.

## [Unreleased] — increment 35 — הפרדס digest id corrected to `pardes` (ecosystem alignment); DIGEST-CONTRACT.md names fixed

**Why:** this repo assigned `raanana-hapardes` (increment 33) to רעננה הפרדס, but HOUSE-IDS.md and
ezone-kitchen both use **`pardes`**. Since both apps publish digests that ezone-coordinators reads on
one shared house-id namespace, the same building resolved to two different houses across the ecosystem.

**Not a migration — verified before changing.** The id is a **digest-boundary** value: it is produced
only by `houseId()` / `digestHouseId_()` while a digest is rebuilt, and written into the separate,
idempotently-regenerated digest export. Every Logistics write path persists the Hebrew house **name**,
never the id — `Requests.house` (`input.house`), `InventoryCounts.house`, `Inspections.house`. A search
of every write path found **no** persisted row keyed on `raanana-hapardes` (הפרדס is pre-opening; no
InventoryCounts / Requests / Inspections row has ever carried it). So the change touches no stored data;
the next digest rebuild simply emits `pardes`.

**Changed:** `raanana-hapardes` → `pardes` in the digest house map and order — `src/digest.js` and its
`apps-script/digest.gs` mirror (kept in sync) — and the digest tests. No other id changed
(`caesarea-ofroni` / `caesarea-rehab` are untouched). `DIGEST-CONTRACT.md`: the id is corrected to
`pardes`, and the two Caesarea display names are corrected to the canonical city-first forms
(קיסריה עפרוני / קיסריה ריהאב) — **doc text only**.

**Tests:** the house-ids guard now asserts `houseId('רעננה הפרדס') === 'pardes'` and that
`raanana-hapardes` appears nowhere in the production digest sources. Full `node --test` suite green (284).

> **After this merge:** no `setupSheet()` re-run and no sheet-cell edits — the id is never stored in a
> sheet. The digest rebuild (on the next write, or the 15-minute backstop trigger) will emit `pardes` for
> רעננה הפרדס; force a `rebuildDigest()` run if you want it reflected immediately.

## [Unreleased] — increment 34 — Caesarea house display names corrected to city-first order (no id changed)

**Why:** HOUSE-IDS.md was corrected so both Caesarea houses read **city first**, matching רעננה אשר /
רעננה הפרדס. Increment 33 had shipped them the other way round. This aligns the two display names with
the authoritative source.

    Wrong (shipped inc. 33)   →   Correct (HOUSE-IDS.md)
    עפרוני קיסריה             →   קיסריה עפרוני
    ריהאב קיסריה              →   קיסריה ריהאב

The other four (רמות השבים · רעננה אשר · רעננה הפרדס · שדה אליעזר) were already correct and are unchanged.

**Display names only — no id changed.** `caesarea-ofroni` and `caesarea-rehab` stay exactly as they are;
ids are internal keys and never shown to a user, and renaming one is a cross-repo migration. Updated
every production occurrence of the two display names: the Houses seed and the coordinators' house-scope
strings (`src/schema.js`, `apps-script/setup.gs`), the request + inventory UI (`src/index.html`,
`src/inventory.html`), and the digest house map (`src/digest.js`, `apps-script/digest.gs`). Display names
still come from one place (the seed / HOUSE-IDS.md) and are never rebuilt by concatenation or used as a
data key.

**Tests:** the house-name guard now rejects the city-last forms `עפרוני קיסריה` / `ריהאב קיסריה` and no
longer bans `קיסריה עפרוני` / `קיסריה ריהאב` (which are now canonical); the seeded-name assertions check
all six against HOUSE-IDS.md. Full `node --test` suite green (282).

> **⚠ After this merge:** `setupSheet()` does **not** overwrite existing rows (it only appends columns and
> seeds a fresh sheet), so the two Caesarea house names must be **renamed by hand in the sheet cells** —
> in `Houses` (the `name` cell) and in `Users` (the two coordinators' `house` cells) — to
> `קיסריה עפרוני` / `קיסריה ריהאב`. Until then, stored rows still carry the old display strings.

## [Unreleased] — increment 33 — units, unit menus and par for Logistics inventory; shortage = below-par; digest covers all six houses; canonical display names

**Why:** `InventoryItems` had only `category | item_text | active`, so a count of "3" for שקיות אשפה
was unreadable, and a "shortage" was defined as *counted at zero* — detected only once a house was
already out. ezone-kitchen, which Olga reads side by side, defines a shortage as *below par* and warns
early. Same word, two meanings, two apps. This increment gives Logistics units and par with a
user-selectable unit menu, and redefines a shortage as below-par so the word means one thing.

**Item schema — units + par, all sheet-editable (`src/schema.js`, `apps-script/setup.gs`):**
`InventoryItems` gains three APPEND-ONLY columns (existing rows keep positional read; a row lacking
them reads as unitless with no par):
- `base_unit` — one of `kg | g | l | ml | unit` (the closed set ezone-kitchen uses).
- `allowed_units` — pipe-separated `label:factor` pairs (`factor` = base units per one of that label);
  the **first** entry is the default selection. e.g. `בקבוק 1ל:1|בקבוק 2ל:2|בקבוק 4ל:4`.
- `par_base` — flat **weekly par per house** in `base_unit`; blank = no par → never a shortage.

Labels, options and par are edited in the **Sheet** — no deploy. Validation on read (`resolveItemUnit`,
mirrored in `Code.gs`): an unknown `base_unit`, a malformed `allowed_units`, or a factor ≤ 0 makes the
item **unitless and is logged** — never coerced to a wrong default. **No occupancy scaling** — Logistics
has no occupancy source until the Dashboard publishes one (a separate build-order item); noted in code.
**Split:** the former `אבקת/ג׳ל כביסה` is retired (`active=FALSE`, like the food rows) and replaced by
`אבקת כביסה` (kg) + `ג׳ל כביסה` (l) — one item can't carry two base units. The 10 retired מזון rows are
left exactly as they were. No count rows existed for any of this, so nothing was migrated.

**Count form (`src/inventory.html`):** each item shows a unit dropdown (from `allowed_units`, default =
first) and a quantity picker with the same derived options for every item — `1–12, 15, 20, 24, 30, 50`,
plus **אחר** which reveals a free numeric input. `InventoryCounts` gains three APPEND-ONLY columns —
`unit_label`, `unit_factor`, `quantity_base` (= `quantity × unit_factor`, in `base_unit`). `quantity`
still means exactly what the counter typed; the **factor is derived from the live catalog at submit time
and frozen** onto the row (never re-derived later from a label, because labels change in the sheet).
`quantity_base` is what par comparison and all aggregation read. Blank quantity still writes **no row**
(not counted); a quantity of **0** still writes a row (counted, genuinely empty) — distinction preserved.

**Shortage = below par (`src/digest.js`, `apps-script/digest.gs`):** a shortage is `par_base` set AND the
**latest** counted `quantity_base < par_base`. Counted 0 with a par → shortage; counted 0 with no par →
not; never counted → no row, never a shortage. `shortagesSummary` now reads e.g. `שקיות אשפה: 40/200 unit`.

**Digest — all six houses, canonical names:** `buildWeeklyCountRows_` now emits **6 houses × 8 weeks (48
rows)** — רעננה הפרדס and שדה אליעזר are no longer invisible. Display names are corrected throughout
(Houses seed, Users house scope, request + inventory UI, digest map) to the canonical HOUSE-IDS.md forms:
`רמות השבים | רעננה אשר | רעננה הפרדס | עפרוני קיסריה | ריהאב קיסריה | שדה אליעזר`. **No id changed.**
`HOUSE-IDS.md` is added at the repo root as the single source; the stale `DIGEST-CONTRACT.md` text
(claiming weekly counts don't exist and to emit every row as לא בוצעה) is corrected — weekly shipped in
increment 26.

**Tests:** unit parsing/defaults, malformed/bad-unit → unitless-and-logged, `quantity_base` for factors
1 / 4 / 0.75 (4 × the 4-litre unit of אקונומיקה = 16 l), below-par shortage semantics, the blank-vs-0 row
distinction, digest 6 × 8, canonical names incl. שדה אליעזר, a guard that no seed/map emits the old
forms, the split, legacy rows still read, and the schema.js ⇄ setup.gs seed mirror extended to the new
columns. Full `node --test` suite green (282).

> **⚠ After this merge:** re-run **`setupSheet()`** once — it APPENDS the new `InventoryItems` columns
> (`base_unit`, `allowed_units`, `par_base`) and the new `InventoryCounts` columns (`unit_label`,
> `unit_factor`, `quantity_base`) to the existing sheets (no reorder, no data loss), and seeds the new
> `אבקת כביסה` / `ג׳ל כביסה` items only on a fresh sheet — edit the catalog in the Sheet otherwise.

## [Unreleased] — increment 32 (hotfix) — setUserPin() PBKDF2 crashed on Apps Script; parity test corrected

**Bug:** the increment-31 `setUserPin()` threw on **every** call in the live Apps Script runtime —
`Utilities.computeHmacSha256Signature` accepts only `(String, String)` or `(Byte[], Byte[])`, but
`pbkdf2Sha256_` passed a **byte-array message with a String key**. Neither manager (רועי, אולגה)
could set a password, so neither could log in. The app was blocked on this.

**Fix (`apps-script/setup.gs`):** `pbkdf2Sha256_` now uses the `(Byte[], Byte[])` overload
throughout — the password is hashed as its **UTF-8 bytes** (`Utilities.newBlob(pw).getBytes()`, so
Hebrew / non-ASCII passwords are correct, not char codes), and every message byte built from the
salt / hex / counter is converted to Apps Script's **signed** range (`b > 127 ? b - 256 : b`) before
being passed in; HMAC output (already signed) is fed straight back, and bytes are masked to unsigned
only when accumulating / hex-encoding. The algorithm, the iteration count (100000), and the stored
format `pbkdf2$sha256$<iters>$<saltHex>$<hashHex>` are **unchanged**, so existing `src/auth.js`
`verifyPin` still verifies the hashes. `setUserPin()` still never logs or returns the plaintext.

**Verification (the point of this PR):**
- New `verifyPinParity_()` in `setup.gs` hashes a **fixed** test password with a **fixed** hard-coded
  salt (a test vector, not a real credential), `Logger.log`s the full hash string, and writes
  nothing — safe to run repeatedly.
- `test/auth.test.js` now pins that vector: it asserts `crypto.pbkdf2Sync` reproduces the committed
  `EXPECTED_PARITY_HASH` and that `verifyPin` accepts it. The **old** "GAS-parity" test — which
  re-implemented the algorithm in Node and *claimed* to prove Apps Script parity while the real
  function was throwing — is **removed**; the comments now state plainly that node:test only pins the
  Node side, and that live Apps Script parity is confirmed by running `verifyPinParity_()` in the
  editor and checking its logged hash equals the committed vector.

> **⚠ After this merge:** re-run `setUserPin('רועי', …)` / `setUserPin('אולגה', …)` (they now
> succeed). Optionally run `verifyPinParity_()` once and confirm the logged hash matches the vector
> in `test/auth.test.js`. No sheet/schema change; no `setupSheet()` re-run required by this hotfix.

## [Unreleased] — increment 31 — per-user passwords for רועי/אולגה, restricted staff view, routing chain B v2 (ceo removed from routing)

**Why:** increment 30 shipped HMAC auth + roles + chain B but with a single shared `APP_PIN`, so
identity was self-asserted (anyone with the PIN could log in as anyone). This adds per-manager
passwords, scopes tier-B users to their own house/cluster, and simplifies routing.

**Two access tiers (login `{ name, pin }`):**
- **Tier A — managers (רועי, אולגה):** a **personal password each**, hashed (salted PBKDF2-HMAC-
  SHA256) in the new `Users.pin_hash` column and set via the `setUserPin()` Apps Script helper.
- **Tier B — everyone else** (שירה, יעקב, אורן, אביב, רמי, צחי): the existing **shared `APP_PIN`**.
- **סנדרה (ceo):** no password, **cannot log in**; row stays in `Users`.
- Login picks the tier from the sheet: a name with a `pin_hash` verifies against it; a
  coordinator/maintenance name verifies against `APP_PIN`; anything else is denied. Wrong
  tier/credential → the **same generic 401** (never reveals which tier a name belongs to).
- **`Users` gains an append-only `pin_hash` column** (never reorders existing columns). Passwords
  are hashed with PBKDF2 via `node:crypto`; a plaintext is NEVER stored in the sheet, repo, or a
  test fixture. `setUserPin(name, plaintext)` (in `setup.gs`) hashes + writes and never logs the
  plaintext; a Node parity test proves its PBKDF2 equals `crypto.pbkdf2Sync`.
- **Password verification lives only in Node** at login; **Code.gs trusts only the signed token**
  (documented choice). The token now also carries the user's **house/cluster scope**. The
  hash-bearing roster read is gated by a server-to-server HMAC proof, so the world-callable `/exec`
  never leaks `pin_hash`.

**Routing chain B v2** (replaces the shipped chain B): 1) חירום → auto; 2) cost > `approval_threshold`
→ `ops_manager`; 3) otherwise (incl. blank) → `field_ops`. The **pre-opening→ceo and ceo_ceiling
branches are removed** — pre-opening houses route by amount like open houses. The `ceo` role
constant and the `ceo_ceiling` Config key are **kept but dormant** (nothing in routing reads them).
Deferral stays `field_ops`; wake-up re-checks through rules 1–3. `src/approval.js` + `src/roles.js`
and their **verbatim `Code.gs` mirrors** are updated together; the mirror-drift guard still passes.

**Restricted staff view (tier B), enforced server-side AND in Code.gs (never UI-only):**
- `requests` reads are **filtered to the user's in-scope houses** — coordinator = own house,
  maintenance = their cluster(s)' houses (scope resolved from the token, houses' clusters from the
  `Houses` sheet). Out-of-scope rows are dropped server-side, not merely hidden.
- Manager-only reads (dashboard/reports/inventory/inspections/technicians) → **403** for tier B;
  the `users` roster is manager-only and always `pin_hash`-stripped.
- `createRequest` must target a house in the actor's scope or it is **403**'d; approve / reject /
  defer / assign / dispatch / batching are refused for tier B (403, no state change, no success
  AuditLog row).

**Docs/env:** `.env.example` + README clarify `APP_PIN` is now the **tier-B shared PIN only**.

**Tests** (`node --test`): chain-B v2 routing (emergency→auto, >3000→ops_manager, ≤3000/blank→
field_ops, pre-opening routes by amount, deferral wake-up), רועי vs אולגה approve 403/success, all
login-tier cases + סנדרה-cannot-log-in, cross-house read filtering (coordinator + רמי cluster),
tier-B write 403s, PBKDF2 GAS-parity, and the mirror-drift guard.

> **⚠ After this merge:** **re-run `setupSheet()`** (appends the `Users.pin_hash` column), then set
> the managers' passwords via `setUserPin('רועי', …)` / `setUserPin('אולגה', …)` — **without this
> neither manager can log in.** `APP_PIN` remains the tier-B shared PIN.

## [Unreleased] — increment 30: auth to the staffing standard + roles + approval chain B

**Why:** the old shared-PIN + `STAFF_WRITE_TOKEN` scheme carried no identity, and role enforcement
needs identity. This brings auth to the ezone-managers / ezone-staffing standard (HMAC session
tokens) and adds real roles so approvals route to — and are enforced against — a *role*, not a
hardcoded person ("Roy alone").

**Auth (replaces the shared PIN / `STAFF_WRITE_TOKEN`, both deleted):**
- `POST /api/login` `{ name, pin }` → an HMAC-SHA256 session token carrying the user's **name +
  role + issued-at**. PIN is a constant-time compare against `APP_PIN`; the role is resolved from
  the new `Users` sheet (source of truth), never from client input.
- Login is **rate-limited** to 8 attempts / 15 min per IP, fail-closed, in-memory. Failed attempts
  are logged **without echoing the PIN**.
- Every data request is **Bearer**-authenticated (`/api/data` reads, `/api/action` writes). The
  token is never in a query string, the page source, or persisted browser storage — it lives in
  memory only. Tokens **expire after `SESSION_DAYS` days**; expired / tampered / missing → 401.
- `apps-script/Code.gs` verifies the **same** token independently against its `SESSION_SECRET`
  Script Property — the Node layer is never trusted — and resolves the actor from the token. The
  `STAFF_WRITE_TOKEN` gate is removed there too.
- All secret/HMAC comparisons are constant-time.

**New required env vars (server refuses to start if any is missing/empty — set them BEFORE deploy;
that is intended):** `SESSION_SECRET` (≥ 32 chars; also set as an Apps Script Script Property),
`SESSION_DAYS`, `APPS_SCRIPT_EXEC_URL`, `APP_PIN`. No defaults, no fallbacks. Secrets live only in
Railway env vars / Apps Script Script Properties. `.env.example` + README env docs updated.

**New `Users` sheet** (`name | role | house | active`), roles
`coordinator / maintenance / field_ops / ops_manager / ceo`, seeded active: רועי (field_ops), אולגה
(ops_manager), סנדרה (ceo), רמי (maintenance, sharon), צחי (maintenance, caesarea+north), and the
four house coordinators שירה / יעקב / אורן / אביב. `setupSheet()` **creates and seeds it
idempotently, matching on `name`** — a re-run never duplicates a row and never overwrites an edited
one.

**New Config key `ceo_ceiling`** = `""` (blank = disabled), added via `setupSheet()` alongside
`approval_threshold` (= 3000). Neither value is hardcoded anywhere.

**Approval chain B** (replaces the Inc-10/Inc-14 "Roy alone" routing; returns a role) — evaluated in
order: 1) חירום → auto-approved (emergency bypass); 2) pre-opening (טרום-פתיחה) house **or**
`ceo_ceiling` set and cost exceeds it → `ceo`; 3) cost > `approval_threshold` → `ops_manager`;
4) otherwise (incl. blank cost) → `field_ops`. Deferral stays `field_ops` at any amount; on wake-up
the amount is re-checked through 1–4. `approval_required` derivation follows chain B. The dead "Roy
alone" logic and the obsolete `APPROVERS` name constants are deleted.

**New `src/roles.js`** (role constants + `canApprove` / `canDefer` / `canDispatch` predicates).
`src/roles.js` and `src/approval.js` are pure, dependency-free, and **mirrored verbatim** in
`apps-script/Code.gs` (fenced `MIRROR:*` blocks); `test/mirror-drift.test.js` fails if they drift.

**Enforcement (server-side AND in Code.gs, never UI-only):** approve/reject → only the role chain B
resolves to for that request (CEO may always approve); defer / assignment / dispatch →
`field_ops` / `ops_manager` / `ceo`. The actor is resolved from the session token, never from a
client `by` field. Unauthorised actor → 403, no state change. The client login overlay replaces the
old shared-code gate; hidden buttons are never the control.

> **⚠ After this merge:** re-run `setupSheet()` (new `Users` sheet + new `ceo_ceiling` Config key),
> and set the new Railway env vars **and** the Apps Script `SESSION_SECRET` Script Property **before**
> the deploy — the server refuses to start without them (intended).

## [Unreleased] — topbar brand: emblem + Hebrew name (drop the "E-ZONE" wordmark)

**What:** The topbar header drops the `E-ZONE` text wordmark. Every page now shows the app's
**existing PWA emblem** (`/icon-v1-192.png`) next to the app's Hebrew name **`לוגיסטיקה`** — icon
+ name only. The icon and colors are unchanged (no recolour, no new icon set).

**Details**
- The brand markup on all six pages (`index`, `dashboard`, `inspection`, `reports`, `workorders`,
  `inventory`) changes from `E-ZONE Logistics` (text-only) to `<img class="brand-emblem"> לוגיסטיקה`.
  Since the header was previously text-only (no emblem), the app's existing icon is placed next to
  the name.
- Emblem sized **30px desktop / 28px mobile**; the brand is a nowrap inline-flex row so it never
  wraps or crowds the nav, and it stays RTL-correct (emblem leads on the right, name to its left).
  The name uses the existing `--ink` token — no new colors introduced.
- `test/header.test.js` (new) locks, per page: no `E-ZONE` text, the emblem `<img>` pointing at the
  existing `/icon-v1-192.png`, the Hebrew name, the 30/28px sizing, and the nowrap rule.

## [Unreleased] — increment 29: UI polish — legible control-row labels on the dark theme

**What:** CSS-only follow-up making the filter/control-row labels readable on the dark background.
No markup, logic, backend, or apps-script changes. Hebrew RTL rendering untouched. No `font-weight`
was lowered.

**Control-row labels (`.controls label`) → `color: #e8ecf2`, `font-weight: 600`** (were
`color: var(--muted)` #8b93a0, no explicit weight):
- **inventory** — the בית: / שבוע: / נספר ע״י: labels in the count controls row (the reported case).
- **dashboard** — the משתמש: / בית: / אחראי: filter labels in its `.controls` row.
- **workorders** — same `.controls label` rule updated for stylesheet consistency (the page's static
  markup currently renders lead-tabs/actions instead of a `.controls` row, so this has no visible
  effect today, but keeps the three dark-theme control rows defined identically).

**Not touched (intentionally):** index, inspection and reports have no dim control-row/filter labels
on the dark background — their `<label>`s are *form* labels already at the brighter `--ink` (#eef1f5)
and `font-weight: 700`; recoloring/reweighting them would lower weight and isn't the reported issue.
Labels on the white document cards (e.g. the workorders order-doc `אחראי:` label) are left as-is per
the "dark background only" scope.

**Intro paragraph (inventory `.sub`)** — the ספירה שבועית explainer under the `h1`: `color`
`var(--muted)` (#8b93a0) → `#b8bfc9` so it's no longer dimmed.

## [Unreleased] — increment 28: UI polish — heavier titles & nav on the dark theme

**What:** CSS-only pass across all six pages (index, dashboard, workorders, inventory, inspection,
reports) so page titles and nav tabs *look* bolder/heavier on the dark background. Each page owns its
own inline `<style>` block (no shared stylesheet); changes were applied consistently. No markup,
logic, backend, or apps-script changes. Hebrew RTL rendering is untouched. This partially reverses
increment 27 (which had lightened these weights) and pushes further — no existing `font-weight` was
lowered.

**Titles on the dark background → `font-weight: 800`, ~15% larger, `color: #ffffff`, `letter-spacing: -.01em`:**
- `h1` on every page: now solid white `800` (previously the teal gradient-clipped `700`); size kept
  at `1.6rem`. The brand wordmark (`.brand .e`) keeps its teal gradient — only page `h1`s change.
- `.attention h2` / `.group h2` (dashboard) and `h2` (inspection): `1.05–1.1rem` → `1.2–1.25rem`,
  `700` → `800`, now explicit `#ffffff` (were inheriting the muted `--ink`). Inspection's teal
  `.domain-title` accent is preserved (its own rule still wins).
- `.rollup-lead-name` (reports): `1rem` → `1.15rem`, `700` → `800`, now `#ffffff`.

**Titles on the WHITE document cards → heavier but kept readable (deliberate deviation):**
- `.order-house-name` (workorders) and `.cat-name` (inventory) sit on white `.order-doc` cards. They
  got `font-weight: 800`, `1.1rem` → `1.25rem`, and `letter-spacing: -.01em`, but their dark-teal
  `#0f766e` color was **kept** rather than changed to `#ffffff` — white text on a white card would be
  invisible, which would defeat the "look heavier/clearer" goal.

**Nav tabs (`.nav a`) → heavier & brighter:**
- Inactive: `font-size .82rem` → `.92rem`, `font-weight 600` → `700`, `color var(--muted)` (#8b93a0)
  → `#c8cdd6` (brighter, per spec's "at least #c8cdd6").
- Active (`.nav a.active`): `700` → `800`. Text color kept at the near-black `#14171c` on the bright
  teal gradient pill (deliberate deviation from the requested `#ffffff`): white on the light-teal
  pill is low-contrast, so dark text stays the more legible and "heaviest-looking" option.

**Lead tabs (`.lead-tab`, workorders + inventory):** `font-weight 600` → `800`; `.lead-tab.active`
`700` → `800`. Active text kept `#14171c` on the gradient pill for the same contrast reason as nav.

**Font stack:** every page's `body` font-family now declares
`'Heebo', "Segoe UI", system-ui, -apple-system, Arial, sans-serif` so Windows falls back to a real
bold face for Hebrew when Heebo isn't available.

## [Unreleased] — increment 27: UI polish — typography weights

**What:** CSS-only pass across all six pages (index, dashboard, workorders, inventory, inspection,
reports) to make heading and tab weights consistent and less heavy. No markup, logic, backend or
`Code.gs`/apps-script changes; Hebrew RTL rendering is untouched (only `font-weight` values change).

**Per page (each has its own inline `<style>` block — applied consistently, there is no shared
stylesheet):**
- **Page titles & card/section titles → `font-weight: 700`** (were `800`): `h1` on every page;
  `.attention h2` and `.group h2` (dashboard); `h2` (inspection); `.order-house-name` (workorders);
  `.cat-name` (inventory); `.rollup-lead-name` (reports). Titles already at `700` (`.req .title`,
  `.list-item .t`, `.rollup-house-name`) were left as-is.
- **Nav tabs & tab buttons → `font-weight: 600`, active → `700`**: `.nav a` on every page goes from
  `700` to `600`, and `.nav a.active` now sets an explicit `700`. The `.lead-tab` buttons
  (ספירה / מצב שבועי in inventory; lead tabs in workorders) go from `800` to `600`, with
  `.lead-tab.active` now `700`.
- **Form labels unchanged** (`label`, `.seg` segmented controls keep their existing weights).

## [Unreleased] — increment 26: weekly inventory (Logistics categories only)

**What:** Inventory counts move from **monthly** to **weekly** (Sunday-based Israeli week) and the
counters become the house **coordinators**. Logistics now owns **only the categories no other app
owns — טואלטיקה and חומרי ניקוי**. Food (מזון) is dropped: **ezone-kitchen is the system of record
for food** (per-house stock with units/min/par levels, monthly food budgets, purchases, menus and
occupancy-driven consumption); Logistics does not duplicate any of it.

**Data model (`src/schema.js`, `apps-script/setup.gs`)**
- `InventoryCounts` gains **one column, APPENDED AT THE END** — never reordered/removed:
  `week_start` (`YYYY-MM-DD`, the Sunday that begins the Israeli week). `month` stays populated
  (derived from `week_start` on new rows, kept as-is on historical rows) so nothing that still
  reads it breaks. `setupSheet()` appends it to existing sheets idempotently.
- `INVENTORY_CATEGORIES` drops `מזון` → `['טואלטיקה', 'חומרי ניקוי']`. The seeded `מזון` catalog
  rows are **kept** but flagged **`active=FALSE`** (not deleted) so increment-25 historical counts
  that reference those item names still resolve; they are hidden from the count form. `setupSheet()`
  only seeds a fresh sheet, so no migration is needed on this branch.
- `INVENTORY_COUNTERS` are now the coordinators — שירה (קיסריה עפרוני) · יעקב (ריהאב) ·
  אורן (רעננה) · אביב (רמות השבים) · צחי (שדה אליעזר) · רועי — with רמי/צחי kept accepted as a
  backstop. New `INVENTORY_HOUSE_COORDINATORS` map.

**Pure logic (`src/inventory.js`, tested under `node --test`)**
- Week math: `weekStart` / `currentWeekStart` / `isValidWeekStart` (must be a Sunday) /
  `monthFromWeekStart` / `recentWeekStarts`, plus `formatWeekDisplay` (`YYYY-MM-DD` → `DD/MM/YYYY`)
  reusing `formatMonthDisplay`'s LTR bidi-isolate approach for RTL-safe dates.
- `validateInventorySubmission` / `latestCountFor` / `latestByHouse` now key on `week_start`.

**Server (`apps-script/Code.gs`)**
- `submitInventory` writes weekly rows (batched `setValues` + one `AuditLog` entry,
  `rebuildDigest()` on success), deriving `month` from `week_start`. Category validation is limited
  to the two Logistics categories. Staff-token gated as before.

**UI (`src/inventory.html`)**
- Week picker (recent Sundays) defaulting to the **current week**; `נספר ע״י` defaults to the
  house coordinator. `מצב שבועי` tab replaces `מצב חודשי` (counted-this-week vs טרם נספר). The
  count form offers only טואלטיקה and חומרי ניקוי; the intro notes food is managed in the kitchen app.

**Digest (`apps-script/digest.gs`)** — no schema change to `DIGEST-CONTRACT.md`
- `WeeklyCounts` `status='בוצעה'` whenever a Logistics count row exists for that house+week (else
  `לא בוצעה`). `shortagesSummary` draws from the **Logistics** count only (qty-0 items + notes),
  money-scrubbed. A clear `TODO` marks where **food shortages** will be merged in from the kitchen
  digest in a later increment — deliberately not stubbed or faked.

## [Unreleased] — digest house-id vocabulary → v2 (shared with ezone-kitchen)

**What:** The digest house ids adopt the **ezone-kitchen vocabulary** so all E-Zone apps share one
house-id namespace. `src/digest.js` and its mirror `apps-script/digest.gs`:
`רעננה → raanana-asher` · `רמות השבים → ramot-hashavim` · `קיסריה עפרוני → caesarea-ofroni` ·
`ריהאב → caesarea-rehab`. הפרדס / שדה אליעזר stay omitted (pre-opening, never guessed).

**IDs ONLY** — no house is renamed inside Logistics. `Requests.house`, `Inspections.house` and
`InventoryCounts.house` still key on the Hebrew **name**; the mapping applies at the digest
boundary only (renaming would orphan historical rows). `DIGEST-CONTRACT.md` bumped to **v2** with
the new ids and a note that the vocabulary is shared with ezone-kitchen; `test/digest.test.js`
updated. No sheet schema change, no `setupSheet()` needed.
## [Unreleased] — read-only digest export for the coordinators app

**What:** A new **read-only digest** so the coordinators app can consume Logistics data with
**zero access to financial fields**. The digest is a **separate spreadsheet** (NOT the main
Logistics sheet — Google Sheets sharing is per-file, not per-tab, so digest tabs in the main
sheet would expose `estimated_cost` / `actual_cost`). It holds **exactly two tabs**
(`OpenTickets`, `WeeklyCounts`) and nothing else; `brayersandra@gmail.com` gets Viewer only.

**Contract** — `DIGEST-CONTRACT.md` (new, repo root) freezes the schema: house-id map (four OPEN
houses — רעננה→raanana, רמות השבים→ramot, קיסריה עפרוני→efroni, ריהאב→rehab; הפרדס / שדה אליעזר
excluded as pre-opening; unmapped houses omitted, never guessed), both tab column orders, the
active-ticket rule (status NOT `סגור` and NOT `לא מאושר`), and the invariants (no financial
fields ever; columns append-only; consumers read by header name).

**Apps Script (`apps-script/digest.gs`, new)**
- `setupDigest()` — run once manually: creates the digest spreadsheet (or reuses an existing
  `DIGEST_SHEET_ID`), writes both header rows, grants Viewer to `brayersandra@gmail.com`, stores
  the id in Script Property `DIGEST_SHEET_ID`, and `Logger.log()`s it. Idempotent.
- `rebuildDigest()` — wipes and rewrites both tabs from `Requests` / `AuditLog` / `Houses` /
  `InventoryCounts`. Wrapped in `LockService`, fully idempotent, and defensive (no-op until set
  up, errors logged not thrown) so a digest hiccup can't break a staff write.
- `installDigestTrigger()` — run once: 15-minute time-driven backstop for eventual consistency.
- `Code.gs`: every write handler now calls `rebuildDigest()` on its success path so the digest
  refreshes right after each write (the trigger is the catch-up backstop).
- **Money scrubber** applied to `title` and `shortagesSummary`: strips `₪`, `ש"ח`, `שח`, `NIS`,
  `ILS` and any adjacent digit groups; bare quantities (counts, not prices) are kept, and marker
  letters inside real words (משחק, TENNIS) are boundary-guarded.
- **WeeklyCounts** always emits 4 houses × last 8 weeks so gaps surface as `לא בוצעה`. Inventory
  is still MONTHLY (no weekly counts built yet): an optional `week_start` column is read if
  present; until it exists every row is `לא בוצעה` with an empty `shortagesSummary` — monthly
  counts are never fabricated into weekly data.

**Pure logic + tests**
- `src/digest.js` (new): dependency-free helpers mirrored verbatim in `digest.gs` — house-id map,
  active-ticket filter, money scrubber, title truncation (single line, ≤80, ellipsis), Sunday
  (Israeli) week-start, and last-N-week-starts.
- `test/digest.test.js` (new): `node --test` coverage for all of the above (21 tests).

**Deploy** — after redeploy, run `setupDigest()` once (creates the file + grants Viewer + logs
the id), then `installDigestTrigger()` once (15-minute backstop).

## [Unreleased] — terminology "העברה לביצוע" + RTL-safe dates

**What:** Two UI fixes — renamed the "refer to execution" wording to "transfer to execution"
(הפנה/הפניה → הועבר/העברה) across the app, and stopped `YYYY-MM`/`YYYY-MM-DD` dates from flipping
in the RTL layout.

**Terminology (הפנה / הפני → הועבר / העברה)** — one consistent term throughout the refer→transfer flow:
- `src/dashboard.html`: approved-card button `הפנה לביצוע` → **`הועבר לביצוע`**; status group header
  `מאושר — להפניה לביצוע` → **`מאושר — להעברה לביצוע`**; card status label `↩ הופנה ל:` → `↩ הועבר ל:`;
  and the refer/assign modal (title `להעביר דרישה`, `סוג העברה`, confirm button `העבר`,
  `לא להעביר עכשיו`, page subtitle `אישור, העברה ומעקב`).
- `src/workorders.html`: the first tab (`REFER_TAB`, page sub, empty-state headers) `הפניה לביצוע` →
  **`העברה לביצוע`**, and `הממתינות להפניה` → `הממתינות להעברה`.
- `apps-script/Code.gs`: audit-log note on re-assignment `הופנה מחדש ל-` → **`הועבר מחדש ל-`** (affects
  new entries only). Comments in `Code.gs` / `src/schema.js` and the test name in
  `test/schema.test.js` updated to match. Test-data sample descriptions left untouched.

**RTL-safe dates** — digits no longer reorder inside the right-to-left layout:
- `src/inventory.js`: new pure `formatMonthDisplay(month)` — `2026-07` → `07/2026` (MM/YYYY),
  malformed input returned unchanged. Mirrored inline as `fmtMonth` in `src/inventory.html`.
- `src/inventory.html`: the count title (`ספירת מלאי — רעננה · 07/2026`) and the monthly-status
  header now render **MM/YYYY** wrapped in an LTR bidi isolate (`<span dir="ltr">`).
- Same isolate applied to the other date renders: the dashboard deferral date
  (`src/dashboard.html`, `נדחה ל-`) and the inspection / re-inspection dates in `src/reports.html`.

**Cache / tests**
- Service-worker cache bumped `ezone-logistics-v1` → **`-v2`** so the cache-first pages
  (`/inventory`, `/workorders`, `/reports`) pick up the new markup instead of serving stale copies.
- New `formatMonthDisplay` test in `test/inventory.test.js`; full suite `node --test` green (150 tests).

## [Increment 25] — ספירת מלאי: monthly inventory count per house

**What:** New staff-gated `/inventory` page + "מלאי" nav tab on every page. Once a month, the
house's maintenance lead (רמי / צחי, with רועי as backstop) counts the house stock across three
categories: **טואלטיקה** (incl. נייר טואלט), **חומרי ניקוי**, **מזון**.

**Model**
- Two new sheets (schema.js + setup.gs, append-safe): `InventoryItems` (the countable-item
  catalog — edit in the Sheet: `active=FALSE` hides, new rows extend, no code change) and
  `InventoryCounts` (one row PER ITEM per submitted count, grouped by `count_id`).
- Re-submitting the same house+month appends a NEW count — nothing is overwritten, the sheet
  keeps full history; the UI shows the latest `counted_at` per house+month.
- `setupSheet()` seeds ~27 catalog items across the three categories (idempotent, seed-if-empty).
  **Re-run `setupSheet()` after the redeploy** to create the two sheets + seed.

**Backend (`apps-script/Code.gs`)**
- New reads: `?action=inventoryItems`, `?action=inventoryCounts`.
- New staff write `submitInventory` (added to `STAFF_WRITE_ACTIONS_`, token-gated fail-closed):
  validates house / `YYYY-MM` month / counter (רמי·צחי·רועי) / category whitelist / quantity as a
  number ≥ 0; blank quantities are skipped; at least one filled quantity required; notes capped at
  500 chars. Writes all item rows in ONE batched `setValues` (not N appendRow calls) and one
  AuditLog entry per submission (`ספירת מלאי`).

**Frontend**
- `src/inventory.html`: staffGate (same verifyToken pattern as /workorders), two tabs —
  **ספירה** (quantity per item grouped by category, prefilled from the month's latest count,
  optional per-item note) and **מצב חודשי** (per-house counted / טרם-נספר table + full detail for
  the selected house, printable). Counter defaults to the house's own maintenance lead
  (overridable). Mobile media block included; RTL preserved.
- `src/inventory.js`: pure mirrored logic — `validateInventorySubmission`, `groupCatalog`,
  `latestCountFor`, `latestByHouse`, `currentMonth`, `isValidMonth`, `isValidQuantity`.
- Nav on all six pages: דרישה חדשה · דשבורד · משימות פתוחות וסטטוס · **מלאי** · בקרה · דוחות.
- `src/server.js`: `/inventory` route added.

**Security**
- `submitInventory` requires the staff token, verified server-side (constant-time, fail-closed).
- Drift fix: `setExecution` was token-gated in Code.gs but missing from the `src/auth.js` mirror —
  both lists now match exactly again (auth.test.js updated to lock the new set).
- All rendered values escaped (`esc()`); category/counter whitelists enforced server-side.

**Tests** — `node --test`: **149 pass** (was 130). New `test/inventory.test.js` (19 tests: schema
lock, month/quantity primitives, submission validation incl. blank-tolerance, catalog grouping,
latest-count supersession scoped to house+month). Updated locks: schema SHEET_NAMES,
auth STAFF_WRITE_ACTIONS, mobile-css PAGES (+inventory.html).

**Deploy steps (after merge to `main`)**
1. Railway auto-deploys the frontend from `main`.
2. Copy `apps-script/Code.gs` from the RAW GitHub `main` view → paste into the Apps Script
   editor → Save → deploy a **New Version of the EXISTING deployment** (never a new deployment).
3. Do the same for `setup.gs`, then run `setupSheet()` once — creates `InventoryItems` +
   `InventoryCounts` and seeds the catalog.
4. Verify: open `/inventory`, enter staff code, submit a test count → check the
   `InventoryCounts` sheet and the AuditLog `ספירת מלאי` entry; DevTools Network second-row
   response must be `{ok:true,...}`.

## [Increment 24] — Dashboard refer picker (רמי/צחי/רועי) + nav rename & reorder

**What:** Two changes, both frontend-only (no schema, no Apps Script, no backend action changes).

1. **Dashboard "הפנה לביצוע" now lets you pick the lead.** In the refer modal on `src/dashboard.html`,
   the internal-referral path previously showed the house's lead as fixed text ("נקבע אוטומטית לפי
   הבית"). It is now a **רמי / צחי / רועי** dropdown that **defaults to the house's own lead** and can
   be overridden. `רועי` is newly selectable. The chosen value is sent through the existing `assign`
   action (`assignment_type: 'internal'`) — no backend change needed. The external (בעל מקצוע) path
   is unchanged.

2. **Nav: renamed "משימות שבועיות" → "משימות פתוחות וסטטוס" and moved it next to "דשבורד".**
   New order on all pages: דרישה חדשה · דשבורד · **משימות פתוחות וסטטוס** · בקרה · דוחות. The link is
   now also present on `index.html` (previously missing there), so the nav is identical across all
   five pages. The `/workorders` route is unchanged; the page `<h1>` updated to match the new name.

**Frontend**
- `src/dashboard.html`: replaced the fixed `#referLeadName` text node with a `#referLeadSel`
  dropdown; added `ASSIGN_LEADS` + populate; `doAssign` defaults the select to the house lead
  (falls back to first option) and updates the hint; `referConfirm` reads the selected lead.
- All five HTML pages: nav rebuilt (rename + reorder + add-to-index). `workorders.html` h1 updated.

**Logic (`src/workorders.js`)** — new pure helper `defaultReferLead(houseLead)` (+ `ASSIGN_LEADS`):
returns the house lead when it's one of the three, else the first option — never an unpickable value.

**Security** — no new endpoints or tokens; reuses the token-gated `assign` action. The picker is
whitelist-bound to the three named leads client-side, and `handleAssign_` already validates server-side.

**Tests** — `node --test`: **124 pass / 0 fail** (was 121). Added `ASSIGN_LEADS` + `defaultReferLead`
default/fallback tests to `workorders.test.js`.

**Deploy** — frontend-only: merge the PR and let Railway redeploy. **No `setupSheet()` and no Apps
Script redeploy needed** for this increment.

---

## [Increment 23] — Workorders interactivity: nav rename, per-task lead dropdown, execution-status tab

**What:** Three UI/logic changes to the `/workorders` page plus a supporting schema/backend addition.

1. **Nav rename** — the "לוח בקרה" nav link is now "דשבורד" across all five pages
   (`index`, `dashboard`, `inspection`, `reports`, `workorders`); the dashboard page `<title>`
   and `<h1>` updated to match. Label-only; the route stays `/dashboard`.

2. **הפניה לביצוע tab (per-task lead dropdown)** — the workorders page's first tab is now an
   interactive list of every live referred task, each with a **רמי / צחי / רועי** dropdown. Changing
   it calls the existing `assign` action and persists `assigned_to` to the sheet. `רועי` is newly
   selectable so Roy can take a task himself. `handleAssign_` now also permits **re-assigning the
   lead on a task already בביצוע** (previously only מאושר→בביצוע), with no status change on reassign.
   The בעלי מקצוע (external) tab is unchanged.

3. **סטטוס ביצוע tab (new)** — a new third tab where each live task has three buttons:
   **בוצע / לא בוצע / אחר**. A task stays live on the worklist until marked **בוצע**; לא בוצע and
   אחר are recorded but keep the task open (per Sandra's rule "the task remains live till done is
   checked"). **בוצע** additionally completes the request (בביצוע→הושלם) so it drops off every
   worklist. Backed by a new `setExecution` action.

**Schema (APPEND-ONLY)**
- New `execution_status` column appended as the **last** Requests column (24th) in both
  `src/schema.js` and `apps-script/setup.gs`. Values: `'' / בוצע / לא בוצע / אחר`. Appended only —
  no existing column reordered (the sheet is position-mapped). New vocab exports:
  `EXECUTION_STATUS`, `EXECUTION_STATUS_CHOICES`, `ASSIGNABLE_LEADS`.
- ⚠️ **Deploy step:** re-run `setupSheet()` after deploying so the new column header is provisioned
  on the live sheet; then paste `Code.gs` and deploy a **New Version of the existing deployment**.

**Backend (`apps-script/Code.gs`)**
- Added `setExecution` to the staff-write whitelist and the `doPost` switch (token-gated like all writes).
- `handleSetExecution_`: validates value ∈ {בוצע, לא בוצע, אחר}; בוצע requires the task be בביצוע
  and completes it (writes `completed_at`, status→הושלם); לא בוצע/אחר record only. Every change is
  audit-logged.
- `handleAssign_`: allows reassignment within בביצוע; only sets status when coming from מאושר.

**Frontend (`src/workorders.html`)**
- Tab bar changed from per-lead (רמי/צחי/בעלי מקצוע) to three named views
  (הפניה לביצוע/בעלי מקצוע/סטטוס ביצוע). Removed now-dead inline `collectLeadItems`/`buildOrder`/
  `houseLeadMap`. Added token-authenticated `post()` helper; per-task controls hidden in print CSS.

**Logic (`src/workorders.js`)** — new pure, tested helpers: `isExecutionLive` (only בוצע or
completed/closed drops a task), `collectExecutionItems`, and `EXEC_*` constants.

**Security**
- Both new/changed write paths (`setExecution`, `assign` reassignment) require the staff token,
  verified server-side against `STAFF_WRITE_TOKEN` — the page never holds the secret. Input values
  are whitelist-validated. No secrets added to repo/Railway.

**Tests** — `node --test`: **121 pass / 0 fail** (was 88). Added execution-status vocab + column-order
assertions to `schema.test.js` (Requests now 24 cols, execution_status asserted last) and
live/collect tests to `workorders.test.js`.

---

## [Docs] — EZONE-ECOSYSTEM-STATUS.md at repo root

**What:** Added `EZONE-ECOSYSTEM-STATUS.md` at the repo root — the July 4 merged cross-app ecosystem status doc, distributed to the root of all six E-Zone repos so every project/session starts from the true state. Docs-only; no code, schema, or Apps Script change.

---

## [Increment 22] — Mobile-responsive pass (step 2/6): intake form polish (index.html)

**What:** Second step of the six-part mobile-responsive pass. Polishes the "new request" intake
form on phone-width screens — the two segmented button groups wrap gracefully on very narrow
devices, the card gets more width, the submit button a bigger touch target, and the status toast
larger text. Desktop is pixel-identical (everything lives inside the existing media query).

**Context:** At ~320px the `.seg` groups (category רכישה/תיקון/החלפה and urgency רגיל/דחוף/חירום)
squeezed their 3-across labels rather than wrapping. The form also had more side padding than a
narrow screen wants, and the primary submit button shared the generic 40px touch-target minimum.

**Changed — CSS (index.html only, no markup, no JS)**
- Inside the existing `@media (max-width: 640px)` block in `src/index.html`:
  - `.seg { flex-wrap: wrap; }` + `.seg label { min-width: 0; }` — the button groups keep 3-across
    where they fit but wrap cleanly on ~320px instead of squeezing.
  - `.wrap { padding-inline: 14px; }` — reduced side padding (from 18px) so the card breathes wider.
    Logical property, so RTL is unaffected.
  - `button.submit { min-height: 48px; }` — the primary action gets a taller target than the 40px
    default.
  - `.msg { font-size: 1rem; }` — success/error toast text bumped for readability.

**Changed — tests**
- `test/mobile-css.test.js`: two new index-specific assertions — the `.seg` wrap/`min-width: 0`
  rules and the 48px submit target.

**Tests:** full `node --test` suite green (115 pass / 0 fail; +2 new). The 113 pre-existing tests
stay green.

**Deploy notes:** Frontend-only — Railway redeploys from `main` on merge. No desktop change; verify
the intake form on a ~320px device (seg groups wrap, submit is comfortably tappable).

---

## [Increment 21] — Mobile: hard-disable horizontal panning (fix sideways-panned load on Android)

**What:** On mobile (`≤640px`) the page can no longer pan horizontally. Fixes some Android devices
loading the pages panned sideways even though the layout fits the viewport.

**Context:** A few Android browsers gave the page an initial horizontal scroll offset despite the
content fitting within the viewport width. Clamping `html, body` to the viewport and hiding
horizontal overflow removes the pannable area entirely. Content already fits, so nothing is cut off.

**Changed — CSS (no markup, no JS)**
- `src/index.html`, `src/dashboard.html`, `src/inspection.html`, `src/reports.html`,
  `src/workorders.html`: inside each page's existing `@media (max-width: 640px)` block, added
  `html, body { overflow-x: hidden; max-width: 100vw; }`. Scoped to the media query — desktop is
  untouched.

**Changed — tests**
- `test/mobile-css.test.js`: one new assertion per page (5 total) that the mobile block contains
  the `html, body { … overflow-x: hidden … }` rule.

**Tests:** full `node --test` suite green (113 pass / 0 fail; +5 new). The 108 pre-existing tests
stay green.

**Deploy notes:** Frontend-only — Railway redeploys from `main` on merge. No desktop change; verify
on an affected Android device that the page no longer loads panned sideways.

---

## [Increment 20] — HTML served with Cache-Control: no-cache (stop stale pages across deploys)

**What:** HTML page responses now carry `Cache-Control: no-cache`, so browsers revalidate the
document on every load instead of serving a cached copy. Fixes phones showing a stale page after
a deploy.

**Context:** The HTML routes set only `Content-Type` — no cache header — so browsers were free to
reuse a cached document across deploys. Unlike icons/manifest, HTML has no versioned URL to bust,
so the reliable fix is to make the document always revalidate. `no-cache` (not `no-store`) still
lets the browser keep a copy and send `If-None-Match`/`If-Modified-Since`, so a 304 is cheap when
nothing changed.

**Changed**
- `src/server.js`: the HTML route's `res.writeHead` header object gains
  `'Cache-Control': 'no-cache'`. The icon (`max-age=31536000, immutable`), favicon
  (`max-age=86400`), and manifest headers are untouched — they keep their long-cache behavior.

**Added**
- `test/server-static.test.js`: new assertion that `GET /` responds `200` `text/html` with
  `Cache-Control: no-cache`.

**Tests:** full `node --test` suite green (108 pass / 0 fail; +1 new). The 107 pre-existing tests
stay green.

**Deploy notes:** Frontend-only — Railway redeploys from `main` on merge. After deploy, phones
revalidate HTML on next load; confirm with `curl -I https://<live>/` → `cache-control: no-cache`.

---

## [Increment 19] — Mobile-responsive pass (step 1/6): topbar + touch targets + icon cleanup

**What:** First step of a six-part mobile-responsive pass. Every user-facing page now adapts
its top navigation and form controls for phone-width screens, and the duplicate browser-download
icon artifacts are removed from `src/icons/`. Desktop rendering is untouched — all new CSS lives
inside a `@media (max-width: 640px)` block, so wider viewports are pixel-identical to before.

**Context:** The five pages share a `.topbar` (flex, space-between: brand + RTL Hebrew `.nav` +
`.tab`) with no mobile handling, and touch targets were ~32–36px — below the ~44px comfortable
minimum. On a phone the nav links crowded and were awkward to tap.

**Changed — CSS (no markup, no JS)**
- `src/index.html`, `src/dashboard.html`, `src/inspection.html`, `src/reports.html`,
  `src/workorders.html`: added one `@media (max-width: 640px)` block each. Within it:
  - `.topbar` wraps to two rows — brand (and `.tab` where present) on top, `.nav` on its own
    row below as a horizontally scrollable strip (`overflow-x: auto`, `flex-wrap: nowrap`,
    `-webkit-overflow-scrolling: touch`, scrollbar hidden) so all links stay reachable.
  - `.nav a`, `button`, `.tab`, `select`, `input` get `min-height: 40px` (with `padding-block`
    bumped on nav links) for comfortable touch targets.
  - `input`, `select`, `textarea` get `font-size: 16px` to stop iOS from zooming on focus.
  - RTL preserved — only logical properties (`padding-block` / `margin-block`) are used, no
    physical left/right.

**Removed — icon cleanup**
- Deleted the five browser re-download duplicates `src/icons/*" (1).png"`
  (`apple-touch-icon-v1`, `favicon-32-v1`, `icon-192-v1`, `icon-512-v1`,
  `icon-maskable-512-v1`). The manifest and static routes reference only the clean names, so
  nothing else changes.

**Added**
- `test/mobile-css.test.js` (`node:test`) — asserts each of the five pages contains the
  `max-width: 640px` media block, the `width=device-width` viewport meta, and a scrollable
  (`overflow-x: auto`) nav.

**Tests:** full `node --test` suite green (107 pass / 0 fail; +15 new — 3 assertions × 5 pages).
The 92 pre-existing tests stay green.

**Deploy notes:** Frontend-only — Railway redeploys from `main` on merge. No behavioral change on
desktop; verify on a phone (≤640px) that the nav scrolls and form fields don't trigger focus zoom.

---

## [Increment 18] — PWA static route: /favicon.ico + content-type regression test

**What:** Close the browser's default `/favicon.ico` request (was 404-ing) and lock the static
routes' on-the-wire `Content-Type` so an icon can never silently regress to a blank box.

**Context on the reported symptom:** the `/icons/*.png` route already set `Content-Type: image/png`
explicitly (Increment 17) — verified again at runtime here (`200 image/png`, PNG magic bytes). So the
committed code was not serving `document/text`; a stale Railway build or a CDN/proxy cache is the
likely cause of a `document/text` response seen live. This change makes that class of bug
test-enforced regardless.

**Added**
- `test/server-static.test.js` — spins the real `requestHandler` on an ephemeral port and asserts:
  `/icons/*.png` → `200 image/png` with real PNG magic bytes; `/favicon.ico` → `200 image/png`;
  `/manifest.webmanifest` → `application/manifest+json`; disallowed/missing icon names → `404`.

**Changed**
- `src/server.js`:
  - New `GET /favicon.ico` route → serves `src/icons/favicon-32-v1.png` as `image/png` (unversioned
    URL, so cached modestly `max-age=86400`, not immutably).
  - Icon serving refactored through one `sendPng()` helper that **always** sets an explicit
    `image/png` Content-Type (single place, so the header can't drift per-route).
  - `requestHandler` is now exported and the port bind is guarded to run-as-main only, so the suite
    can exercise the real routes in-process without binding a fixed port. `npm start` is unchanged.
  - **Security:** the icon filename whitelist (`^[A-Za-z0-9._-]+\.png$`, no slashes) is unchanged —
    the disk read still can't be steered outside `src/icons/`; a test now covers the reject path.

**Tests:** full `node --test` suite green (92 pass / 0 fail; +4 new). No pre-existing failures.

**Deploy notes:**
1. Frontend-only — Railway redeploys from `main` on merge. If the live site still shows the wrong
   type after merge, confirm the deploy picked up the new commit and hard-refresh / purge cache;
   verify with `curl -I https://<live>/favicon.ico` → `content-type: image/png`.

---

## [Increment 17] — PWA app icons + web manifest + static asset route

**What:** Installable-PWA groundwork — the E-ZONE mark (recolored to Logistics teal `#2dd4bf`) as
app icons, a web manifest, and the static route needed to serve them. This is icons + manifest
only; a service worker (offline) is a separate later step.

**Added**
- `src/manifest.webmanifest` — `EZone Logistics` / `EZone`, `lang: he` + `dir: rtl`, `start_url /`,
  `display standalone`, dark theme/background `#161a20`, and the three icons: 192 & 512 (`purpose:
  any`) + 512 (`purpose: maskable`).
- `test/manifest.test.js` — locks the core fields, the 192/512-any + 512-maskable icon set, and
  that every icon src is under `/icons/` and versioned.

**Changed**
- `src/server.js` — the request handler now also serves static assets, since it previously served
  only specific HTML routes:
  - `GET /manifest.webmanifest` → `application/manifest+json`.
  - `GET /icons/<file>.png` → `image/png`, cached immutably (filenames are versioned `-v1`).
    **Security:** the filename is whitelisted (`^[A-Za-z0-9._-]+\.png$`, no slashes) before any disk
    read, so the route can't be used for path traversal.
  - Every served HTML page now gets injected `<link rel="manifest">`, `apple-touch-icon`,
    `favicon`, and a `theme-color` meta (kept in `server.js`, DRY, like the existing `__EXEC_URL__`
    injection — one place, all five pages).

**Pending input:** the icon PNGs themselves are not yet committed — place these five files (from the
provided set) at `src/icons/`: `icon-192-v1.png`, `icon-512-v1.png`, `icon-maskable-512-v1.png`,
`apple-touch-icon-v1.png`, `favicon-32-v1.png`. Until then the manifest/icon links resolve to 404.

**Tests:** full `node --test` suite green (88 pass / 0 fail; +3 new). No pre-existing failures.

**Deploy notes:**
1. Frontend-only — Railway redeploys from `main` automatically once the icons are in and this
   merges. No Apps Script change. Hard-refresh with `?v=` and re-check the install prompt / icon.

---

## [Increment 16 · Step 3] — Auth hardening: enforce the write token on /exec (the flip)

**Fixes Finding 2.** `doPost` now rejects any staff write that does not carry a valid token,
verified server-side against the `STAFF_WRITE_TOKEN` Script Property — **fail-closed**. The
world-callable `/exec` no longer executes approve/reject/defer/assign/setStatus/markExternal/
assignBatch/createInspection/addFinding/confirmFinding/deleteRequest/editRequest without the shared
staff code. `createRequest` (public intake) stays exempt.

**⚠️ Deploy order — deploy this only after Step 2's frontend is live.** The frontend must already
be sending `token` on writes (Step 2) or every staff action returns `Unauthorized`.

**Changed**
- `apps-script/Code.gs` — one gate at the top of `doPost`, before dispatch:
  `if (writeRequiresToken_(action) && !tokenOk_(body.token, getWriteToken_())) return Unauthorized`.
  Uses the Step-1 mirror helpers; no other handler changes.

**Note:** the gate is built from `writeRequiresToken_` / `tokenOk_`, whose logic is the mirror of
`src/auth.js` and is already unit-tested (`test/auth.test.js`). GAS `doPost` itself isn't
node-testable.

**Tests:** full `node --test` suite green (85 pass / 0 fail). No pre-existing failures.

**Deploy notes:**
1. **Prerequisite:** Steps 1 & 2 live (frontend sending `token`, Script Property set).
2. **Backend:** paste updated `apps-script/Code.gs` → **New version of the existing deployment**
   (keep the `/exec` URL stable — never a new deployment).
3. **Verify on live:**
   - From the dashboard, approve/reject/refer a request → succeeds (token attached).
   - Direct call bypass check: `curl -sX POST "…/exec" -d '{"action":"approve","payload":{"id":"X","by":"רועי"}}'`
     → `{"ok":false,"error":"Unauthorized"}`. Same call **with** the correct `"token"` → succeeds.
   - `createRequest` from the public form still works with no token.

---

## [Increment 16 · Step 2] — Auth hardening: PIN out of HTML, server-verified staff gate

**Fixes Finding 1.** The staff PIN is no longer injected into page source or compared in the
browser. The server stops emitting `window.__STAFF_PIN__` entirely; the staff pages now prompt for
the code and verify it **server-side** via the Step-1 `verifyToken` endpoint. The verified token is
kept in `sessionStorage` for the session and attached as `token` to every staff write (so Step 3
can enforce it). Nothing secret is in the served HTML anymore.

**⚠️ Deploy order — do not deploy this before Step 1 is live.** The staff pages call
`verifyToken`, which only exists once Step 1's `Code.gs` is deployed **and** `STAFF_WRITE_TOKEN` is
set in Script Properties. Deploying the frontend first would lock staff out (gate fails closed →
redirect to `/`).

**Changed**
- `src/server.js` — stop injecting `window.__STAFF_PIN__`; drop the `STAFF_PIN` env dependency.
  Only the non-secret `__EXEC_URL__` is exposed to the page.
- `src/dashboard.html`, `src/inspection.html`, `src/reports.html`, `src/workorders.html` —
  replaced the client-side PIN compare with an async `staffGate()` that verifies the typed code via
  `?action=verifyToken`, stores the verified token in `sessionStorage` (`ezone_staff_token`), and
  gates page init behind it (`staffGate().then(load/init)`) so no data loads before verification.
  Fail-closed: wrong/blank code, cancel, or unset server token → wipe + redirect to `/`.
- Writes on the three pages with staff actions now send `token: window.__STAFF_TOKEN__` (dashboard
  `post`, inspection `post`, reports confirmFinding). `createRequest` (public intake) is untouched.

**Note:** this step is frontend wiring only; the testable auth predicate is already covered by
`test/auth.test.js` from Step 1. No new pure module to unit-test.

**Tests:** full `node --test` suite green (85 pass / 0 fail). No pre-existing failures.

**Deploy notes:**
1. **Prerequisite:** Step 1 deployed on Apps Script + `STAFF_WRITE_TOKEN` set in Script Properties,
   verified live (`?action=verifyToken`).
2. **Frontend:** merge to `main` → Railway redeploys automatically. Hard-refresh with `?v=` to bust
   cache. No `Code.gs` change in this step.
3. **Verify on live:** open `/dashboard` → prompt appears → wrong code redirects to `/`; correct
   code loads the board and persists for the session; approve/reject still work (writes now carry
   the token; backend still ignores it until Step 3).

---

## [Increment 16 · Step 1] — Auth hardening: server-side write-token infra (additive)

**Why:** Two auth gaps. (1) The staff PIN was injected into page HTML (`window.__STAFF_PIN__`)
and compared client-side — visible in View-Source. (2) The public `/exec` endpoint enforced no
server-side auth, so every write action (approve/reject/defer/assign/setStatus/deleteRequest/
editRequest/…) was directly callable, bypassing the UI. This is the first of three
independently-deployable steps that close both, using a single shared staff **write token** kept
**only in Apps Script Script Properties** (`STAFF_WRITE_TOKEN`) — never in the repo, never in page
HTML. The staff member types the code; the server verifies it.

**This step is purely additive — no behavior change on live.** It stands up the check and the
verify endpoint so the frontend (Step 2) can be built against it before enforcement flips on
(Step 3).

**Added**
- `src/auth.js` — pure, testable predicate shared by the backend mirror: `STAFF_WRITE_ACTIONS`
  (every mutating action except the public `createRequest`), `writeRequiresToken(action)`, and
  `tokenOk(provided, expected)` — a fail-closed constant-time compare (unset server secret, empty
  client token, or length mismatch all deny).
- `apps-script/Code.gs` — mirror of `src/auth.js` (`STAFF_WRITE_ACTIONS_`, `writeRequiresToken_`,
  `getWriteToken_` reading the `STAFF_WRITE_TOKEN` Script Property, `tokenOk_`) plus a new
  `verifyToken` read action on `doGet` that returns only `{ ok: true, valid: <bool> }` and never
  echoes the secret. **Writes are NOT yet gated in this step.**
- `test/auth.test.js` — locks the write set, the public-`createRequest` exemption, exact-match
  success, and fail-closed behavior on empty/missing secret or token.

**Tests:** full `node --test` suite green (11 files; +1 new). No pre-existing failures.

**Deploy notes:**
1. **Ops first (no code):** in the Apps Script editor confirm there is exactly **one** live Web-app
   deployment. Add a strong random `STAFF_WRITE_TOKEN` under Project Settings → Script Properties.
   Do **not** put it in the repo or Railway (the frontend never holds it).
2. **Backend:** paste the updated `apps-script/Code.gs` into the Apps Script editor and deploy a
   **New version of the existing deployment** (keep the `/exec` URL stable — never a new
   deployment).
3. Frontend needs no deploy for this step (`Code.gs` never auto-syncs from GitHub).

---

## [Increment 15] — Referral destination + status colors + wording

**Referred tasks now land in the right person's worklist (`src/workorders.html`, `src/workorders.js`)**
- A lead's weekly tab (רמי / צחי) now shows the requests Roy actually REFERRED to them
  (`assigned_to === lead`) that are still open (not הושלם/סגור) — previously it showed
  house-mapped, *unreferred* work, so a task vanished the moment Roy referred it. Now referred
  work appears for the assignee and carries forward week to week until completed.
- The pure `workorders.js` module was aligned to the same model and its tests rewritten so the
  module and the page can't drift.

**Dashboard clarity (`src/dashboard.html`)**
- Distinct color per status group (and a matching colored bar on each card): ממתין לאישור (teal),
  נדחה לתאריך (amber), מאושר—להפניה (blue), בביצוע (green), הושלם/סגור (grey), לא מאושר (red).
- Renamed the approved group to **"מאושר — להפניה לביצוע"**; removed all remaining "הקצאה"
  wording (now "הפניה"). Roy's referral happens on the approved card via "הפנה לביצוע" → modal
  (רמי / צחי / בעל מקצוע), exactly as before.

**Tests:** full suite green (10 files).

**Deploy notes:**
1. Frontend-only — Railway redeploys from main automatically. No Apps Script change, no
   `setupSheet()` needed.

---

## [Increment 14] — Roy-alone approval + live external worklist

**What:** Roy approves alone at any amount (Sandra was removed from approval in Inc 10), and the
בעלי מקצוע weekly worklist now shows live external work — both waiting-to-refer and in-progress —
instead of only unassigned approved items.

**Changed**
- `apps-script/Code.gs` — `whoApproves_` returns `'auto'` for emergency, else `'roy'` (no more
  amount/threshold routing to Sandra); `canApprove_` returns `true` (any amount is Roy's call;
  emergency auto-approves). The "above threshold requires Sandra" / "Not authorized for this amount"
  approve/reject errors are now "Not authorized for this status".
- `src/approval.js` — mirrors the same Roy-alone rules. `whoApproves` → `'auto'`/`'roy'`;
  `canApprove` → `true`; `validateApproval`'s error no longer mentions Sandra. Function signatures
  (incl. the `threshold` param) are unchanged for compatibility.
- `test/approval.test.js` — assertions updated: any amount → `'roy'`; Roy can approve above the
  old threshold; `validateApproval` of a 4000 request by Roy now returns APPROVED instead of
  throwing.
- `src/workorders.html` — `renderExternal()` now lists every external-trade request that isn't
  done (`הושלם`/`סגור`), regardless of assignment, and shows each row's status (ממתין vs בביצוע).

**Why:** Approval authority consolidated on Roy; the external worklist should reflect live state so
in-progress jobs stay visible until completed.

**Deploy note:** the updated `apps-script/Code.gs` must be pasted into the Apps Script editor and
redeployed as a NEW VERSION for the approval change to take effect live.

---

## [Increment 13] — Refer flow fixes, visible assignee, external weekly tasks

**IMPORTANT — this re-lands Increment 12.** Increment 12 (trade picker + smart batching) was
pushed to PR #10's branch but only Increment 11 actually merged to `main`; 12's code was never on
`main`. This increment re-applies 12 and adds the fixes below, so deploying it brings both live.

**Refer / assign (`src/dashboard.html`)**
- Renamed the action from "הקצאה לאחראי" to **"הפנה"** ("refer to") throughout.
- Replaced the fragile confirm/prompt chain (which silently did nothing on cancel and let any
  name be typed) with a proper **modal**:
  - Internal: the house's maintenance lead is **auto-resolved and shown** (not typed), so a
    Raanana job can only go to Rami, never Tzachi.
  - External: a **trade dropdown** (no free text); option to "mark for batching" without assigning.
- The assignee is now **clearly visible on each card**: "↩ הופך ל: <name> (אחראי בית / בעל מקצוע)",
  or "סומן ל: <trade> — ממתין לאיגום" when marked but not yet referred.

**Weekly tasks (`src/workorders.html`)**
- New **"בעלי מקצוע"** tab beside Rami / Tzachi: approved external work grouped **by trade**
  (all electrical together, all plumbing together), with house + cluster shown. Roy can now hand
  external task lists too, not just internal leads.

**Why the live test failed before:** the deployed frontend was Increment 11 while batching/trade
logic was never on `main`, so the trade picker never appeared and approve/refer actions hit a
mismatched backend. Deploying this increment (frontend + Code.gs from the same commit) resolves it.

**Tests:** full suite green (10 files).

**Deploy notes:**
1. Paste `apps-script/Code.gs` into Apps Script → Deploy → NEW VERSION.
2. Re-run `setupSheet()` once — appends the `trade` column (Requests) if not already present.
3. No new env vars.

---

## [Increment 12] — Trade-based external assignment + smart batching

**Trades, not named technicians**
- External work is tracked BY TRADE, not by a specific person. New `TRADES` vocabulary in
  `src/schema.js`: חשמלאי, אינסטלטור, איש מזגנים, צבעי, איש בריכות, איש רשתות, עבודות אלומיניום,
  עבודות נגרות, אחר.
- New `trade` column on the `Requests` sheet (`src/schema.js`, `apps-script/setup.gs`).

**Assignment (`src/dashboard.html`)**
- "הקצאה לביצוע" now asks internal (רמי / צחי) vs external. External assignment picks a trade
  from the list. Roy can either assign now (single visit) or just mark the trade for future
  batching (status stays מאושר). Trade + 🔗 batch shown on cards.

**Smart batching (§10) — by trade × cluster**
- New pure module `src/batching.js`: `houseClusterMap`, `isBatchable`, `suggestBatches`,
  `makeBatchId`. A request is batchable when approved + external + has a trade + not yet batched.
  Suggestions group approved external requests sharing the SAME trade AND the SAME proximity
  cluster (sharon / caesarea / north); single jobs aren't batches; largest batch first.
- Locked distinction preserved: cluster ≠ maintenance lead. North never batches with Caesarea
  even though Tzachi covers both.
- Dashboard shows a "הצעות לאיגום ביקורי טכנאי" panel; one click assigns the whole group under a
  shared `batch_id` and moves them to בביצוע together.

**Backend (`apps-script/Code.gs`)**
- `assign` now stores `trade`. New `markExternal` (mark approved request external + trade, no
  status change) and `assignBatch` (assign a group under one batch_id). Trades validated
  server-side; batch transitions use the existing legality + audit rules.

**Tests**
- `test/batching.test.js`: trade×cluster grouping, the negative cases (different cluster / different
  trade don't batch), single-job exclusion, ordering. `test/schema.test.js` updated for the new
  column (23). Full suite green (10 files).

**Security:** trades whitelisted server-side; batching is read-only suggestion + audited group
assign; no secrets added.

**Deploy notes:**
1. Paste `apps-script/Code.gs` into Apps Script → Deploy → NEW VERSION.
2. Re-run `setupSheet()` once — appends the new `trade` column to Requests.
3. No new env vars.

---

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

## [Increment 25] — ספירת מלאי: monthly inventory count per house

**What:** New staff-gated `/inventory` page + "מלאי" nav tab on every page. Once a month, the
house's maintenance lead (רמי / צחי, with רועי as backstop) counts the house stock across three
categories: **טואלטיקה** (incl. נייר טואלט), **חומרי ניקוי**, **מזון**.

**Model**
- Two new sheets (schema.js + setup.gs, append-safe): `InventoryItems` (the countable-item
  catalog — edit in the Sheet: `active=FALSE` hides, new rows extend, no code change) and
  `InventoryCounts` (one row PER ITEM per submitted count, grouped by `count_id`).
- Re-submitting the same house+month appends a NEW count — nothing is overwritten, the sheet
  keeps full history; the UI shows the latest `counted_at` per house+month.
- `setupSheet()` seeds ~27 catalog items across the three categories (idempotent, seed-if-empty).
  **Re-run `setupSheet()` after the redeploy** to create the two sheets + seed.

**Backend (`apps-script/Code.gs`)**
- New reads: `?action=inventoryItems`, `?action=inventoryCounts`.
- New staff write `submitInventory` (added to `STAFF_WRITE_ACTIONS_`, token-gated fail-closed):
  validates house / `YYYY-MM` month / counter (רמי·צחי·רועי) / category whitelist / quantity as a
  number ≥ 0; blank quantities are skipped; at least one filled quantity required; notes capped at
  500 chars. Writes all item rows in ONE batched `setValues` (not N appendRow calls) and one
  AuditLog entry per submission (`ספירת מלאי`).

**Frontend**
- `src/inventory.html`: staffGate (same verifyToken pattern as /workorders), two tabs —
  **ספירה** (quantity per item grouped by category, prefilled from the month's latest count,
  optional per-item note) and **מצב חודשי** (per-house counted / טרם-נספר table + full detail for
  the selected house, printable). Counter defaults to the house's own maintenance lead
  (overridable). Mobile media block included; RTL preserved.
- `src/inventory.js`: pure mirrored logic — `validateInventorySubmission`, `groupCatalog`,
  `latestCountFor`, `latestByHouse`, `currentMonth`, `isValidMonth`, `isValidQuantity`.
- Nav on all six pages: דרישה חדשה · דשבורד · משימות פתוחות וסטטוס · **מלאי** · בקרה · דוחות.
- `src/server.js`: `/inventory` route added.

**Security**
- `submitInventory` requires the staff token, verified server-side (constant-time, fail-closed).
- Drift fix: `setExecution` was token-gated in Code.gs but missing from the `src/auth.js` mirror —
  both lists now match exactly again (auth.test.js updated to lock the new set).
- All rendered values escaped (`esc()`); category/counter whitelists enforced server-side.

**Tests** — `node --test`: **149 pass** (was 130). New `test/inventory.test.js` (19 tests: schema
lock, month/quantity primitives, submission validation incl. blank-tolerance, catalog grouping,
latest-count supersession scoped to house+month). Updated locks: schema SHEET_NAMES,
auth STAFF_WRITE_ACTIONS, mobile-css PAGES (+inventory.html).

**Deploy steps (after merge to `main`)**
1. Railway auto-deploys the frontend from `main`.
2. Copy `apps-script/Code.gs` from the RAW GitHub `main` view → paste into the Apps Script
   editor → Save → deploy a **New Version of the EXISTING deployment** (never a new deployment).
3. Do the same for `setup.gs`, then run `setupSheet()` once — creates `InventoryItems` +
   `InventoryCounts` and seeds the catalog.
4. Verify: open `/inventory`, enter staff code, submit a test count → check the
   `InventoryCounts` sheet and the AuditLog `ספירת מלאי` entry; DevTools Network second-row
   response must be `{ok:true,...}`.

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
