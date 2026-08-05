// test/dashboard-actions.test.js — regression lock for the dashboard write path (approve / reject).
//
// Bug report: on the "ממתין לאישור" cards, אישור and לא אושר "do nothing". Investigation showed the
// Node gateway + client shim + deployed Apps Script all handle the write correctly in current main (the
// historical dead-button symptom was the #62 deploy-window 502 that blanked manager pages, fixed in #65).
// These tests lock the approve/reject POST end-to-end through the REAL gateway with a FAKE upstream, so
// the write path can never silently break again: the action reaches upstream, the actor's REAL verified
// token is forwarded (never the client-supplied body token), and the role gate is enforced.
//
// Mirrors the dashboard's actual post(): Content-Type text/plain, body { action, payload, token:'1' }.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { hashPin, rosterProof, signToken } from '../src/auth.js';

const SECRET = 'k'.repeat(40);
const APP_PIN = '555555';

const USERS = [
  { name: 'רועי',  role: 'field_ops',   house: '', active: 'TRUE', pin_hash: hashPin('roy-password') },
  { name: 'אולגה', role: 'ops_manager', house: '', active: 'TRUE', pin_hash: hashPin('olga-password') },
  { name: 'שירה',  role: 'coordinator', house: 'קיסריה עפרוני', active: 'TRUE', pin_hash: '' },
];

// Fake Apps Script upstream that RECORDS every write it receives, so we can assert what the gateway forwarded.
let posts = [];
const upstream = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const action = u.searchParams.get('action');
  const send = (data) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, data })); };
  if (req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = null; try { body = JSON.parse(raw); } catch (e) { /* record null */ }
      posts.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true })); // upstream approves — the gateway just proxies
    });
    return;
  }
  if (action === 'users') {
    const withHash = u.searchParams.get('auth') === rosterProof(SECRET);
    return send(withHash ? USERS : USERS.map((x) => { const c = { ...x }; delete c.pin_hash; return c; }));
  }
  return send([]);
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

// EXACTLY what src/dashboard.html post() sends: text/plain, and a body carrying a NON-token ('1') that
// the gateway must ignore in favor of the Bearer token (the shim sets window.__STAFF_TOKEN__ = '1').
async function dashboardPost(action, payload, token) {
  const r = await fetch(`${base}/api/action`, {
    method: 'POST',
    headers: Object.assign(
      { 'Content-Type': 'text/plain;charset=utf-8' },
      token ? { Authorization: `Bearer ${token}` } : {},
    ),
    body: JSON.stringify({ action, payload, token: '1' }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

test('approve POST from the dashboard reaches upstream with action=approve and the real token', async () => {
  posts = [];
  const token = (await login('רועי', 'roy-password')).token;
  const res = await dashboardPost('approve', { id: 'REQ-1', by: 'רועי' }, token);
  assert.equal(res.status, 200, 'gateway forwards the approve write');
  assert.equal(posts.length, 1, 'exactly one write reached upstream');
  assert.equal(posts[0].action, 'approve');
  assert.deepEqual(posts[0].payload, { id: 'REQ-1', by: 'רועי' });
  // The gateway substitutes the actor's VERIFIED token — never the client body's '1'.
  assert.notEqual(posts[0].token, '1', 'client body token must be replaced');
  assert.equal(posts[0].token, token, 'the forwarded token is the actor\'s real Bearer token');
});

test('reject POST from the dashboard reaches upstream with action=reject and the reason payload', async () => {
  posts = [];
  const token = (await login('רועי', 'roy-password')).token;
  const res = await dashboardPost('reject', { id: 'REQ-2', by: 'רועי', reason: 'לא נדרש' }, token);
  assert.equal(res.status, 200);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].action, 'reject');
  assert.deepEqual(posts[0].payload, { id: 'REQ-2', by: 'רועי', reason: 'לא נדרש' });
  assert.equal(posts[0].token, token);
});

test('ops_manager (Olga) can also approve/reject through the gateway', async () => {
  posts = [];
  const token = (await login('אולגה', 'olga-password')).token;
  assert.equal((await dashboardPost('approve', { id: 'REQ-3' }, token)).status, 200);
  assert.equal((await dashboardPost('reject', { id: 'REQ-3' }, token)).status, 200);
  assert.deepEqual(posts.map((p) => p.action), ['approve', 'reject']);
});

test('an unauthenticated approve is refused (401) and never reaches upstream', async () => {
  posts = [];
  const res = await dashboardPost('approve', { id: 'REQ-1' }, '');
  assert.equal(res.status, 401);
  assert.equal(posts.length, 0, 'no write is forwarded without a valid token');
});

test('a bad token approve is refused (401) and never reaches upstream', async () => {
  posts = [];
  const res = await dashboardPost('approve', { id: 'REQ-1' }, 'garbage.token');
  assert.equal(res.status, 401);
  assert.equal(posts.length, 0);
});

test('tier B (coordinator) is refused approve/reject at the gateway (403), no upstream write', async () => {
  posts = [];
  const token = (await login('שירה', APP_PIN)).token;
  assert.equal((await dashboardPost('approve', { id: 'REQ-1' }, token)).status, 403);
  assert.equal((await dashboardPost('reject', { id: 'REQ-1' }, token)).status, 403);
  assert.equal(posts.length, 0, 'a refused write never reaches upstream');
});
