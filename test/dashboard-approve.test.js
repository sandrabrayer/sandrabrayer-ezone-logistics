// test/dashboard-approve.test.js — regression guard for the dashboard's approve / reject WRITE path
// through the REAL gateway, backed by a FAKE Apps Script upstream that RECORDS the forwarded POST.
//
// Why this exists: the dashboard cards' אישור / לא אושר buttons POST { action:'approve'|'reject', … }
// to window.__EXEC_URL__ (/api/exec); the injected auth shim rewrites that to POST /api/action with the
// session token as `Authorization: Bearer`. handleAction resolves the actor from the token (never the
// body) and forwards { action, payload, token } to Apps Script. A break anywhere on that chain makes the
// buttons "do nothing". These tests lock the whole chain end-to-end: a manager's approve/reject reaches
// upstream with the CORRECT forwarded token, and a tier-B role is refused BEFORE any upstream call.
//
// This mirrors the harness in staff-tiers.test.js (real requestHandler + a fake upstream on localhost).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { hashPin, rosterProof, verifyToken } from '../src/auth.js';

const SECRET = 'k'.repeat(40);
const APP_PIN = '555555';

const USERS = [
  { name: 'רועי',  role: 'field_ops',   house: '', active: 'TRUE', pin_hash: hashPin('roy-password') },
  { name: 'אולגה', role: 'ops_manager', house: '', active: 'TRUE', pin_hash: hashPin('olga-password') },
  { name: 'רמי',   role: 'maintenance', house: 'sharon', active: 'TRUE', pin_hash: '' },
];

// The fake upstream RECORDS every POST body so we can assert exactly what the gateway forwarded.
const forwarded = [];
const upstream = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (data) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, data })); };
  if (req.method === 'GET') {
    const action = u.searchParams.get('action');
    if (action === 'users') {
      const withHash = u.searchParams.get('auth') === rosterProof(SECRET);
      return send(withHash ? USERS : USERS.map((x) => { const c = { ...x }; delete c.pin_hash; return c; }));
    }
    return send([]);
  }
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch (e) { body = { _parseError: true }; }
    forwarded.push(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
});

let gateway, base, _loginAttempts;

before(async () => {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  process.env.APPS_SCRIPT_EXEC_URL = `http://127.0.0.1:${upstream.address().port}/exec`;
  process.env.SESSION_SECRET = SECRET;
  process.env.APP_PIN = APP_PIN;
  process.env.SESSION_DAYS = '7';
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
  _loginAttempts.clear();
  const r = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, pin }),
  });
  return (await r.json());
}
// Exactly how the injected shim issues a dashboard write: POST /api/action with Bearer + the body the
// page built ({ action, payload }). The body carries no real token — the actor comes from the header.
async function dashboardWrite(token, action, payload) {
  const r = await fetch(`${base}/api/action`, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'text/plain;charset=utf-8' }, token ? { Authorization: `Bearer ${token}` } : {}),
    body: JSON.stringify({ action, payload, token: '1' }), // '1' = the shim's non-secret placeholder
  });
  return { status: r.status };
}

test('dashboard APPROVE: a manager\'s אישור reaches Apps Script with the correct forwarded token', async () => {
  forwarded.length = 0;
  const { token } = await login('רועי', 'roy-password'); // field_ops
  const { status } = await dashboardWrite(token, 'approve', { id: 'REQ-1', by: 'רועי' });
  assert.equal(status, 200, 'the gateway forwards approve and returns the upstream 200');
  assert.equal(forwarded.length, 1, 'exactly one write reached Apps Script');
  const sent = forwarded[0];
  assert.equal(sent.action, 'approve');
  assert.deepEqual(sent.payload, { id: 'REQ-1', by: 'רועי' }, 'the payload is forwarded verbatim');
  // The forwarded token is the REAL session token (from the Bearer header), not the body placeholder —
  // Apps Script re-verifies it and resolves the actor from it.
  assert.notEqual(sent.token, '1', 'the placeholder body token is NOT what gets forwarded');
  const actor = verifyToken(SECRET, sent.token);
  assert.ok(actor, 'the forwarded token verifies against SESSION_SECRET');
  assert.equal(actor.role, 'field_ops', 'the forwarded token carries the real actor role');
  assert.equal(actor.name, 'רועי');
});

test('dashboard REJECT: a manager\'s לא אושר reaches Apps Script with the reason payload', async () => {
  forwarded.length = 0;
  const { token } = await login('אולגה', 'olga-password'); // ops_manager
  const { status } = await dashboardWrite(token, 'reject', { id: 'REQ-2', by: 'אולגה', reason: 'לא מאושר תקציבית' });
  assert.equal(status, 200);
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].action, 'reject');
  assert.equal(forwarded[0].payload.reason, 'לא מאושר תקציבית', 'the rejection reason is forwarded');
  assert.equal(verifyToken(SECRET, forwarded[0].token).role, 'ops_manager');
});

test('approve/reject WITHOUT a Bearer token → 401 and nothing reaches upstream', async () => {
  forwarded.length = 0;
  assert.equal((await dashboardWrite('', 'approve', { id: 'REQ-1' })).status, 401);
  assert.equal((await dashboardWrite('garbage.token', 'reject', { id: 'REQ-1' })).status, 401);
  assert.equal(forwarded.length, 0, 'an unauthenticated write never touches Apps Script');
});

test('tier-B (maintenance) is refused approve AND reject at the gateway (403), no upstream call', async () => {
  forwarded.length = 0;
  const { token } = await login('רמי', APP_PIN); // maintenance
  assert.equal((await dashboardWrite(token, 'approve', { id: 'REQ-1', by: 'רמי' })).status, 403);
  assert.equal((await dashboardWrite(token, 'reject', { id: 'REQ-1', by: 'רמי' })).status, 403);
  assert.equal(forwarded.length, 0, 'a refused write is blocked BEFORE any Apps Script call');
});
