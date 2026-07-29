// test/staff-tiers.test.js — end-to-end tier + scope enforcement through the real gateway, backed
// by a FAKE Apps Script upstream (so we can serve a roster with pin_hashes, houses and requests).
// Covers: tier-A personal passwords, tier-B shared PIN, סנדרה (no login), generic 401s that never
// reveal the tier, and server-side house/cluster read filtering.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { hashPin, rosterProof } from '../src/auth.js';

const SECRET = 'k'.repeat(40);
const APP_PIN = '555555';

// --- fake Apps Script upstream ---
const USERS = [
  { name: 'רועי',  role: 'field_ops',   house: '',               active: 'TRUE', pin_hash: hashPin('roy-password') },
  { name: 'אולגה', role: 'ops_manager', house: '',               active: 'TRUE', pin_hash: hashPin('olga-password') },
  { name: 'סנדרה', role: 'ceo',         house: '',               active: 'TRUE', pin_hash: '' },
  { name: 'רמי',   role: 'maintenance', house: 'sharon',         active: 'TRUE', pin_hash: '' },
  { name: 'שירה',  role: 'coordinator', house: 'קיסריה עפרוני',   active: 'TRUE', pin_hash: '' },
];
const HOUSES = [
  { name: 'רעננה',         cluster: 'sharon' },
  { name: 'קיסריה עפרוני', cluster: 'caesarea' },
  { name: 'ריהאב',         cluster: 'caesarea' },
  { name: 'שדה אליעזר',    cluster: 'north' },
];
const REQUESTS = [
  { id: 'REQ-1', house: 'קיסריה עפרוני' },
  { id: 'REQ-2', house: 'רעננה' },
  { id: 'REQ-3', house: 'ריהאב' },
  { id: 'REQ-4', house: 'שדה אליעזר' },
];

const upstream = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const action = u.searchParams.get('action');
  const send = (data) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, data })); };
  if (req.method === 'GET') {
    if (action === 'users') {
      // Mirror usersForRead_: hashes ONLY to the correct proof; otherwise stripped.
      const withHash = u.searchParams.get('auth') === rosterProof(SECRET);
      return send(withHash ? USERS : USERS.map((x) => { const c = { ...x }; delete c.pin_hash; return c; }));
    }
    if (action === 'houses') return send(HOUSES);
    if (action === 'requests') return send(REQUESTS);
    if (action === 'inspections') return send([{ id: 'INS-1' }]);
    return send([]);
  }
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
});

let gateway, base, _loginAttempts;

before(async () => {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  process.env.APPS_SCRIPT_EXEC_URL = `http://127.0.0.1:${upstream.address().port}/exec`;
  process.env.SESSION_SECRET = SECRET;
  process.env.APP_PIN = APP_PIN;
  process.env.SESSION_DAYS = '7';
  // Import AFTER env is set (server.js reads env at load).
  const mod = await import('../src/server.js');
  _loginAttempts = mod._loginAttempts;
  gateway = http.createServer(mod.requestHandler);
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${gateway.address().port}`;
});

after(async () => {
  await new Promise((r) => gateway.close(r));
  await new Promise((r) => upstream.close(r));
});

async function login(name, pin) {
  _loginAttempts.clear(); // isolate from the per-IP rate limit across tests
  const r = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, pin }),
  });
  return { status: r.status, body: await r.json() };
}
async function getData(action, token) {
  const r = await fetch(`${base}/api/data?action=${encodeURIComponent(action)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: r.status, body: r.status === 200 ? await r.json() : null };
}

// ---- tier A: personal passwords ----

test("רועי's password works for רועי and FAILS for אולגה, and vice versa", async () => {
  assert.equal((await login('רועי', 'roy-password')).status, 200);
  assert.equal((await login('רועי', 'olga-password')).status, 401);
  assert.equal((await login('אולגה', 'olga-password')).status, 200);
  assert.equal((await login('אולגה', 'roy-password')).status, 401);
});

test('the shared APP_PIN fails for רועי and for אולגה (tier-A must use their own password)', async () => {
  assert.equal((await login('רועי', APP_PIN)).status, 401);
  assert.equal((await login('אולגה', APP_PIN)).status, 401);
});

// ---- tier B: shared PIN ----

test('a coordinator + the shared PIN logs in, with role coordinator (no approve power)', async () => {
  const r = await login('שירה', APP_PIN);
  assert.equal(r.status, 200);
  assert.equal(r.body.role, 'coordinator');
  assert.ok(r.body.token);
});

test('a coordinator with the wrong PIN → 401', async () => {
  assert.equal((await login('שירה', 'nope')).status, 401);
});

// ---- סנדרה: no login ----

test('סנדרה (ceo, no password) cannot log in with any credential', async () => {
  assert.equal((await login('סנדרה', APP_PIN)).status, 401);
  assert.equal((await login('סנדרה', 'roy-password')).status, 401);
  assert.equal((await login('סנדרה', '')).status, 401);
});

// ---- scoped reads ----

test('a coordinator token reads ONLY their own house requests (server filters, others return none)', async () => {
  const token = (await login('שירה', APP_PIN)).body.token; // שירה → קיסריה עפרוני
  const { status, body } = await getData('requests', token);
  assert.equal(status, 200);
  const ids = body.data.map((r) => r.id);
  assert.deepEqual(ids, ['REQ-1']);                 // only קיסריה עפרוני
  assert.ok(!ids.includes('REQ-2'));                // רעננה is out of scope → filtered out
});

test('רמי (maintenance, sharon) reads only sharon houses; cannot read caesarea/north requests', async () => {
  const token = (await login('רמי', APP_PIN)).body.token;
  const { body } = await getData('requests', token);
  const ids = body.data.map((r) => r.id);
  assert.deepEqual(ids, ['REQ-2']);                 // רעננה (sharon) only
  assert.ok(!ids.includes('REQ-1'));                // קיסריה (caesarea) filtered
  assert.ok(!ids.includes('REQ-3'));                // ריהאב (caesarea) filtered
  assert.ok(!ids.includes('REQ-4'));                // שדה אליעזר (north) filtered
});

test('a manager reads ALL houses requests', async () => {
  const token = (await login('רועי', 'roy-password')).body.token;
  const { body } = await getData('requests', token);
  assert.deepEqual(body.data.map((r) => r.id).sort(), ['REQ-1', 'REQ-2', 'REQ-3', 'REQ-4']);
});

test('tier B is refused manager-only reads (inspections) → 403; a manager gets them', async () => {
  const coord = (await login('שירה', APP_PIN)).body.token;
  assert.equal((await getData('inspections', coord)).status, 403);
  const mgr = (await login('רועי', 'roy-password')).body.token;
  assert.equal((await getData('inspections', mgr)).status, 200);
});

test('the users read is manager-only and never exposes pin_hash', async () => {
  const coord = (await login('שירה', APP_PIN)).body.token;
  assert.equal((await getData('users', coord)).status, 403);
  const mgr = (await login('רועי', 'roy-password')).body.token;
  const { status, body } = await getData('users', mgr);
  assert.equal(status, 200);
  for (const u of body.data) assert.ok(!('pin_hash' in u), 'pin_hash must never reach the browser');
});
