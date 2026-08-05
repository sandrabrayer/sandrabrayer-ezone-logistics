// test/login-roster.test.js — the login ROSTER + credential path (Bug 3).
//
// Two symptoms, one root cause: the login picker used to be a HARDCODED name list that duplicated the
// Users roster, so any Users-sheet edit (add / remove / rename / deactivate) made the dropdown drift —
// it could list a name that no longer matched a roster row, and selecting it + the correct code gave
// "שם או קוד שגויים". The fix derives the picker from the LIVE active roster (doGet('users')) through the
// SAME shared users-read path the login verification uses, so the two can never disagree.
//
// These tests drive the REAL gateway (src/server.js requestHandler) against a FAKE Apps Script upstream
// that serves the full 9-user seed (mirror of setup.gs SEED_USERS), and assert:
//   1. the roster endpoint returns ALL active users (and the picker is derived from it, inactive dropped);
//   2. login SUCCEEDS for every seeded user with the correct code (tier-A personal password, tier-B APP_PIN);
//   3. login FAILS CLOSED on the wrong code for every user;
//   4. the served '/' page injects the live active-roster names — no hardcoded drift;
//   5. the hardcoded FALLBACK list stays in sync with the seed.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { hashPin, rosterProof } from '../src/auth.js';
// NOTE: src/server.js reads its secrets/EXEC_URL from process.env AT MODULE LOAD. It must be imported
// only AFTER `before` sets them (ES modules are singletons — a top-level import would freeze empty env).
// So server.js exports are captured via a dynamic import inside `before`, below.
let loginRosterNames, isActiveUser, _DEFAULT_LOGIN_NAMES;

const SECRET = 'k'.repeat(40);
const APP_PIN = '246810';

// Correct code per seeded user. Managers (tier A) hold a personal password; tier B (coordinator +
// maintenance) share APP_PIN. Mirrors setup.gs SEED_USERS (name/role/house), fully provisioned so every
// user has a working login path.
const PW = { 'רועי': 'roy-pw', 'אולגה': 'olga-pw', 'סנדרה': 'sandra-pw' };
const SEED = [
  { name: 'רועי',  role: 'field_ops',   house: '' },
  { name: 'אולגה', role: 'ops_manager', house: '' },
  { name: 'סנדרה', role: 'ceo',         house: '' },
  { name: 'רמי',   role: 'maintenance', house: 'sharon' },
  { name: 'צחי',   role: 'maintenance', house: 'caesarea,north' },
  { name: 'שירה',  role: 'coordinator', house: 'קיסריה עפרוני' },
  { name: 'יעקב',  role: 'coordinator', house: 'קיסריה ריהאב' },
  { name: 'אורן',  role: 'coordinator', house: 'רעננה אשר' },
  { name: 'אביב',  role: 'coordinator', house: 'רמות השבים' },
];
const correctCode = (name) => (name in PW ? PW[name] : APP_PIN);

// Mutable roster so a test can deactivate / add a user and prove the picker follows. Each entry:
// { name, role, house, active, pin_hash }. Managers get a personal hash; everyone else has a blank hash
// (tier-B shared PIN). Rebuilt fresh before each test.
function buildRoster() {
  return SEED.map((u) => ({
    name: u.name, role: u.role, house: u.house, active: 'TRUE',
    pin_hash: u.name in PW ? hashPin(PW[u.name]) : '',
  }));
}
let roster = buildRoster(); // initialized eagerly so the upstream never sees `undefined`; beforeEach re-seeds

// Fake Apps Script upstream: mirrors usersForRead_ — pin_hash ONLY to the correct proof, stripped otherwise.
const upstream = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const action = u.searchParams.get('action');
  const send = (data) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, data })); };
  if (req.method === 'GET') {
    if (action === 'users') {
      const withHash = u.searchParams.get('auth') === rosterProof(SECRET);
      return send(withHash ? roster : roster.map((x) => { const c = { ...x }; delete c.pin_hash; return c; }));
    }
    if (action === 'houses') return send([]);
    return send([]);
  }
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
});

let gateway, base, _loginAttempts, _resetNodeCache;

before(async () => {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  process.env.APPS_SCRIPT_EXEC_URL = `http://127.0.0.1:${upstream.address().port}/exec`;
  process.env.SESSION_SECRET = SECRET;
  process.env.APP_PIN = APP_PIN;
  process.env.SESSION_DAYS = '7';
  const mod = await import('../src/server.js');
  _loginAttempts = mod._loginAttempts;
  _resetNodeCache = mod._resetNodeCache;
  ({ loginRosterNames, isActiveUser, _DEFAULT_LOGIN_NAMES } = mod);
  gateway = http.createServer(mod.requestHandler);
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${gateway.address().port}`;
});

after(async () => {
  await new Promise((r) => gateway.close(r));
  await new Promise((r) => upstream.close(r));
});

beforeEach(() => { roster = buildRoster(); _resetNodeCache(); _loginAttempts.clear(); });

async function login(name, pin) {
  _loginAttempts.clear();
  const r = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, pin }),
  });
  return { status: r.status, body: await r.json() };
}

// Names the served '/' picker was injected with (the shim sets `var NAMES=[...]`).
async function pickerNames() {
  const html = await (await fetch(`${base}/`)).text();
  const m = html.match(/var NAMES=(\[[^\]]*\]);/);
  return m ? JSON.parse(m[1]) : null;
}

// ---- 1. roster endpoint returns all active users; picker derives from it ----

test('the roster endpoint returns ALL active seeded users (9), and the picker lists exactly them', async () => {
  const names = await pickerNames();
  assert.deepEqual(names, SEED.map((u) => u.name), 'picker must list every active seeded user, in order');
  assert.equal(names.length, 9);
});

test('a DEACTIVATED user drops out of the picker (no hardcoded drift — the roster is the source of truth)', async () => {
  roster.find((u) => u.name === 'צחי').active = 'FALSE';
  _resetNodeCache(); // roster changed → re-derive
  const names = await pickerNames();
  assert.ok(!names.includes('צחי'), 'an inactive user must not appear in the login picker');
  assert.deepEqual(names, SEED.filter((u) => u.name !== 'צחי').map((u) => u.name));
});

test('a newly ADDED active user appears in the picker (picker follows the live roster)', async () => {
  roster.push({ name: 'דנה', role: 'coordinator', house: 'הפרדס', active: 'TRUE', pin_hash: '' });
  _resetNodeCache();
  const names = await pickerNames();
  assert.ok(names.includes('דנה'), 'a newly added active user must appear in the picker');
});

// ---- 2. login succeeds for EVERY seeded user with the correct code ----

for (const u of SEED) {
  test(`login SUCCEEDS for ${u.name} (${u.role}) with the correct code`, async () => {
    const r = await login(u.name, correctCode(u.name));
    assert.equal(r.status, 200, `${u.name} must log in with the correct code`);
    assert.ok(r.body.token, 'a session token must be issued');
    assert.equal(r.body.role, u.role, 'the role resolves from the roster, not the client');
  });
}

test('every name the picker offers can actually log in (picker ⟷ roster can never disagree)', async () => {
  const names = await pickerNames();
  for (const name of names) {
    assert.equal((await login(name, correctCode(name))).status, 200, `${name} is offered but cannot log in`);
  }
});

// ---- 3. login fails closed on the wrong code ----

for (const u of SEED) {
  test(`login FAILS CLOSED for ${u.name} with the wrong code (generic 401)`, async () => {
    const r = await login(u.name, 'definitely-wrong');
    assert.equal(r.status, 401, `${u.name} with a wrong code must be rejected`);
    assert.ok(!r.body.token, 'no token on a failed login');
  });
}

test('tier-A managers cannot log in with the shared APP_PIN (must use their own password)', async () => {
  assert.equal((await login('רועי', APP_PIN)).status, 401);
  assert.equal((await login('אולגה', APP_PIN)).status, 401);
});

test('an inactive user cannot log in even with the otherwise-correct code (fails closed)', async () => {
  roster.find((u) => u.name === 'שירה').active = 'FALSE';
  const r = await login('שירה', APP_PIN);
  assert.equal(r.status, 401, 'a deactivated user must not authenticate');
});

test('an empty code never authenticates anyone', async () => {
  for (const u of SEED) assert.equal((await login(u.name, '')).status, 401, `${u.name} + empty code must fail`);
});

// ---- 4. the served page injects the live shim, and a bad roster read falls back (never empty) ----

test('the served / injects the picker names into the shim in <head>', async () => {
  const html = await (await fetch(`${base}/`)).text();
  const headEnd = html.indexOf('</head>');
  const namesAt = html.indexOf('var NAMES=[');
  assert.ok(namesAt !== -1 && namesAt < headEnd, 'the picker roster must be injected inside <head>');
});

// ---- 5. the shared filter + the fallback list are correct ----

test('loginRosterNames applies the shared active filter (trim, dedupe, drop inactive/blank)', () => {
  const rows = [
    { name: 'רועי', active: 'TRUE' },
    { name: ' אולגה ', active: true },   // padded → trimmed
    { name: 'מושבת', active: 'FALSE' },  // inactive → dropped
    { name: 'רועי', active: '1' },       // dup → dropped
    { name: '', active: 'TRUE' },        // blank → dropped
  ];
  assert.deepEqual(loginRosterNames(rows), ['רועי', 'אולגה']);
  assert.equal(isActiveUser({ active: 'FALSE' }), false);
  assert.equal(isActiveUser({ active: 'TRUE' }), true);
});

test('the hardcoded FALLBACK list stays in sync with the seeded active roster (no silent drift)', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const setup = readFileSync(join(root, 'apps-script/setup.gs'), 'utf8');
  const block = setup.match(/var SEED_USERS = \[([\s\S]*?)\];/)[1];
  // Each seed row: [ 'name', 'role', 'house', 'ACTIVE', 'pin_hash' ] — keep names whose 4th field is TRUE.
  const seededActive = [...block.matchAll(/\[\s*'([^']+)'\s*,\s*'[^']*'\s*,\s*'[^']*'\s*,\s*'([^']*)'/g)]
    .filter((m) => m[2].toUpperCase() === 'TRUE').map((m) => m[1]);
  assert.deepEqual(_DEFAULT_LOGIN_NAMES, seededActive,
    'DEFAULT_LOGIN_NAMES (the fallback picker) must equal the active SEED_USERS names, in order');
});
