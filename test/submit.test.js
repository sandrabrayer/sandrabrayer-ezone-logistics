// test/submit.test.js — the PUBLIC (no-login) request submit endpoint (entry-flow redesign). Proves the
// ONE unauthenticated write works end-to-end through the real requestHandler against a mock Apps Script,
// that it validates strictly, that the server-to-server submitProof is forwarded (so /exec still can't be
// driven by just anyone), and — critically — that EVERY OTHER endpoint still fails closed without a token.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { submitProof } from '../src/auth.js';

const HOUSES = [{ name: 'רמות השבים', cluster: 'sharon' }, { name: 'קיסריה עפרוני', cluster: 'caesarea' }];
const SECRET = 'k'.repeat(32);

// Mock Apps Script upstream: serves the houses read (GET) and accepts createRequestPublic (POST). It
// records every POST body so a test can assert the forwarded action + proof, and enforces the same proof
// gate Code.gs does (a mismatched/absent proof → Unauthorized).
let posts = [];
const upstream = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'GET' && u.searchParams.get('action') === 'houses') {
    return res.end(JSON.stringify({ ok: true, data: HOUSES }));
  }
  if (req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch (e) { /* noop */ }
      posts.push(body);
      if (body.action !== 'createRequestPublic') return res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      if (String(body.proof || '') !== submitProof(SECRET)) return res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      return res.end(JSON.stringify({ ok: true, id: 'REQ-TEST-0001' }));
    });
    return;
  }
  res.end(JSON.stringify({ ok: false }));
});

let app, base, resetSubmit;
before(async () => {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  process.env.APPS_SCRIPT_EXEC_URL = `http://127.0.0.1:${upstream.address().port}/exec`;
  process.env.APP_PIN = '123456'; process.env.SESSION_SECRET = SECRET; process.env.SESSION_DAYS = '7';
  const mod = await import('../src/server.js');
  resetSubmit = () => mod._submitAttempts.clear();
  app = createServer(mod.requestHandler);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.address().port}`;
});
after(async () => { await new Promise((r) => app.close(r)); await new Promise((r) => upstream.close(r)); });
beforeEach(() => { posts = []; resetSubmit(); });

const submit = (payload) => fetch(`${base}/api/submit`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payload }),
});
const VALID = { created_by: 'שירה', house: 'קיסריה עפרוני', category: 'רכישה', urgency: 'רגיל', description: 'נייר טואלט', location_in_house: 'מחסן' };

test('unauthenticated submit works: a valid public request is created (no token needed)', async () => {
  const res = await submit(VALID);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.id, 'REQ-TEST-0001');
});

test('submit forwards createRequestPublic + the submitProof (so /exec is not world-writable)', async () => {
  await submit(VALID);
  assert.equal(posts.length, 1, 'exactly one upstream create');
  assert.equal(posts[0].action, 'createRequestPublic');
  assert.equal(posts[0].proof, submitProof(SECRET), 'the server-to-server proof must be forwarded');
  assert.equal(posts[0].token, undefined, 'no session token is involved in a public submit');
  assert.equal(posts[0].payload.created_by, 'שירה');
});

test('submit rejects an invalid category BEFORE any upstream call (strict validation)', async () => {
  const res = await submit({ ...VALID, category: 'לא-קיים' });
  assert.equal(res.status, 400);
  assert.equal(posts.length, 0, 'a rejected submit never reaches Apps Script');
});

test('submit rejects an unknown house (never an arbitrary/spoofed house)', async () => {
  const res = await submit({ ...VALID, house: 'בית-מזויף' });
  assert.equal(res.status, 400);
  assert.equal(posts.length, 0);
});

test('submit rejects a missing submitter and a missing urgency', async () => {
  const a = await submit({ ...VALID, created_by: '' });
  assert.equal(a.status, 400);
  const b = await submit({ ...VALID, urgency: '' });
  assert.equal(b.status, 400);
  assert.equal(posts.length, 0);
});

test('submit is rate-limited per IP (fail-closed against spam)', async () => {
  let last;
  for (let i = 0; i < 21; i++) last = await submit(VALID);
  assert.equal(last.status, 429, 'the 21st submit in the window is refused');
});

// ---- EVERY OTHER endpoint still fails closed without a token ----

test('the ONLY unauthenticated write is /api/submit — reads + other writes still require auth', async () => {
  // Reads: no token → 401.
  for (const action of ['requests', 'houses', 'users', 'config', 'pageData']) {
    const r = await fetch(`${base}/api/data?action=${action}`);
    assert.equal(r.status, 401, `GET /api/data?action=${action} must be 401 without a token`);
  }
  // Writes via the authenticated action proxy: no token → 401 (never reaches upstream).
  for (const action of ['createRequest', 'approve', 'assign', 'managementData', 'createEvent', 'deleteRequest']) {
    const r = await fetch(`${base}/api/action`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, payload: {} }),
    });
    assert.equal(r.status, 401, `POST /api/action ${action} must be 401 without a token`);
  }
});

test('the trusted createRequest cannot be smuggled through the public submit endpoint', async () => {
  // /api/submit ignores any `action` in the body — it always forwards createRequestPublic. A caller can
  // never use it to invoke a privileged action (it only ever appends a request-tier row).
  const res = await fetch(`${base}/api/submit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'approve', payload: VALID }),
  });
  assert.equal(res.status, 200);
  assert.equal(posts[0].action, 'createRequestPublic', 'submit always forwards createRequestPublic, never the client action');
});
