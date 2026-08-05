// test/management-writes.test.js — the /management write actions added in PR B (readiness checklists +
// compliance delete) are EXEC-ONLY (ops_manager + ceo), enforced at the Node gateway BEFORE any upstream
// call — same posture as managementData. Real gateway + a fake Apps Script upstream that records forwards
// (mirrors staff-tiers.test.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { hashPin, rosterProof, verifyToken } from '../src/auth.js';

const SECRET = 'k'.repeat(40);
const APP_PIN = '555555';

const USERS = [
  { name: 'אולגה', role: 'ops_manager', house: '', active: 'TRUE', pin_hash: hashPin('olga-password') },
  { name: 'רועי',  role: 'field_ops',   house: '', active: 'TRUE', pin_hash: hashPin('roy-password') },
  { name: 'רמי',   role: 'maintenance', house: 'sharon', active: 'TRUE', pin_hash: '' },
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
  process.env.SESSION_SECRET = SECRET; process.env.APP_PIN = APP_PIN; process.env.SESSION_DAYS = '7';
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

const MANAGE_ONLY = ['addReadinessItem', 'updateReadinessItem', 'deleteReadinessItem', 'deleteCompliance'];

test('ops_manager: every management write is forwarded (200) with the real token', async () => {
  forwarded.length = 0;
  const { token } = await login('אולגה', 'olga-password');
  for (const act of MANAGE_ONLY) {
    const { status } = await action(token, act, { board: 'opening', house: 'h', item: 'i', id: 'X' });
    assert.equal(status, 200, `${act} must be forwarded for ops_manager`);
  }
  assert.equal(forwarded.length, MANAGE_ONLY.length);
  for (const f of forwarded) assert.equal(verifyToken(SECRET, f.token).role, 'ops_manager');
});

test('field_ops (manager tier for dispatch, NOT exec) is refused every management write → 403, no upstream', async () => {
  forwarded.length = 0;
  const { token } = await login('רועי', 'roy-password');
  for (const act of MANAGE_ONLY) {
    assert.equal((await action(token, act, { board: 'opening', id: 'X' })).status, 403, `${act} must be 403 for field_ops`);
  }
  assert.equal(forwarded.length, 0, 'a refused exec write never reaches Apps Script');
});

test('tier-B (maintenance) is refused every management write → 403', async () => {
  const { token } = await login('רמי', APP_PIN);
  for (const act of MANAGE_ONLY) {
    assert.equal((await action(token, act, { board: 'emergency', id: 'X' })).status, 403);
  }
});

test('unauthenticated management writes → 401, nothing forwarded', async () => {
  forwarded.length = 0;
  for (const act of MANAGE_ONLY) assert.equal((await action('', act, {})).status, 401);
  assert.equal(forwarded.length, 0);
});
