// test/server.test.js — locks the frontend HTTP layer: routing + env-URL injection.
//
// These tests start the real server on an ephemeral port (127.0.0.1:0) and make LOCAL requests
// only. Nothing here ever contacts the live Google Apps Script backend: the exec URL is a DUMMY,
// obviously-unroutable value, and the server's job is merely to INJECT it into the HTML (the
// browser would use it later) — it never fetches it. Proof: GET / still returns 200 instantly
// even though DUMMY_EXEC_URL points at a `.invalid` host that could never resolve.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createAppServer } from '../src/server.js';

// Dummy value — never a real deployment id, never a real secret. `.invalid` is reserved by RFC 2606
// and can never resolve, so if any code ever tried to actually call it, the test would hang/fail.
const DUMMY_EXEC_URL = 'https://script.google.example.invalid/macros/s/DUMMY_DEPLOY_ID/exec';

let server;
let base;

before(async () => {
  server = createAppServer({ execUrl: DUMMY_EXEC_URL });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  base = `http://127.0.0.1:${port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('GET / responds 200 with the request-form HTML', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const body = await res.text();
  assert.match(body, /<!DOCTYPE html>/i);
  assert.match(body, /EZone/); // the form page title/branding
});

test('GET /index.html serves the same form page', async () => {
  const res = await fetch(`${base}/index.html`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /<!DOCTYPE html>/i);
});

test('GET /dashboard responds 200 with the dashboard HTML', async () => {
  const res = await fetch(`${base}/dashboard`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const body = await res.text();
  assert.match(body, /<!DOCTYPE html>/i);
});

test('GET /dashboard.html serves the same dashboard page', async () => {
  const res = await fetch(`${base}/dashboard.html`);
  assert.equal(res.status, 200);
});

test('unknown routes respond 404 Not found', async () => {
  const res = await fetch(`${base}/does-not-exist`);
  assert.equal(res.status, 404);
  const body = await res.text();
  assert.equal(body, 'Not found');
});

test('the exec URL is injected into <head> as window.__EXEC_URL__', async () => {
  const res = await fetch(`${base}/`);
  const body = await res.text();
  // Injected exactly as JSON — this is what the browser reads to know where to POST.
  assert.ok(
    body.includes(`window.__EXEC_URL__=${JSON.stringify(DUMMY_EXEC_URL)}`),
    'expected injected window.__EXEC_URL__ script tag',
  );
  // Injected before </head> so it is defined before the page scripts run.
  assert.ok(body.indexOf('window.__EXEC_URL__') < body.indexOf('</head>'));
});

test('exec URL is JSON-encoded, not raw-concatenated (injection safety)', async () => {
  // A value with a quote must be safely escaped by JSON.stringify, not break out of the string.
  const tricky = 'https://x.invalid/"+alert(1)+"/exec';
  const s = createAppServer({ execUrl: tricky });
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = s.address();
    const res = await fetch(`http://127.0.0.1:${port}/`);
    const body = await res.text();
    assert.ok(body.includes(`window.__EXEC_URL__=${JSON.stringify(tricky)}`));
    assert.ok(!body.includes('"+alert(1)+"')); // the raw unescaped form must NOT appear
  } finally {
    await new Promise((resolve) => s.close(resolve));
  }
});

test('with no exec URL configured the server still serves pages (empty injection)', async () => {
  const s = createAppServer({ execUrl: '' });
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = s.address();
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes('window.__EXEC_URL__=""'));
  } finally {
    await new Promise((resolve) => s.close(resolve));
  }
});
