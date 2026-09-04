// test/help-page.test.js — locks the /help (מדריך) in-app guide:
//   - the route is TOKEN-GATED server-side: anonymous / garbage / forged tokens get 401 and NEVER see the
//     guide content (the 401 body is only the loader shell, which carries the auth shim so real browser
//     navigation re-fetches with the Bearer token);
//   - a valid session token gets 200 with the guide (both login-roster roles);
//   - the served guide describes chain B v3 (אולגה approves everything) and mentions no amount threshold;
//   - the מדריך nav link is present on the dashboard page (static markup) and in the shim's role nav for
//     both login-roster roles (field_ops, ops_manager).
process.env.APPS_SCRIPT_EXEC_URL = 'https://example.invalid/exec';
process.env.SESSION_SECRET = 'k'.repeat(32);
process.env.SESSION_DAYS = '7';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { signToken } from '../src/auth.js';
import { navByRole } from '../src/access.js';

// server.js reads env at module-load time — import it dynamically after the env is set.
const { requestHandler } = await import('../src/server.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const SECRET = 'k'.repeat(32);

let server, base;

before(async () => {
  server = createServer(requestHandler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
});

function get(path, headers) {
  return fetch(`${base}${path}`, { headers: headers || {} });
}
function tokenFor(role) {
  return signToken(SECRET, 7, { name: 'בדיקה', role, scope: '' });
}

test('/help without a token → 401, and the body holds NO guide content', async () => {
  const r = await get('/help');
  assert.equal(r.status, 401);
  const body = await r.text();
  // The 401 shell must not leak any guide section to an anonymous caller.
  for (const s of ['ממתין לאישור', 'חירום', 'מי עושה מה', 'ספירה שבועית']) {
    assert.ok(!body.includes(s), `401 shell must not contain ${JSON.stringify(s)}`);
  }
  // ...but it DOES carry the injected auth shim, so a real browser can log in and re-fetch.
  assert.ok(body.includes('/api/exec'), '401 shell must carry the auth shim');
});

test('/help with a garbage token → 401', async () => {
  const r = await get('/help', { Authorization: 'Bearer nope.deadbeef' });
  assert.equal(r.status, 401);
});

test('/help with a token forged with the wrong key → 401', async () => {
  const forged = signToken('w'.repeat(32), 7, { name: 'בדיקה', role: 'ops_manager', scope: '' });
  const r = await get('/help', { Authorization: `Bearer ${forged}` });
  assert.equal(r.status, 401);
});

test('/help with a valid token → 200 with the guide content (both login-roster roles)', async () => {
  for (const role of ['field_ops', 'ops_manager']) {
    const r = await get('/help', { Authorization: `Bearer ${tokenFor(role)}` });
    assert.equal(r.status, 200, `${role} must get 200`);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
    const body = await r.text();
    for (const s of ['מדריך', 'ממתין לאישור', 'חירום']) {
      assert.ok(body.includes(s), `${role} guide must contain ${JSON.stringify(s)}`);
    }
  }
});

test('the served guide has NO amount threshold and no field_ops / ceo approver — אולגה approves everything (chain B v3)', async () => {
  const r = await get('/help', { Authorization: `Bearer ${tokenFor('field_ops')}` });
  const body = await r.text();
  assert.ok(!body.includes('3000'), 'no threshold amount in the guide');
  assert.ok(!body.includes('3,000'), 'no threshold amount in the guide');
  assert.ok(!body.includes('approval_threshold'), 'the guide no longer reads the (legacy) threshold');
  assert.ok(!/סף האישור|js-threshold/.test(body), 'no threshold row / placeholder remains');
  assert.ok(!/סנדרה|מנכ"ל|מנכ״ל/.test(body), 'no ceo / Sandra approver in the guide');
  assert.ok(/המאשרת היחידה/.test(body), 'אולגה is documented as THE approver');
});

test('the dashboard page carries the מדריך nav link', async () => {
  const r = await get('/dashboard');
  assert.equal(r.status, 200);
  const body = await r.text();
  assert.ok(body.includes('<a href="/help">מדריך</a>'), 'static nav must link to /help');
});

test('the shim role-nav lists /help for the login roster (field_ops + ops_manager), not for others', () => {
  const nav = navByRole();
  for (const role of ['field_ops', 'ops_manager']) {
    const link = (nav[role] || []).find((l) => l.href === '/help');
    assert.ok(link, `${role} must have the /help nav link`);
    assert.equal(link.label, 'מדריך');
  }
  for (const role of ['coordinator']) {
    assert.ok(!(nav[role] || []).some((l) => l.href === '/help'), `${role} must not list /help`);
  }
});

test('the service worker treats /help as NETWORK-FIRST (never a cached answer for the auth check)', () => {
  const sw = readFileSync(join(__dirname, '..', 'src', 'public', 'sw.js'), 'utf8');
  const routes = sw.match(/var DOCUMENT_ROUTES = \[[\s\S]*?\];/)[0];
  assert.ok(routes.includes("'/help'"), 'sw.js DOCUMENT_ROUTES must list /help');
  assert.ok(routes.includes("'/help.html'"), 'sw.js DOCUMENT_ROUTES must list /help.html');
});
