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

**Then it verifies the LIVE deployment.** clasp's `Deployed` line only proves it
redeployed the deployment named by `DEPLOYMENT_ID` — not that that deployment is
the one production calls. So a final step probes the real `/exec` (the URL in
`APPS_SCRIPT_EXEC_URL`, the same value Railway uses):

- `action=users` — exists on **every** published version (baseline: is the URL reachable at all?).
- `action=bundle` — exists **only on the current `Code.gs`** (recent-only: is the new code actually live?).

If `bundle` doesn't answer `{"ok":true,…}` with a `houses` key (after a few
retries for propagation), the workflow **fails**. Baseline-passes-but-bundle-fails
means `DEPLOYMENT_ID` is deploying a **different** deployment than the one
`APPS_SCRIPT_EXEC_URL` points at (green CI, stale production) — realign
`DEPLOYMENT_ID` to that deployment's id.

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
