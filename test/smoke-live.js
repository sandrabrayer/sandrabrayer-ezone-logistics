// test/smoke-live.js — POST-DEPLOY smoke test against the REAL deployed app. NOT a unit test: it is
// excluded from `npm test` (which runs only test/*.test.js) and must be run by hand after every merge:
//
//   APP_URL=https://<your-app> node test/smoke-live.js
//   APP_URL=https://<your-app> SMOKE_USER='רועי' SMOKE_PIN='...' node test/smoke-live.js   # + authed read
//
// It verifies the ONE thing unit tests can't (they mock Apps Script): the whole live chain
// browser → Node (Railway) → Apps Script /exec (302) → Sheets actually responds. Checks:
//   1. GET /            → 200 public landing offering BOTH entry paths (טופס דרישה / כניסת מנהלים), NO shim.
//   2. GET /request     → 200 public request form (submitter roster injected), NO shim.
//   3. GET /login       → 200 managers-login page carrying the auth shim (can prompt for login).
//   4. POST /api/submit → a proper JSON 400 for an INVALID public request (the unauthenticated write path
//                         responds + validates through Node→Apps Script; no row is created).
//   5. POST /api/login  → a proper JSON 401 for a bogus user (the whole Node→Apps Script auth path
//                         responds with JSON — not a crash, hang, HTML error page, or 5xx).
//   6. (optional) with SMOKE_USER/SMOKE_PIN → login returns 200 + token, and one authenticated read
//                         (GET /api/data?action=houses) returns 200 — proving an end-to-end read works.
// Exit code 0 only if every attempted check passes; non-zero otherwise (so it can gate a deploy).

const APP_URL = (process.env.APP_URL || '').replace(/\/+$/, '');
const SMOKE_USER = process.env.SMOKE_USER || '';
const SMOKE_PIN = process.env.SMOKE_PIN || '';
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS) || 20000;

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
    // The landing is PUBLIC (no auth shim) and offers both entry paths.
    if (!body.includes('טופס דרישה')) return fail('GET / landing is missing the request-form path (טופס דרישה)');
    if (!body.includes('כניסת מנהלים')) return fail('GET / landing is missing the managers-login path (כניסת מנהלים)');
    if (body.includes('__EXEC_URL__')) return fail('GET / (public landing) must NOT carry the auth shim');
    pass('GET / → 200 public landing with both entry paths (no shim)');
  } catch (e) {
    fail(`GET / threw: ${e && e.message ? e.message : e}`);
  }
}

async function checkRequestForm() {
  try {
    const r = await req('/request', { headers: { Accept: 'text/html' } });
    const body = await r.text();
    if (r.status !== 200) return fail(`GET /request returned ${r.status} (expected 200)`);
    if (!body.includes('__PUBLIC_BOOT__')) return fail('GET /request is missing the injected boot data (houses + submitters)');
    if (body.includes('__EXEC_URL__')) return fail('GET /request (public form) must NOT carry the auth shim');
    pass('GET /request → 200 public request form (boot injected, no shim)');
  } catch (e) {
    fail(`GET /request threw: ${e && e.message ? e.message : e}`);
  }
}

async function checkLoginPage() {
  try {
    const r = await req('/login', { headers: { Accept: 'text/html' } });
    const body = await r.text();
    if (r.status !== 200) return fail(`GET /login returned ${r.status} (expected 200)`);
    if (!body.includes('__EXEC_URL__')) return fail('GET /login is missing the auth shim (__EXEC_URL__)');
    if (!body.includes('__FORCE_LOGIN__')) return fail('GET /login must auto-open the login overlay (__FORCE_LOGIN__)');
    pass('GET /login → 200 managers-login page with the auth shim');
  } catch (e) {
    fail(`GET /login threw: ${e && e.message ? e.message : e}`);
  }
}

async function checkPublicSubmitValidates() {
  try {
    // An INVALID public submit must return a JSON 4xx (validation) WITHOUT creating a row — proving the
    // unauthenticated write path responds through Node→Apps Script. A missing category is always invalid.
    const r = await req('/api/submit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: { created_by: 'smoke-test', house: 'no-such-house', urgency: 'רגיל' } }),
    });
    const ct = r.headers.get('content-type') || '';
    if (r.status !== 400) return fail(`POST /api/submit (invalid) returned ${r.status} (expected 400)`);
    if (!/application\/json/i.test(ct)) return fail(`POST /api/submit returned 400 but content-type is "${ct}" (expected JSON)`);
    const j = JSON.parse(await r.text());
    if (j.ok !== false) return fail(`POST /api/submit JSON missing ok:false (got ${JSON.stringify(j)})`);
    pass('POST /api/submit (invalid) → proper JSON 400 (public write path validates, no row created)');
  } catch (e) {
    fail(`POST /api/submit threw: ${e && e.message ? e.message : e}`);
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
}

(async () => {
  console.log(`smoke-live against ${APP_URL}`);
  await checkHome();
  await checkRequestForm();
  await checkLoginPage();
  await checkPublicSubmitValidates();
  await checkLogin401();
  await checkAuthedRead();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
