# Changelog

All notable changes to EZone Logistics are documented here, per the project working rule
(documentation for every change and every commit). Newest first.

## [Unreleased] — terminology "העברה לביצוע" + RTL-safe dates

**Docs / CI**
- clasp CI rollout marked COMPLETE (verified 22/07/2026). `EZONE-ECOSYSTEM-STATUS.md` updated to the July 22 version — new "Apps Script deployment" section (automatic via GitHub Actions, clasp 3.3.0, hardened; trigger = merge to the deployed branch `main` touching `apps-script/**`; redeploys the EXISTING deployment so the `/exec` URL is unchanged; per-repo secrets `CLASPRC_JSON` + `DEPLOYMENT_ID`; token-refresh = `clasp login` → update `CLASPRC_JSON` in all six repos with the same value), a per-app deployed-branch table verified 22/07/2026, and ezone-kitchen + ezone-coordinators added to the app table. All manual copy-paste redeploy instructions marked OBSOLETE (superseded by clasp CI; emergency fallback only), in the doc and `DEPLOY.md`.
- CI: bumped `actions/checkout` and `actions/setup-node` to **v5** in the Deploy Apps Script workflow, clearing the Node 20 deprecation warning (both v5 run on Node 24; clasp `node-version` pin stays `22`).

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
