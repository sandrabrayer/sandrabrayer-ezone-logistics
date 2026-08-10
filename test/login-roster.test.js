// test/login-roster.test.js — the login ROSTER + shared-code credential path.
//
// Login is: pick a user from the dropdown + enter ONE shared access code (SHARED_ACCESS_CODE). Identity and
// role still come from the SELECTED roster user (Users sheet) — only the secret check is the shared code.
// The roster (picker AND who may log in) = ACTIVE MANAGER-TIER users only (field_ops = רועי, ops_manager =
// אולגה). ceo (סנדרה), maintenance (רמי/צחי) and coordinators do NOT log into this app.
//
// These drive the REAL gateway against a FAKE Apps Script upstream serving the seed roster, and assert:
//   1. the picker lists exactly the active manager-tier users (רועי, אולגה), derived from the live roster;
//   2. login SUCCEEDS for every roster user with the shared code, role resolved from the roster;
//   3. every non-manager (ceo/maintenance/coordinator) + wrong/empty code FAIL CLOSED (generic 401);
//   4. names are matched TRIMMED (a padded sheet cell still logs in);
//   5. the hardcoded FALLBACK list stays in sync with the seeded active manager-tier roster.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// server.js reads env AT MODULE LOAD, so it is imported only after `before` sets env (captured below).
let loginRosterNames, isActiveUser, _DEFAULT_LOGIN_NAMES;

const SECRET = 'k'.repeat(40);
const CODE = '2026'; // the shared access code (SHARED_ACCESS_CODE)

// Full seed roster (mirror of setup.gs SEED_USERS name/role/house). LOGIN_NAMES = the active manager-tier
// names, in sheet order — the only ones who may log in / appear in the picker. NON_LOGIN = everyone else.
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
const LOGIN_NAMES = ['רועי', 'אולגה'];
const NON_LOGIN = ['סנדרה', 'רמי', 'צחי', 'שירה', 'יעקב', 'אורן', 'אביב']; // ceo + maintenance + coordinators

function buildRoster() { return SEED.map((u) => ({ name: u.name, role: u.role, house: u.house, active: 'TRUE' })); }
let roster = buildRoster();

// Fake Apps Script upstream. The shared-code login reads the roster PUBLICLY (no proof) — pin_hash is
// irrelevant now — so the users read just returns name/role/house/active.
const upstream = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (data) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, data })); };
  if (req.method === 'GET') return send(u.searchParams.get('action') === 'users' ? roster : []);
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
});

let gateway, base, _loginAttempts, _resetNodeCache;

before(async () => {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  process.env.APPS_SCRIPT_EXEC_URL = `http://127.0.0.1:${upstream.address().port}/exec`;
  process.env.SESSION_SECRET = SECRET;
  process.env.SHARED_ACCESS_CODE = CODE;
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
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, pin }),
  });
  return { status: r.status, body: await r.json() };
}
async function pickerNames() {
  const html = await (await fetch(`${base}/`)).text();
  const m = html.match(/var NAMES=(\[[^\]]*\]);/);
  return m ? JSON.parse(m[1]) : null;
}

// ---- 1. picker = active manager-tier users only ----

test('the picker lists exactly the active manager-tier roster (רועי, אולגה), in order', async () => {
  assert.deepEqual(await pickerNames(), LOGIN_NAMES, 'picker = active LOGIN_ROLES users (field_ops + ops_manager)');
});

test('no non-manager (ceo / maintenance / coordinator) appears in the picker', async () => {
  const names = await pickerNames();
  for (const n of NON_LOGIN) assert.ok(!names.includes(n), `${n} must not be offered`);
});

test('a DEACTIVATED roster user drops out of the picker (roster is the source of truth)', async () => {
  roster.find((u) => u.name === 'אולגה').active = 'FALSE';
  _resetNodeCache();
  assert.deepEqual(await pickerNames(), ['רועי']);
});

test('a newly added active manager appears; a new maintenance / coordinator does NOT', async () => {
  roster.push({ name: 'דנה', role: 'field_ops', house: '', active: 'TRUE' });
  roster.push({ name: 'עידו', role: 'maintenance', house: 'sharon', active: 'TRUE' });
  roster.push({ name: 'נועה', role: 'coordinator', house: 'הפרדס', active: 'TRUE' });
  _resetNodeCache();
  const names = await pickerNames();
  assert.ok(names.includes('דנה'), 'a new active manager appears');
  assert.ok(!names.includes('עידו') && !names.includes('נועה'), 'a new maintenance/coordinator does NOT appear');
});

// ---- 2. login succeeds for every roster user with the shared code ----

for (const name of LOGIN_NAMES) {
  test(`login SUCCEEDS for ${name} with the shared code; role resolves from the roster`, async () => {
    const r = await login(name, CODE);
    assert.equal(r.status, 200, `${name} must log in with the shared code`);
    assert.ok(r.body.token, 'a session token is issued');
    assert.equal(r.body.role, SEED.find((u) => u.name === name).role, 'role comes from the SELECTED roster user');
    assert.equal(r.body.name, name);
  });
}

test('every name the picker offers can actually log in (picker ⟷ roster never disagree)', async () => {
  for (const name of await pickerNames()) {
    assert.equal((await login(name, CODE)).status, 200, `${name} is offered but cannot log in`);
  }
});

// ---- 3. fail closed: non-managers, wrong code, empty code ----

for (const name of NON_LOGIN) {
  test(`${name} CANNOT log in even with the correct shared code (not in the manager-tier roster)`, async () => {
    const r = await login(name, CODE);
    assert.equal(r.status, 401, `${name} must be refused`);
    assert.ok(!r.body.token);
  });
}

test('the WRONG code fails for every roster user (generic 401, no token)', async () => {
  for (const name of LOGIN_NAMES) {
    const r = await login(name, 'not-the-code');
    assert.equal(r.status, 401, `${name} + wrong code must fail`);
    assert.ok(!r.body.token);
  }
});

test('an EMPTY code never authenticates anyone', async () => {
  for (const name of LOGIN_NAMES) assert.equal((await login(name, '')).status, 401, `${name} + empty code must fail`);
});

test('an inactive roster user cannot log in even with the correct code', async () => {
  roster.find((u) => u.name === 'אולגה').active = 'FALSE';
  assert.equal((await login('אולגה', CODE)).status, 401);
});

// ---- 4. name is matched TRIMMED (guards a trailing-whitespace live sheet cell) ----

test('a padded roster name cell still logs in with the trimmed name (live-sheet whitespace guard)', async () => {
  roster.find((u) => u.name === 'רועי').name = ' רועי ';
  const r = await login('רועי', CODE);
  assert.equal(r.status, 200, 'trailing/leading whitespace in the sheet name must not block login');
  assert.equal(r.body.name, 'רועי', 'the token carries the trimmed name');
});

// ---- 5. picker injection + roster-filter unit + fallback sync ----

test('the served / injects the picker names into the shim in <head>', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.ok(html.indexOf('var NAMES=[') !== -1 && html.indexOf('var NAMES=[') < html.indexOf('</head>'));
});

test('loginRosterNames applies the roster filter (manager-tier + trim, dedupe, drop inactive/blank)', () => {
  const rows = [
    { name: 'רועי', role: 'field_ops', active: 'TRUE' },
    { name: ' אולגה ', role: 'ops_manager', active: true },  // padded → trimmed
    { name: 'מושבת', role: 'ops_manager', active: 'FALSE' }, // inactive → dropped
    { name: 'רועי', role: 'field_ops', active: '1' },        // dup → dropped
    { name: '', role: 'field_ops', active: 'TRUE' },         // blank → dropped
    { name: 'סנדרה', role: 'ceo', active: 'TRUE' },          // ceo → dropped (not LOGIN_ROLES)
    { name: 'רמי', role: 'maintenance', active: 'TRUE' },    // maintenance → dropped
    { name: 'שירה', role: 'coordinator', active: 'TRUE' },   // coordinator → dropped
  ];
  assert.deepEqual(loginRosterNames(rows), ['רועי', 'אולגה']);
  assert.equal(isActiveUser({ active: 'FALSE' }), false);
  assert.equal(isActiveUser({ active: 'TRUE' }), true);
});

test('the hardcoded FALLBACK list stays in sync with the seeded active manager-tier roster', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const setup = readFileSync(join(root, 'apps-script/setup.gs'), 'utf8');
  const block = setup.match(/var SEED_USERS = \[([\s\S]*?)\];/)[1];
  // Each seed row: [ 'name', 'role', 'house', 'ACTIVE', 'pin_hash' ] — keep active field_ops/ops_manager.
  const seededLogin = [...block.matchAll(/\[\s*'([^']+)'\s*,\s*'([^']*)'\s*,\s*'[^']*'\s*,\s*'([^']*)'/g)]
    .filter((m) => m[3].toUpperCase() === 'TRUE' && (m[2] === 'field_ops' || m[2] === 'ops_manager'))
    .map((m) => m[1]);
  assert.deepEqual(_DEFAULT_LOGIN_NAMES, seededLogin,
    'DEFAULT_LOGIN_NAMES (the fallback picker) must equal the active manager-tier SEED_USERS names, in order');
});
