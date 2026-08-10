// test/server.test.js — locks the frontend gateway's HTTP contract: the HTML page routes, the 404
// behavior, and the safety of the injected data sentinel.
//
// This branch originally targeted the pre-auth server (a `createAppServer({execUrl})` factory that
// injected the raw Apps Script exec URL as window.__EXEC_URL__). Since then, `main` replaced that with
// the Increment-30 auth gateway: pages no longer receive the raw backend URL at all — the injected
// sentinel points at the same-origin, Bearer-gated proxy `/api/exec`, and the real exec URL stays a
// server-side secret. The test below was re-pointed at that gateway (via the exported `requestHandler`)
// so it locks the routes and the injection *as they actually ship* — and asserts the security property
// the original test cared about: the raw backend URL never appears in page source.
//
// Runs the real requestHandler on an ephemeral port (127.0.0.1:0), fully offline: no subprocess, no
// fixed port, and never a call to the live Apps Script backend (the login roster falls back to the
// built-in default names when the backend is unreachable, so page rendering needs no network).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { requestHandler } from '../src/server.js';

let server;
let base;

before(async () => {
  server = createServer(requestHandler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('GET / responds 200 with the request-form HTML', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const body = await res.text();
  assert.match(body, /<!DOCTYPE html>/i);
  assert.match(body, /EZone/); // the page title/branding
});

test('GET /index.html serves the same form page', async () => {
  const res = await fetch(`${base}/index.html`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
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
  assert.match(res.headers.get('content-type'), /text\/html/);
});

test('unknown routes respond 404 Not found', async () => {
  const res = await fetch(`${base}/does-not-exist`);
  assert.equal(res.status, 404);
  const body = await res.text();
  assert.equal(body, 'Not found');
});

test('the data sentinel is injected into <head>, before the page scripts run', async () => {
  const res = await fetch(`${base}/`);
  const body = await res.text();
  // The gateway injects a same-origin sentinel that page scripts read to know where to POST.
  assert.ok(
    body.includes("window.__EXEC_URL__='/api/exec'"),
    'expected the injected window.__EXEC_URL__ sentinel',
  );
  // Injected before </head> so it is defined before the page's own scripts run.
  assert.ok(body.indexOf('window.__EXEC_URL__') < body.indexOf('</head>'));
});

test('the RAW Apps Script backend URL is never injected into page source (injection/secret safety)', async () => {
  // The security property this file guards: pages talk to the Bearer-gated `/api/exec` proxy, so the
  // real Google exec URL must NOT leak into the HTML the browser receives. A regression that reverted
  // to injecting the raw exec URL (the pre-auth behavior) would surface one of these markers.
  for (const path of ['/', '/index.html', '/dashboard', '/dashboard.html']) {
    const body = await (await fetch(`${base}${path}`)).text();
    assert.ok(body.includes("window.__EXEC_URL__='/api/exec'"), `${path}: sentinel must be the proxy path`);
    assert.ok(!/script\.google\.com/.test(body), `${path}: raw Apps Script host leaked into page source`);
    assert.ok(!/macros\/s\/[^/]+\/exec/.test(body), `${path}: raw /macros/s/.../exec deployment URL leaked`);
  }
});
