// test/management-writes.test.js — the write-action role gates at the Node gateway after the hub redesign.
// Real gateway + a fake Apps Script upstream that records forwards (mirrors staff-tiers.test.js). Tiers:
//   • EXEC-ONLY (ops_manager): deleteCompliance, deleteTraining.
//   • MANAGER-TIER (field_ops + ops_manager): addReadinessItem / updateReadinessItem / deleteReadinessItem.
//   • LEADS + managers: updatePreventiveItem (maintenance may write; coordinator may not).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { hashPin, rosterProof, verifyToken, signToken } from '../src/auth.js';

const SECRET = 'k'.repeat(40);
const APP_PIN = '555555';
const CODE = '2026'; // shared access code

const USERS = [
  { name: 'אולגה', role: 'ops_manager', house: '', active: 'TRUE', pin_hash: hashPin('olga-password') },
  { name: 'רועי',  role: 'field_ops',   house: '', active: 'TRUE', pin_hash: hashPin('roy-password') },
  { name: 'רמי',   role: 'maintenance', house: 'sharon', active: 'TRUE', pin_hash: '' },
  { name: 'שירה',  role: 'coordinator', house: 'קיסריה עפרוני', active: 'TRUE', pin_hash: '' },
];

const forwarded = [];
const upstream = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'GET') {
    const send = (data) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, data })); };
    if (u.searchParams.get('action') === 'users') {
      const withHash = u.searchParams.get('auth') === rosterProof(SECRET);
      return send(withHash ? USERS : USERS.map((x) => { const c = { ...x }; delete c.pin_hash; return c; }));
    }
    return send([]);
  }
  let raw = ''; req.on('data', (c) => { raw += c; });
  req.on('end', () => { forwarded.push(JSON.parse(raw || '{}')); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); });
});

let gateway, base, _loginAttempts;
before(async () => {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  process.env.APPS_SCRIPT_EXEC_URL = `http://127.0.0.1:${upstream.address().port}/exec`;
  process.env.SESSION_SECRET = SECRET; process.env.SHARED_ACCESS_CODE = CODE; process.env.SESSION_DAYS = '7';
  const mod = await import('../src/server.js');
  _loginAttempts = mod._loginAttempts;
  gateway = http.createServer(mod.requestHandler);
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${gateway.address().port}`;
});
after(async () => { await new Promise((r) => gateway.close(r)); await new Promise((r) => upstream.close(r)); });

async function login(name, pin) {
  _loginAttempts.clear();
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, pin }) });
  return (await r.json());
}
async function action(token, act, payload) {
  const r = await fetch(`${base}/api/action`, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: `Bearer ${token}` } : {}),
    body: JSON.stringify({ action: act, payload: payload || {} }),
  });
  return { status: r.status };
}

const EXEC_ONLY = ['deleteCompliance', 'deleteTraining'];
const READINESS = ['addReadinessItem', 'updateReadinessItem', 'deleteReadinessItem'];

test('EXEC-ONLY writes: ops_manager forwarded (200) with real token; field_ops & tier-B → 403, nothing forwarded', async () => {
  forwarded.length = 0;
  const olga = (await login('אולגה', CODE)).token;
  for (const act of EXEC_ONLY) assert.equal((await action(olga, act, { id: 'X' })).status, 200, `${act} ops_manager`);
  for (const f of forwarded) assert.equal(verifyToken(SECRET, f.token).role, 'ops_manager');
  forwarded.length = 0;
  const roy = signToken(SECRET, 7, { name: 'רועי', role: 'field_ops', scope: '' }); // field_ops — NOT an exec (minted: the single login issues ops_manager)
  const rami = signToken(SECRET, 7, { name: 'רמי', role: 'maintenance', scope: 'sharon' });             // maintenance
  for (const act of EXEC_ONLY) {
    assert.equal((await action(roy, act, { id: 'X' })).status, 403, `${act} field_ops must be 403`);
    assert.equal((await action(rami, act, { id: 'X' })).status, 403, `${act} maintenance must be 403`);
  }
  assert.equal(forwarded.length, 0, 'a refused exec write never reaches Apps Script');
});

test('MANAGER-TIER readiness writes: field_ops IS allowed (forwarded); coordinator & maintenance → 403', async () => {
  forwarded.length = 0;
  const roy = (await login('רועי', CODE)).token;      // field_ops = manager tier
  for (const act of READINESS) assert.equal((await action(roy, act, { board: 'opening', id: 'X', house: 'h', item: 'i' })).status, 200, `${act} field_ops`);
  assert.equal(forwarded.length, READINESS.length, 'field_ops readiness writes reach Apps Script');
  forwarded.length = 0;
  const coord = signToken(SECRET, 7, { name: 'שירה', role: 'coordinator', scope: 'קיסריה עפרוני' }); // coordinators can't log in; mint to test the gate
  const rami = signToken(SECRET, 7, { name: 'רמי', role: 'maintenance', scope: 'sharon' });             // maintenance
  for (const act of READINESS) {
    assert.equal((await action(coord, act, { board: 'opening', id: 'X' })).status, 403, `${act} coordinator must be 403`);
    assert.equal((await action(rami, act, { board: 'opening', id: 'X' })).status, 403, `${act} maintenance must be 403`);
  }
  assert.equal(forwarded.length, 0);
});

test('updatePreventiveItem: maintenance AND managers may write; coordinator → 403', async () => {
  forwarded.length = 0;
  const rami = signToken(SECRET, 7, { name: 'רמי', role: 'maintenance', scope: 'sharon' });             // maintenance lead
  const roy = (await login('רועי', CODE)).token;      // manager
  assert.equal((await action(rami, 'updatePreventiveItem', { house: 'רמות השבים', item: 'מים', done: true })).status, 200, 'maintenance may write daily');
  assert.equal((await action(roy, 'updatePreventiveItem', { house: 'רמות השבים', item: 'מים', done: true })).status, 200, 'manager may write daily');
  const coord = signToken(SECRET, 7, { name: 'שירה', role: 'coordinator', scope: 'קיסריה עפרוני' });
  assert.equal((await action(coord, 'updatePreventiveItem', { house: 'x', item: 'מים', done: true })).status, 403, 'coordinator may NOT write daily');
});

test('all management writes require a Bearer token → 401 when unauthenticated', async () => {
  forwarded.length = 0;
  for (const act of EXEC_ONLY.concat(READINESS, ['updatePreventiveItem'])) assert.equal((await action('', act, {})).status, 401);
  assert.equal(forwarded.length, 0);
});
