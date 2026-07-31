// test/server-static.test.js — locks the static-asset routes' on-the-wire HTTP behavior.
// The point is the Content-Type: an icon served as anything but image/png renders as a blank box,
// so these assertions are the regression guard for that class of bug. Runs the real requestHandler
// on an ephemeral port (no subprocess, no fixed port).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { requestHandler } from '../src/server.js';

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

test('served pages persist the session across pages/tabs (bug fix): shim uses localStorage', async () => {
  // The injected auth shim must persist the token so ONE login carries across every page/tab until
  // expiry — otherwise navigating re-prompts (the reported bug). Guard the persistence code is present
  // on every HTML route (browser code can't be unit-run here, so we assert it is served).
  for (const path of ['/', '/dashboard', '/workorders', '/management']) {
    const html = await (await fetch(`${base}${path}`)).text();
    assert.match(html, /localStorage/, `${path} shim must use localStorage`);
    assert.match(html, /ezone_session/, `${path} shim must key the persisted session`);
    assert.match(html, /saveSession\(/, `${path} shim must save the session on login`);
    assert.match(html, /loadSession\(\)/, `${path} shim must rehydrate the session on load`);
    assert.match(html, /exp>Date\.now\(\)/, `${path} shim must honor an expiry`);
  }
});
