# Deploy — E-ZONE Logistics

Two independent deploy paths:

| Layer | Runs it | Trigger |
| --- | --- | --- |
| **Node/Express + frontend** | Railway | Auto-deploys the connected branch (`main`, per `EZONE-ECOSYSTEM-STATUS.md`). |
| **Apps Script backend** (`apps-script/**`) | GitHub Actions → clasp | Push to `main` touching `apps-script/**` (below). |

## Automatic Apps Script deployment (clasp in CI)

**Workflow:** [`.github/workflows/deploy-apps-script.yml`](.github/workflows/deploy-apps-script.yml)

On every push to **`main`** that changes `apps-script/**` (or `.clasp.json` / the
workflow), CI installs `@google/clasp@3.3.0`, writes `~/.clasprc.json` from the
`CLASPRC_JSON` secret, runs `clasp push -f`, then `clasp deploy -i <DEPLOYMENT_ID>`
— a **new version of the EXISTING deployment**, so the `/exec` URL never changes.
It **fails loudly and early** if a secret is missing or `CLASPRC_JSON` isn't valid
JSON, and requires clasp's `Deployed …@<version>` confirmation (clasp 3.x can
reject an id and still exit 0).

**Before pushing, CI stamps the commit** into `Code.gs` (`var DEPLOY_COMMIT = '<GITHUB_SHA>'`),
so the live `action=version` returns exactly what was deployed.

**Then it verifies the LIVE deployment.** clasp's `Deployed` line only proves it
redeployed the deployment named by `DEPLOYMENT_ID` — not that that deployment is
the one production calls. So a final step probes the real `/exec` (the URL in
`APPS_SCRIPT_EXEC_URL`, the same value Railway uses):

- `action=version` — the **strongest** check: it must return `{"commit":"<GITHUB_SHA>"}`, proving the
  deployment behind `APPS_SCRIPT_EXEC_URL` is **this exact commit**.
- `action=bundle` / `action=users` — still probed to make a failure **actionable**: `users` exists on
  every version (is the URL reachable?), `bundle` only on recent code (reachable-but-stale?).

If `action=version` doesn't equal the deployed SHA (after a few retries for
propagation), the workflow **fails** — and the message says whether the `/exec`
was unreachable or reachable-but-stale. Reachable-but-stale means `DEPLOYMENT_ID`
deploys a **different** deployment than the one `APPS_SCRIPT_EXEC_URL` points at
(green CI, stale production) — realign `DEPLOYMENT_ID` to that deployment's id.

### ⚠️ After this merges, CI fails until you add two secrets

**Settings → Secrets and variables → Actions → New repository secret:**

| Secret | Value |
| --- | --- |
| `CLASPRC_JSON` | `npm i -g @google/clasp@3.3.0` → `clasp login` → full contents of `~/.clasprc.json` |
| `DEPLOYMENT_ID` | the `AKfyc…` segment of the live `/exec` URL (Manage deployments → the active Web App), no quotes/space |
| `APPS_SCRIPT_EXEC_URL` | the **full live `/exec` URL** (`https://script.google.com/macros/s/AKfyc…/exec`) — the **same value already set as `APPS_SCRIPT_EXEC_URL` in Railway**. Used by the post-deploy verification. `DEPLOYMENT_ID` must be the `AKfyc…` id **inside this URL** — if they name different deployments, CI stays green while production stays stale. |

> **Version alignment:** CI uses clasp **3.3.0**; log in with a 3.x clasp so the
> `~/.clasprc.json` format matches. Refresh: re-run `clasp login`, re-copy into
> `CLASPRC_JSON`.

### ⚠️ Confirm the manifest before the first deploy

`clasp push -f` overwrites the project's `appsscript.json` with the committed one
(`webapp.access: ANYONE_ANONYMOUS`, `executeAs: USER_DEPLOYING`, V8,
Asia/Jerusalem — the standard ecosystem Web App settings). If the live project
differs, run `clasp pull` locally and commit the real manifest first — flipping
access off "Anyone" breaks anonymous `/exec` consumers.

## Version truth & self-verifying deploys

The app's failure history is **version mismatch** across three independent legs (Railway / clasp / service
worker). These make the live version of each leg **provable at a glance** and make every deploy
**self-verifying**, so a green deploy can't hide a stale leg.

**`GET /version`** (Node, unauthenticated, non-secret) returns:

```json
{ "node": { "commit": "<railway git sha>", "builtAt": "<ISO boot time>" },
  "appsScript": { "commit": "<live /exec action=version>" } }
```

- `node.commit` = `RAILWAY_GIT_COMMIT_SHA` injected by Railway at build time (`unknown` locally).
- `appsScript.commit` = the live `/exec` `action=version` (`DEPLOY_COMMIT`, stamped by the clasp workflow),
  cached ~60s. `unreachable` if `/exec` can't be reached.

**Footer.** Every page (including the login screen) shows a small gray `node <sha> · gs <sha>` footer
(injected by the auth shim, reads `/version`). Anyone can see what's live without tooling.

**Three legs, three verifications:**

| Leg | Live version source | Self-verified by |
| --- | --- | --- |
| **Node (Railway)** | `GET /version` → `node.commit` | [`verify-live.yml`](.github/workflows/verify-live.yml) — on push to `main` (and on-demand), polls the live `/version` until `node.commit == GITHUB_SHA`, then runs `smoke-live.js`. Fails if Railway stays stale. |
| **Apps Script (clasp)** | `/exec?action=version` → `commit` | the `deploy-apps-script.yml` post-deploy step (above) asserts it `== GITHUB_SHA`. |
| **Service worker** | `/sw.js` cache name `ezone-logistics-<commit>` | Node stamps the running commit into the SW cache name at serve time, so **every deploy changes it** → the SW's `activate()` purges all prior caches → returning visitors and incognito first-loads both get fresh documents. |

**How to trigger the Railway check yourself:**

```bash
APP_URL=https://ezone-logistics.up.railway.app EXPECTED_COMMIT=<sha> node test/smoke-live.js
```

`verify-live.yml` runs this automatically after each merge (with `EXPECTED_COMMIT=github.sha`). The app URL
defaults to the public Railway host; override with an `APP_URL` **repo variable** if the host changes.
`APPS_SCRIPT_EXEC_URL` stays a **secret** — the clasp workflow reads it; you never paste it into a PR.

## Script Properties the live Apps Script needs

Set once in the Apps Script project (Project Settings → Script Properties); clasp does not manage them:

| Property | Same value as | Used for |
| --- | --- | --- |
| `SESSION_SECRET` | Railway `SESSION_SECRET` | verifying every session token independently of Node |
| `APPROVER_CODE` | Railway `APPROVER_CODE` | verifying the approver code on every non-emergency approve / reject (PR 1). **Set it BEFORE merging PR 1** — until it exists, Code.gs refuses every human approval (fail-closed) |
| `CREATE_REQUEST_SECRET` | ezone-coordinators intake secret | the server-to-server request intake |

PR 2 (אולגה approves everything) needs **no new property and no new env var**. After it merges, run
`setupSheet()` once so the retired סנדרה roster row is set `active=FALSE` (never deleted). `setUserPin()` is
retired and throws; `Users.pin_hash` stays as an unused, append-only column.

## Digest rebuild — deferred (perf round-4)

Write handlers no longer rebuild the coordinators digest inline. Each write calls `scheduleDigestRebuild()`,
which creates **one** one-off time-based trigger (~1 minute, handler `rebuildDigestFromTrigger`) if none is
pending; the handler deletes itself, then runs `rebuildDigest()` under the script lock. Expect a write to
show in the digest tabs within about a minute. Nothing to configure: the trigger scope
(`script.scriptapp`) is the one `installDigestTrigger()` already uses, and the 15-minute backstop stays.

- **Manual rebuild:** run `rebuildDigestNow()` from the Apps Script editor (synchronous, locked).
- **If writes seem not to reach the digest:** Apps Script → Triggers should show at most one
  `rebuildDigestFromTrigger` one-off plus the 15-minute `rebuildDigest`; the execution log shows
  `scheduleDigestRebuild failed: …` when trigger creation was refused (quota) — the backstop still rebuilds.

## Read cache — what to expect live (perf round-4)

Node caches every Apps Script read except `users`: houses / config / technicians 120 s, everything else
60 s, with a 10-minute stale fallback when Apps Script fails (`X-Cache: STALE` instead of a 502). Every
`/api/data` and `/api/action?action=managementData` response carries `X-Cache: HIT | MISS | STALE`
(DevTools → Network). Any write clears the dynamic entries on that Node instance. Append `?fresh=1` to a
data URL (or send `fresh: 1` in a managementData body) to force a live read — the fix for "I edited the
Sheet and the screen hasn't caught up yet" without waiting out a TTL.

## Security

- Credentials live **only** in GitHub Secrets — never committed, never printed;
  the runner's `~/.clasprc.json` is deleted at job end (`if: always()`).
- `.clasprc.json` / `.clasp.local.json` are git-ignored. The Script ID in
  `.clasp.json` is an identifier, not a secret.

## Manual fallback

> ⛔ **Emergency use only — not the routine path.** As of the July 2026 clasp CI rollout (verified 22/07/2026, ecosystem-wide), Apps Script deploys are **automatic** on every merge to the deployed branch. Reach for this manual `clasp` fallback only when CI itself is down. The old **copy-paste-into-the-Apps-Script-editor** procedure is **OBSOLETE** — do not hand-paste `Code.gs`. See `EZONE-ECOSYSTEM-STATUS.md` → "Apps Script deployment".

```bash
npm i -g @google/clasp@3.3.0 && clasp login
clasp push -f
clasp deploy -i <DEPLOYMENT_ID> -d "manual deploy"
```
