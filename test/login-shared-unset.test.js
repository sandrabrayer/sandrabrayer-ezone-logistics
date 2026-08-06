// test/login-shared-unset.test.js — fail-closed when SHARED_ACCESS_CODE is unset. The startup block
// (isMain) refuses to boot without it; this proves the RUNTIME path is also fail-closed — if the server
// somehow ran with an empty code, NO login succeeds (checkPin fails closed on an empty expected value).
// A separate module instance is imported with the code unset (import cache-busting query), isolated from
// the other suites' env.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const SECRET = 'k'.repeat(40);
const ROSTER = [{ name: 'רועי', role: 'field_ops', house: '', active: 'TRUE' }];

const upstream = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, data: u.searchParams.get('action') === 'users' ? ROSTER : [] }));
});

let gateway, base;

before(async () => {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  process.env.APPS_SCRIPT_EXEC_URL = `http://127.0.0.1:${upstream.address().port}/exec`;
  process.env.SESSION_SECRET = SECRET;
  process.env.SESSION_DAYS = '7';
  delete process.env.SHARED_ACCESS_CODE; // UNSET
  // Fresh module instance (query-string cache bust) so it reads the unset code at load.
  const mod = await import('../src/server.js?shared_unset=1');
  gateway = http.createServer(mod.requestHandler);
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${gateway.address().port}`;
});

after(async () => {
  await new Promise((r) => gateway.close(r));
  await new Promise((r) => upstream.close(r));
});

test('with SHARED_ACCESS_CODE unset, login fails closed for a valid roster user (any code → 401)', async () => {
  for (const code of ['', '2026', 'anything']) {
    const r = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'רועי', pin: code }),
    });
    assert.equal(r.status, 401, `unset shared code must reject login (tried "${code}")`);
    assert.ok(!(await r.json()).token, 'no token is ever issued when the shared code is unset');
  }
});
