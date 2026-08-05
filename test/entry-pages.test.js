// test/entry-pages.test.js — the split entry experience served over HTTP (entry-flow redesign):
//   • '/'  → the public landing with BOTH paths, ?v= cache-busting, and NO auth shim;
//   • '/request' → the public request form with houses + the submitter roster injected server-side (so the
//     page needs no unauthenticated READ endpoint) and NO auth shim; it posts to /api/submit;
//   • '/login' → the managers-login page WITH the auth shim, auto-opening the overlay (__FORCE_LOGIN__) with
//     the LIVE active roster injected as its dropdown (__LOGIN_NAMES__).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { rosterProof } from '../src/auth.js';

const SECRET = 'k'.repeat(32);
const HOUSES = [{ name: 'רמות השבים', cluster: 'sharon' }, { name: 'קיסריה עפרוני', cluster: 'caesarea' }];
const ROSTER = [
  { name: 'שירה', role: 'coordinator', house: 'קיסריה עפרוני', active: 'TRUE', pin_hash: '' },
  { name: 'אולגה', role: 'ops_manager', house: '', active: 'TRUE', pin_hash: 'secret-hash' },
  { name: 'ישן', role: 'coordinator', house: 'רעננה אשר', active: 'FALSE', pin_hash: '' }, // inactive → excluded
];

const upstream = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('Content-Type', 'application/json');
  const action = u.searchParams.get('action');
  if (action === 'houses') return res.end(JSON.stringify({ ok: true, data: HOUSES }));
  if (action === 'users') {
    const withHash = u.searchParams.get('auth') === rosterProof(SECRET);
    const data = ROSTER.map((r) => (withHash ? r : (({ pin_hash, ...rest }) => rest)(r)));
    return res.end(JSON.stringify({ ok: true, data }));
  }
  res.end(JSON.stringify({ ok: false }));
});

let app, base;
before(async () => {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  process.env.APPS_SCRIPT_EXEC_URL = `http://127.0.0.1:${upstream.address().port}/exec`;
  process.env.APP_PIN = '123456'; process.env.SESSION_SECRET = SECRET; process.env.SESSION_DAYS = '7';
  const mod = await import('../src/server.js');
  app = createServer(mod.requestHandler);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.address().port}`;
});
after(async () => { await new Promise((r) => app.close(r)); await new Promise((r) => upstream.close(r)); });

const getHtml = async (path) => { const r = await fetch(`${base}${path}`); return { status: r.status, ct: r.headers.get('content-type'), html: await r.text() }; };
const SHIM_MARK = "window.__EXEC_URL__='/api/exec'";

test('GET / serves the public landing with BOTH paths (cache-busted) and NO auth shim', async () => {
  const { status, ct, html } = await getHtml('/');
  assert.equal(status, 200);
  assert.match(ct, /text\/html/);
  assert.match(html, /href="\/request\?v=[^"]+"/, 'landing links to the request form with ?v=');
  assert.match(html, /href="\/login\?v=[^"]+"/, 'landing links to managers login with ?v=');
  assert.match(html, /טופס דרישה/);
  assert.match(html, /כניסת מנהלים/);
  assert.ok(!html.includes(SHIM_MARK), 'the public landing must NOT carry the auth shim');
  assert.ok(!html.includes('__ASSET_V__'), 'the version placeholder must be substituted');
});

test('GET /index.html also serves the landing (legacy path)', async () => {
  const { status, html } = await getHtml('/index.html');
  assert.equal(status, 200);
  assert.match(html, /כניסת מנהלים/);
});

test('GET /request injects houses + the active submitter roster, posts to /api/submit, and has NO shim', async () => {
  const { status, html } = await getHtml('/request');
  assert.equal(status, 200);
  assert.match(html, /window\.__PUBLIC_BOOT__=/, 'boot data is injected server-side');
  assert.match(html, /רמות השבים/);
  assert.match(html, /קיסריה עפרוני/);
  assert.match(html, /שירה/, 'an active submitter is injected');
  assert.ok(!html.includes('ישן'), 'an inactive user is not offered as a submitter');
  assert.match(html, /\/api\/submit/, 'the form posts to the public submit endpoint');
  assert.ok(!html.includes(SHIM_MARK), 'the public request form must NOT carry the auth shim');
});

test('GET /login carries the auth shim, auto-opens the overlay, and injects the LIVE roster dropdown', async () => {
  const { status, html } = await getHtml('/login');
  assert.equal(status, 200);
  assert.ok(html.includes(SHIM_MARK), 'the login page carries the auth shim');
  assert.match(html, /window\.__FORCE_LOGIN__=true/, 'the overlay auto-opens on /login');
  assert.match(html, /window\.__LOGIN_NAMES__=/, 'the roster dropdown is injected');
  assert.match(html, /שירה/);
  assert.match(html, /אולגה/);
  assert.ok(!html.includes('ישן'), 'an inactive user is not in the login dropdown');
  assert.ok(!html.includes('secret-hash'), 'a pin_hash is NEVER injected into the page');
});
