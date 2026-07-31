// test/server-static.test.js — locks the static-asset routes' on-the-wire HTTP behavior.
// The point is the Content-Type: an icon served as anything but image/png renders as a blank box,
// so these assertions are the regression guard for that class of bug. Runs the real requestHandler
// on an ephemeral port (no subprocess, no fixed port).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { requestHandler, _HTML_ROUTES } from '../src/server.js';

let server, base;

before(async () => {
  server = createServer(requestHandler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('GET /icons/*.png serves 200 image/png with real PNG bytes', async () => {
  const res = await fetch(`${base}/icons/icon-192-v1.png`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.ok(buf.length > 0, 'empty body');
  // PNG magic number — proves it's a real image, not a text/document body.
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});

test('GET /favicon.ico serves the 32px PNG as image/png (no 404)', async () => {
  const res = await fetch(`${base}/favicon.ico`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
});

test('GET /manifest.webmanifest serves application/manifest+json', async () => {
  const res = await fetch(`${base}/manifest.webmanifest`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/manifest\+json/);
});

test('GET / serves HTML with Cache-Control: no-cache (revalidate, avoid stale pages across deploys)', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.equal(res.headers.get('cache-control'), 'no-cache');
});

test('icon route returns 404 for disallowed names and missing files (no leak, no traversal)', async () => {
  assert.equal((await fetch(`${base}/icons/nope.txt`)).status, 404);          // extension not allowed
  assert.equal((await fetch(`${base}/icons/does-not-exist-v9.png`)).status, 404); // valid name, missing file
});

test('EVERY served HTML route carries the persisted-session auth shim, before its page scripts', async () => {
  // Enumerate every route the server actually serves (not a hand-kept list) so a NEW page added to
  // HTML_ROUTES that somehow doesn't get the shim injected (e.g. no </head>) fails loudly here. Each
  // page must load the shim IN <head> (before its own body scripts) and carry the localStorage
  // persistence — the class of bug where a page re-prompted for login because it ran a stale/absent shim.
  const routes = Object.keys(_HTML_ROUTES);
  assert.ok(routes.length >= 7, 'expected all app routes (index/dashboard/inspection/inventory/reports/workorders/management)');
  for (const path of routes) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 200, `${path} must serve 200`);
    assert.match(res.headers.get('content-type'), /text\/html/, `${path} must be HTML`);
    const html = await res.text();
    const headEnd = html.indexOf('</head>');
    const shimAt = html.indexOf("window.__EXEC_URL__='/api/exec'");
    assert.ok(headEnd !== -1, `${path} must have a </head> (the shim injection point)`);
    assert.ok(shimAt !== -1, `${path} is MISSING the auth shim`);
    assert.ok(shimAt < headEnd, `${path} shim must load in <head>, before page scripts`);
    // The shim must be the persisted-session one (survives navigation), not the old in-memory-only shim.
    for (const needle of ['localStorage', 'ezone_session', 'saveSession(', 'loadSession()', 'exp>Date.now()']) {
      assert.ok(html.includes(needle), `${path} shim missing persistence: ${needle}`);
    }
    // The page routes its data calls through the shimmed sentinel (so the Bearer token is attached).
    assert.ok(html.includes('__EXEC_URL__'), `${path} must call data through window.__EXEC_URL__`);
  }
});
