// test/smoke-live.js — POST-DEPLOY smoke test against the REAL deployed app. NOT a unit test: it is
// excluded from `npm test` (which runs only test/*.test.js) and must be run by hand after every merge:
//
//   APP_URL=https://<your-app> node test/smoke-live.js
//   APP_URL=https://<your-app> EXPECTED_COMMIT=$GITHUB_SHA node test/smoke-live.js     # + version-match gate
//   APP_URL=https://<your-app> SMOKE_USER='רועי' SMOKE_PIN='...' node test/smoke-live.js   # + authed read
//
// It verifies the ONE thing unit tests can't (they mock Apps Script): the whole live chain
// browser → Node (Railway) → Apps Script /exec (302) → Sheets actually responds. Checks:
//   0. GET /version     → 200; prints the live node + appsScript commits, and (with EXPECTED_COMMIT set)
//                         FAILS unless the live Node build serves that exact commit (Railway not stale).
//   1. GET /            → 200 and the login shim markup is present (the page can prompt for login).
//   2. POST /api/login  → a proper JSON 401 for a bogus user (the whole Node→Apps Script auth path
//                         responds with JSON — not a crash, hang, HTML error page, or 5xx).
//   3. (optional) with SMOKE_USER/SMOKE_PIN → login returns 200 + token, and one authenticated read
//                         (GET /api/data?action=houses) returns 200 — proving an end-to-end read works.
// Exit code 0 only if every attempted check passes; non-zero otherwise (so it can gate a deploy).

const APP_URL = (process.env.APP_URL || '').replace(/\/+$/, '');
const SMOKE_USER = process.env.SMOKE_USER || '';
const SMOKE_PIN = process.env.SMOKE_PIN || '';
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS) || 20000;
// When set (e.g. GITHUB_SHA in CI after a merge), the /version check FAILS unless the live Node build
// serves this exact commit — proving Railway actually deployed it, not a stale build.
const EXPECTED_COMMIT = (process.env.EXPECTED_COMMIT || '').trim();

if (!APP_URL) {
  console.error('FAIL: APP_URL is required.\n  usage: APP_URL=https://<your-app> node test/smoke-live.js');
  process.exit(2);
}

let failures = 0;
const pass = (m) => console.log(`PASS  ${m}`);
const fail = (m) => { console.error(`FAIL  ${m}`); failures++; };

async function req(path, init) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${APP_URL}${path}`, { ...init, redirect: 'follow', signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function checkHome() {
  try {
    const r = await req('/', { headers: { Accept: 'text/html' } });
    const body = await r.text();
    if (r.status !== 200) return fail(`GET / returned ${r.status} (expected 200)`);
    // The auth shim is injected into every served page; these markers prove it shipped and the page can
    // present the login overlay. ('כניסה — לוגיסטיקה' is the overlay title; __EXEC_URL__ is the shim.)
    if (!body.includes('__EXEC_URL__')) return fail('GET / body is missing the auth shim (__EXEC_URL__)');
    if (!body.includes('כניסה')) return fail('GET / body is missing the login markup (כניסה)');
    pass('GET / → 200 with login shim markup');
  } catch (e) {
    fail(`GET / threw: ${e && e.message ? e.message : e}`);
  }
}

async function checkLogin401() {
  try {
    const r = await req('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '__smoke_no_such_user__', pin: '__nope__' }),
    });
    const ct = r.headers.get('content-type') || '';
    if (r.status !== 401) return fail(`POST /api/login (bogus) returned ${r.status} (expected 401) — the Node→Apps Script auth path is not responding correctly`);
    if (!/application\/json/i.test(ct)) return fail(`POST /api/login returned 401 but content-type is "${ct}" (expected JSON)`);
    let j;
    try { j = JSON.parse(await r.text()); } catch (e) { return fail('POST /api/login 401 body is not valid JSON'); }
    if (j.ok !== false) return fail(`POST /api/login JSON missing ok:false (got ${JSON.stringify(j)})`);
    pass('POST /api/login (bogus user) → proper JSON 401 (whole auth path responds)');
  } catch (e) {
    fail(`POST /api/login threw: ${e && e.message ? e.message : e}`);
  }
}

async function checkAuthedRead() {
  if (!SMOKE_USER || !SMOKE_PIN) {
    console.log('SKIP  authenticated read (set SMOKE_USER and SMOKE_PIN to enable)');
    return;
  }
  let token;
  try {
    const r = await req('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: SMOKE_USER, pin: SMOKE_PIN }),
    });
    const j = JSON.parse(await r.text());
    if (r.status !== 200 || !j.token) return fail(`login for SMOKE_USER failed (status ${r.status}) — check SMOKE_USER/SMOKE_PIN`);
    token = j.token;
    pass(`POST /api/login (${SMOKE_USER}) → 200 with token`);
  } catch (e) {
    return fail(`authed login threw: ${e && e.message ? e.message : e}`);
  }
  try {
    const r = await req('/api/data?action=houses', { headers: { Authorization: `Bearer ${token}` } });
    const j = JSON.parse(await r.text());
    if (r.status !== 200 || !j.ok || !Array.isArray(j.data)) return fail(`authenticated read (houses) failed (status ${r.status}, body ${JSON.stringify(j).slice(0, 120)})`);
    pass(`authenticated read GET /api/data?action=houses → 200 with ${j.data.length} house(s)`);
  } catch (e) {
    fail(`authenticated read threw: ${e && e.message ? e.message : e}`);
  }

  // The `bundle` action must be LIVE on Apps Script — otherwise every manager page silently falls back
  // to N individual reads (slow tab switches, the exact production symptom). A degraded pageData means
  // clasp CI did not publish the current Code.gs. Only a manager SMOKE_USER can aggregate the dashboard;
  // a non-manager gets 403 and the check is skipped (not failed).
  try {
    const r = await req('/api/data?action=pageData&page=dashboard', { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 403) { console.log('SKIP  pageData bundle check (SMOKE_USER is not a manager tier)'); return; }
    const j = JSON.parse(await r.text());
    if (r.status !== 200 || !j.ok) return fail(`pageData dashboard failed (status ${r.status}, body ${JSON.stringify(j).slice(0, 120)})`);
    if (j.degraded) return fail('pageData is DEGRADED — the live Apps Script lacks the `bundle` action; clasp CI has not deployed the current Code.gs (tab switches will be slow). See DEPLOY.md.');
    pass('pageData dashboard → 200 and NOT degraded (live Apps Script has the `bundle` action)');
  } catch (e) {
    fail(`pageData bundle check threw: ${e && e.message ? e.message : e}`);
  }
}

async function checkVersion() {
  try {
    const r = await req('/version', { headers: { Accept: 'application/json' } });
    if (r.status !== 200) return fail(`GET /version returned ${r.status} (expected 200) — is this build post-version?`);
    const j = JSON.parse(await r.text());
    const node = j && j.node && j.node.commit ? String(j.node.commit) : '';
    const gs = j && j.appsScript && j.appsScript.commit ? String(j.appsScript.commit) : '';
    if (!node) return fail(`GET /version missing node.commit (got ${JSON.stringify(j).slice(0, 140)})`);
    console.log(`INFO  live versions — node=${node}  appsScript=${gs}  builtAt=${(j.node && j.node.builtAt) || '?'}`);
    if (EXPECTED_COMMIT) {
      if (node === EXPECTED_COMMIT) return pass(`/version node.commit === EXPECTED_COMMIT (${EXPECTED_COMMIT}) — Railway serves this commit`);
      return fail(`/version node.commit=${node} != EXPECTED_COMMIT=${EXPECTED_COMMIT} — Railway is STALE (not yet redeployed this commit, or the connected branch is wrong). See DEPLOY.md.`);
    }
    pass(`GET /version → 200 (node=${node}, appsScript=${gs}); set EXPECTED_COMMIT to assert an exact match`);
  } catch (e) {
    fail(`GET /version threw: ${e && e.message ? e.message : e}`);
  }
}

(async () => {
  console.log(`smoke-live against ${APP_URL}`);
  await checkVersion();
  await checkHome();
  await checkLogin401();
  await checkAuthedRead();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
