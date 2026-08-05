// test/compliance-gateway.test.js — the Node gateway's role gate for the PR B `deleteCompliance` write.
// Deleting a compliance (עמידה באמות מידה) entry is exec-only (ops_manager + ceo). This asserts the
// SERVER-SIDE gate (src/server.js) independently of Code.gs: managers are forwarded to upstream with the
// real token; field_ops and tier B are 403'd at the gateway with NO upstream write; unauth is 401.
// (The Code.gs canManage gate + audit-logged deletion are covered in management-handler.test.js.)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { hashPin, rosterProof } from '../src/auth.js';

const SECRET = 'k'.repeat(40);
const APP_PIN = '555555';

const USERS = [
  { name: 'רועי',  role: 'field_ops',   house: '', active: 'TRUE', pin_hash: hashPin('roy-password') },
  { name: 'אולגה', role: 'ops_manager', house: '', active: 'TRUE', pin_hash: hashPin('olga-password') },
  { name: 'שירה',  role: 'coordinator', house: 'קיסריה עפרוני', active: 'TRUE', pin_hash: '' },
  { name: 'רמי',   role: 'maintenance', house: 'sharon', active: 'TRUE', pin_hash: '' },
];

let posts = [];
const upstream = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const action = u.searchParams.get('action');
  const send = (data) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, data })); };
  if (req.method === 'POST') {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => { try { posts.push(JSON.parse(raw)); } catch (e) { posts.push(null); }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, id: 'C1' })); });
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
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, pin }),
  });
  return (await r.json());
}
async function del(id, token) {
  const r = await fetch(`${base}/api/action`, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'text/plain;charset=utf-8' }, token ? { Authorization: `Bearer ${token}` } : {}),
    body: JSON.stringify({ action: 'deleteCompliance', payload: { id }, token: '1' }),
  });
  return { status: r.status };
}

test('deleteCompliance: ops_manager is forwarded to upstream with the real token', async () => {
  posts = [];
  const token = (await login('אולגה', 'olga-password')).token;
  assert.equal((await del('C1', token)).status, 200);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].action, 'deleteCompliance');
  assert.equal(posts[0].token, token, 'the actor\'s real token is forwarded, not the body placeholder');
});

test('deleteCompliance: field_ops is refused at the gateway (403) — exec-only, no upstream write', async () => {
  posts = [];
  const token = (await login('רועי', 'roy-password')).token; // field_ops = manager tier elsewhere, NOT here
  assert.equal((await del('C1', token)).status, 403);
  assert.equal(posts.length, 0);
});

test('deleteCompliance: tier B (coordinator, maintenance) is refused at the gateway (403), no upstream write', async () => {
  posts = [];
  assert.equal((await del('C1', (await login('שירה', APP_PIN)).token)).status, 403);
  assert.equal((await del('C1', (await login('רמי', APP_PIN)).token)).status, 403);
  assert.equal(posts.length, 0);
});

test('deleteCompliance: unauthenticated → 401, never reaches upstream', async () => {
  posts = [];
  assert.equal((await del('C1', '')).status, 401);
  assert.equal(posts.length, 0);
});
