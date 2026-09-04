// test/staff-tiers.test.js — end-to-end ROLE + SCOPE enforcement through the real gateway, backed by a
// FAKE Apps Script upstream. Tokens are minted directly (signToken) so these assert the token's role/scope
// gating independent of the login mechanism (the single-login contract lives in login-single.test.js).
// Covers: house/cluster read filtering, unknown-role fail-closed, one-token-everywhere, exec-only writes,
// events gating, manager-only reads, and pin_hash never reaching the browser.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { signToken } from '../src/auth.js';

const SECRET = 'k'.repeat(40);
const CODE = '2026';

// --- fake Apps Script upstream --- (pin_hash included so we can prove the NODE proxy strips it on read)
const USERS = [
  { name: 'רועי',  role: 'field_ops',   house: '',             active: 'TRUE', pin_hash: 'pbkdf2$sha256$1$aa$bb' },
  { name: 'אולגה', role: 'ops_manager', house: '',             active: 'TRUE', pin_hash: 'pbkdf2$sha256$1$aa$bb' },
  { name: 'רמי',   role: 'maintenance', house: 'sharon',       active: 'TRUE', pin_hash: '' },
  { name: 'שירה',  role: 'coordinator', house: 'קיסריה עפרוני', active: 'TRUE', pin_hash: '' },
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
    if (action === 'users') return send(USERS);
    if (action === 'houses') return send(HOUSES);
    if (action === 'requests') return send(REQUESTS);
    if (action === 'inspections') return send([{ id: 'INS-1' }]);
    return send([]);
  }
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
});

let gateway, base, _resetNodeCache;
const roleOf = (name) => USERS.find((u) => u.name === name).role;
const scopeOf = (name) => String(USERS.find((u) => u.name === name).house || '');
const tok = (name) => signToken(SECRET, 7, { name, role: roleOf(name), scope: scopeOf(name) });

before(async () => {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  process.env.APPS_SCRIPT_EXEC_URL = `http://127.0.0.1:${upstream.address().port}/exec`;
  process.env.SESSION_SECRET = SECRET;
  process.env.SHARED_ACCESS_CODE = CODE;
  process.env.SESSION_DAYS = '7';
  const mod = await import('../src/server.js');
  _resetNodeCache = mod._resetNodeCache;
  gateway = http.createServer(mod.requestHandler);
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${gateway.address().port}`;
});

after(async () => {
  await new Promise((r) => gateway.close(r));
  await new Promise((r) => upstream.close(r));
});

async function getData(action, token) {
  _resetNodeCache && _resetNodeCache();
  const r = await fetch(`${base}/api/data?action=${encodeURIComponent(action)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: r.status, body: r.status === 200 ? await r.json() : null };
}
async function postAction(action, token, payload) {
  const r = await fetch(`${base}/api/action`, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: `Bearer ${token}` } : {}),
    body: JSON.stringify({ action, payload: payload || {} }),
  });
  return { status: r.status };
}

// ---- scoped reads ----

test('a coordinator token reads ONLY their own house requests (server filters, others return none)', async () => {
  const { status, body } = await getData('requests', tok('שירה')); // שירה → קיסריה עפרוני
  assert.equal(status, 200);
  const ids = body.data.map((r) => r.id);
  assert.deepEqual(ids, ['REQ-1']);
  assert.ok(!ids.includes('REQ-2'));
});

test('רמי (maintenance, sharon) reads only sharon houses; cannot read caesarea/north requests', async () => {
  const { body } = await getData('requests', tok('רמי'));
  const ids = body.data.map((r) => r.id);
  assert.deepEqual(ids, ['REQ-2']);
  assert.ok(!ids.includes('REQ-1') && !ids.includes('REQ-3') && !ids.includes('REQ-4'));
});

test('a manager reads ALL houses requests', async () => {
  const { body } = await getData('requests', tok('רועי'));
  assert.deepEqual(body.data.map((r) => r.id).sort(), ['REQ-1', 'REQ-2', 'REQ-3', 'REQ-4']);
});

test('BOTH manager tiers (field_ops AND ops_manager) read all houses', async () => {
  for (const name of ['רועי', 'אולגה']) {
    const { status, body } = await getData('requests', tok(name));
    assert.equal(status, 200);
    assert.deepEqual(body.data.map((x) => x.id).sort(), ['REQ-1', 'REQ-2', 'REQ-3', 'REQ-4'], `${name} sees all houses`);
  }
});

test('unauthenticated read of scoped data is rejected (401), never served', async () => {
  assert.equal((await getData('requests')).status, 401);
  assert.equal((await getData('requests', 'garbage.token')).status, 401);
});

test('an authenticated session with an UNKNOWN role fails CLOSED (403), not a silent empty list', async () => {
  const ghost = signToken(SECRET, 7, { name: 'שד', role: 'ghost', scope: '' });
  assert.equal((await getData('requests', ghost)).status, 403);
});

test('one token is accepted across ALL page endpoints (GET /api/data AND POST /api/action)', async () => {
  const token = tok('אולגה'); // ops_manager
  assert.equal((await getData('requests', token)).status, 200);
  assert.equal((await getData('houses', token)).status, 200);
  assert.equal((await getData('inspections', token)).status, 200);   // manager-only read
  assert.equal((await postAction('managementData', token)).status, 200); // exec POST endpoint
});

test('the /management data (incl. budget) is exec-only: field_ops / coordinator / maintenance → 403', async () => {
  assert.equal((await postAction('managementData', tok('רועי'))).status, 403);   // field_ops
  assert.equal((await postAction('managementData', tok('שירה'))).status, 403);   // coordinator
  assert.equal((await postAction('managementData', tok('רמי'))).status, 403);    // maintenance
});

test('exceptional events: reporting is closed to maintenance; editing is exec-only (server-side 403)', async () => {
  const roy = tok('רועי'), olga = tok('אולגה'), coord = tok('שירה'), maint = tok('רמי');
  // createEvent: refused for BOTH tier-B roles at the gateway (coordinators are no longer Logistics
  // users; maintenance never reported events); managers are forwarded (fake upstream → 200).
  assert.equal((await postAction('createEvent', maint)).status, 403);
  assert.equal((await postAction('createEvent', coord)).status, 403);
  assert.equal((await postAction('createEvent', roy)).status, 200);
  assert.equal((await postAction('createEvent', olga)).status, 200);
  // updateEvent (edit/close): exec-only.
  assert.equal((await postAction('updateEvent', roy)).status, 403);
  assert.equal((await postAction('updateEvent', coord)).status, 403);
  assert.equal((await postAction('updateEvent', maint)).status, 403);
  assert.equal((await postAction('updateEvent', olga)).status, 200);
  // events LIST read is manager-tier.
  assert.equal((await getData('events', coord)).status, 403);
  assert.equal((await getData('events', olga)).status, 200);
});

test('tier B is refused manager-only reads (inspections) → 403; a manager gets them', async () => {
  assert.equal((await getData('inspections', tok('שירה'))).status, 403);
  assert.equal((await getData('inspections', tok('רועי'))).status, 200);
});

test('the users read is manager-only and never exposes pin_hash', async () => {
  assert.equal((await getData('users', tok('שירה'))).status, 403);
  const { status, body } = await getData('users', tok('רועי'));
  assert.equal(status, 200);
  for (const u of body.data) assert.ok(!('pin_hash' in u), 'pin_hash must never reach the browser');
});
