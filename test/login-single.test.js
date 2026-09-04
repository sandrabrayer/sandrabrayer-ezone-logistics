// test/login-single.test.js — the SINGLE-LOGIN contract (PR 1): ONE password for the whole app, no
// per-person picker, no Users-sheet read on the login path.
//
// Drives the REAL gateway against a FAKE Apps Script upstream that COUNTS every hit, and asserts:
//   1. login = { pin } only → 200 + a token for the ONE app identity (name רועי, role ops_manager, no scope);
//      a legacy `name` field is ignored (whatever it says, the identity is the same);
//   2. a wrong / empty code → the same generic 401, no token;
//   3. the login path and the served pages make ZERO upstream calls (no roster read, so an Apps Script
//      outage / roster edit / deploy window can never break login or delay a page);
//   4. the injected shim has NO name picker (no <select>, no NAMES list) — one password field only;
//   5. the rate limiter still trips (fail-closed) after LOGIN_MAX attempts.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { verifyToken } from '../src/auth.js';

const SECRET = 'k'.repeat(40);
const CODE = '2026';        // the ONE login password (SHARED_ACCESS_CODE)
const APPROVER = 'olga-77'; // APPROVER_CODE (required at load; unused by the login path)

const hits = [];
const upstream = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  hits.push({ method: req.method, action: u.searchParams.get('action') });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, data: [] }));
});

let gateway, base, mod;

before(async () => {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  process.env.APPS_SCRIPT_EXEC_URL = `http://127.0.0.1:${upstream.address().port}/exec`;
  process.env.SESSION_SECRET = SECRET;
  process.env.SHARED_ACCESS_CODE = CODE;
  process.env.APPROVER_CODE = APPROVER;
  process.env.SESSION_DAYS = '7';
  mod = await import('../src/server.js');
  gateway = http.createServer(mod.requestHandler);
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${gateway.address().port}`;
});

after(async () => {
  await new Promise((r) => gateway.close(r));
  await new Promise((r) => upstream.close(r));
});

beforeEach(() => { hits.length = 0; mod._loginAttempts.clear(); mod._resetNodeCache(); });

async function login(body) {
  const r = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

// ---- 1. one password → the one identity ----

test('login with { pin } only → 200 + a token for the ONE app identity (רועי / ops_manager, no scope)', async () => {
  const { status, body } = await login({ pin: CODE });
  assert.equal(status, 200);
  assert.ok(body.token, 'a token is issued');
  assert.equal(body.name, 'רועי');
  assert.equal(body.role, 'ops_manager');
  assert.equal(body.scope, '');
  const claims = verifyToken(SECRET, body.token);
  assert.deepEqual({ name: claims.name, role: claims.role, scope: claims.scope }, { name: 'רועי', role: 'ops_manager', scope: '' });
  assert.deepEqual(mod._SESSION_IDENTITY, { name: 'רועי', role: 'ops_manager', scope: '' }, 'the exported identity is the one issued');
});

test('a legacy `name` field is IGNORED: any name (or none) yields the same identity', async () => {
  for (const name of ['אולגה', 'סנדרה', 'רמי', '__nobody__', '']) {
    const { status, body } = await login({ name, pin: CODE });
    assert.equal(status, 200, `name=${JSON.stringify(name)} must not matter`);
    const claims = verifyToken(SECRET, body.token);
    assert.equal(claims.name, 'רועי', 'identity never comes from the client');
    assert.equal(claims.role, 'ops_manager');
  }
});

// ---- 2. wrong / empty code → generic 401 ----

test('a wrong or empty code → 401 with no token (same generic error)', async () => {
  for (const pin of ['', '0000', CODE + ' ', 'olga-77', null]) {
    mod._loginAttempts.clear();
    const { status, body } = await login({ pin });
    assert.equal(status, 401, `pin=${JSON.stringify(pin)} must be refused`);
    assert.ok(!body.token, 'no token on failure');
    assert.equal(body.error, 'קוד גישה שגוי');
  }
});

// ---- 3. no upstream dependency ----

test('login makes ZERO upstream calls — the Users roster is never read', async () => {
  await login({ pin: CODE });
  await login({ pin: 'wrong' });
  assert.deepEqual(hits, [], 'no Apps Script call on the login path (success or failure)');
});

test('serving a page makes ZERO upstream calls (no per-request roster fetch for a picker)', async () => {
  for (const path of ['/', '/dashboard', '/workorders', '/management']) {
    const r = await fetch(`${base}${path}`);
    assert.equal(r.status, 200);
  }
  assert.deepEqual(hits, [], 'page serving never waits on Apps Script');
});

// ---- 4. the shim has no picker ----

test('the injected shim has NO name picker: no <select>, no NAMES list, one password field', async () => {
  const html = await (await fetch(`${base}/`)).text();
  const shim = html.slice(html.indexOf('<script>(function(){'), html.indexOf('</script>', html.indexOf('<script>(function(){')));
  assert.ok(shim.length > 1000, 'the shim is injected');
  assert.ok(!/var NAMES=/.test(shim), 'no roster list in the page');
  assert.ok(!/el\('select'/.test(shim), 'no <select> in the login overlay');
  assert.ok(/pin\.type='password'/.test(shim), 'one password field');
  assert.ok(/JSON\.stringify\(\{pin:pin\.value\}\)/.test(shim), 'the login POST carries only the password');
  assert.ok(!/סנדרה|אולגה|רמי|צחי/.test(shim), 'no person names anywhere in the shim');
});

// ---- 5. rate limit unchanged ----

test('login is still rate-limited: the 9th attempt in the window → 429, even with the right code', async () => {
  let last;
  for (let i = 0; i < 9; i++) last = await login({ pin: 'wrong' });
  assert.equal(last.status, 429);
  assert.equal((await login({ pin: CODE })).status, 429, 'the correct code is refused while limited');
});
