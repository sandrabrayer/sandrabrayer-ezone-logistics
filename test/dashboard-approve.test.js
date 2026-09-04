// test/dashboard-approve.test.js — regression guard for the dashboard's approve / reject WRITE path
// through the REAL gateway, backed by a FAKE Apps Script upstream that RECORDS the forwarded POST.
//
// Why this exists: the dashboard cards' אישור / לא אושר buttons POST { action:'approve'|'reject', … }
// to window.__EXEC_URL__ (/api/exec); the injected auth shim rewrites that to POST /api/action with the
// session token as `Authorization: Bearer`. handleAction resolves the actor from the token (never the
// body) and forwards { action, payload, token } to Apps Script. A break anywhere on that chain makes the
// buttons "do nothing". These tests lock the whole chain end-to-end: the single-login session's approve /
// reject (with the approver code — the gate itself is locked in approver-code.test.js) reaches upstream with
// the CORRECT forwarded token, and a tier-B role is refused BEFORE any upstream call.
//
// This mirrors the harness in staff-tiers.test.js (real requestHandler + a fake upstream on localhost).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { verifyToken, signToken } from '../src/auth.js';

const SECRET = 'k'.repeat(40);
const CODE = '2026';        // the ONE login password
const APPROVER = 'olga-77'; // APPROVER_CODE

// The requests the fake upstream serves (Node looks a code-less approve/reject up here for the emergency rule).
const REQUESTS = [{ id: 'REQ-1', urgency: 'רגיל', status: 'דרישה' }, { id: 'REQ-2', urgency: 'רגיל', status: 'דרישה' }];

// The fake upstream RECORDS every POST body so we can assert exactly what the gateway forwarded.
const forwarded = [];
const upstream = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (data) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, data })); };
  if (req.method === 'GET') {
    return send(u.searchParams.get('action') === 'requests' ? REQUESTS : []);
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
  process.env.SHARED_ACCESS_CODE = CODE;
  process.env.APPROVER_CODE = APPROVER;
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

async function login(pin) {
  _loginAttempts.clear();
  const r = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
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

test('dashboard APPROVE: אישור (with the approver code) reaches Apps Script with the correct forwarded token', async () => {
  forwarded.length = 0;
  const { token } = await login(CODE); // the ONE session (רועי / ops_manager)
  const { status } = await dashboardWrite(token, 'approve', { id: 'REQ-1', approver_code: APPROVER });
  assert.equal(status, 200, 'the gateway forwards approve and returns the upstream 200');
  assert.equal(forwarded.length, 1, 'exactly one write reached Apps Script');
  const sent = forwarded[0];
  assert.equal(sent.action, 'approve');
  assert.deepEqual(sent.payload, { id: 'REQ-1', approver_code: APPROVER }, 'forwarded with the verified code and no user field');
  // The forwarded token is the REAL session token (from the Bearer header), not the body placeholder —
  // Apps Script re-verifies it and resolves the actor from it.
  assert.notEqual(sent.token, '1', 'the placeholder body token is NOT what gets forwarded');
  const actor = verifyToken(SECRET, sent.token);
  assert.ok(actor, 'the forwarded token verifies against SESSION_SECRET');
  assert.equal(actor.role, 'ops_manager', 'the forwarded token carries the single-login role');
  assert.equal(actor.name, 'רועי');
});

test('dashboard REJECT: לא אושר (with the approver code) reaches Apps Script with the reason payload', async () => {
  forwarded.length = 0;
  const { token } = await login(CODE);
  const { status } = await dashboardWrite(token, 'reject', { id: 'REQ-2', reason: 'לא מאושר תקציבית', approver_code: APPROVER });
  assert.equal(status, 200);
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].action, 'reject');
  assert.equal(forwarded[0].payload.reason, 'לא מאושר תקציבית', 'the rejection reason is forwarded');
  assert.equal(verifyToken(SECRET, forwarded[0].token).role, 'ops_manager');
});

test('dashboard APPROVE without the approver code on a normal request → 403, nothing reaches upstream', async () => {
  forwarded.length = 0;
  const { token } = await login(CODE);
  assert.equal((await dashboardWrite(token, 'approve', { id: 'REQ-1' })).status, 403);
  assert.equal(forwarded.length, 0, 'the code gate refuses before any Apps Script call');
});

test('approve/reject WITHOUT a Bearer token → 401 and nothing reaches upstream', async () => {
  forwarded.length = 0;
  assert.equal((await dashboardWrite('', 'approve', { id: 'REQ-1' })).status, 401);
  assert.equal((await dashboardWrite('garbage.token', 'reject', { id: 'REQ-1' })).status, 401);
  assert.equal(forwarded.length, 0, 'an unauthenticated write never touches Apps Script');
});

test('tier-B (maintenance) is refused approve AND reject at the gateway (403), no upstream call', async () => {
  forwarded.length = 0;
  const token = signToken(SECRET, 7, { name: 'רמי', role: 'maintenance', scope: 'sharon' }); // maintenance can't log in; mint to test the gate
  assert.equal((await dashboardWrite(token, 'approve', { id: 'REQ-1', approver_code: APPROVER })).status, 403);
  assert.equal((await dashboardWrite(token, 'reject', { id: 'REQ-1', approver_code: APPROVER })).status, 403);
  assert.equal(forwarded.length, 0, 'a refused write is blocked BEFORE any Apps Script call');
});
