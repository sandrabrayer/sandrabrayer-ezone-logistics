// test/server-auth.test.js — locks the auth gateway: login (rate-limited, timing-safe), the
// Bearer gate on the data proxy, and fail-closed startup (server refuses to start without secrets).
//
// Env is set BEFORE importing server.js because the module reads it at load time. APPS_SCRIPT_EXEC_URL
// points at an unroutable host so the proxy returns 502 (never 401) once the gate has passed — that
// 502 is how we prove the token was accepted.
process.env.APPS_SCRIPT_EXEC_URL = 'https://example.invalid/exec';
process.env.APP_PIN = '123456';
process.env.SESSION_SECRET = 'k'.repeat(32);
process.env.SESSION_DAYS = '7';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { signToken } from '../src/auth.js';

// server.js reads env at module-load time. Static ESM imports are hoisted and would run BEFORE the
// env assignments above, so import it dynamically here — after the env is in place.
const { requestHandler, _loginAttempts } = await import('../src/server.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const SECRET = 'k'.repeat(32);

let server, base;

before(async () => {
  server = createServer(requestHandler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
});

function get(path, headers) {
  return fetch(`${base}${path}`, { headers: headers || {} });
}
function postJson(path, body, headers) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: JSON.stringify(body),
  });
}

test('/api/health is open', async () => {
  const r = await get('/api/health');
  assert.equal(r.status, 200);
});

test('/api/data without a token → 401', async () => {
  const r = await get('/api/data?action=requests');
  assert.equal(r.status, 401);
});

test('/api/data with a garbage token → 401', async () => {
  const r = await get('/api/data?action=requests', { Authorization: 'Bearer nope.deadbeef' });
  assert.equal(r.status, 401);
});

test('login with the wrong PIN → 401', async () => {
  _loginAttempts.clear();
  const r = await postJson('/api/login', { name: 'רועי', pin: '000000' });
  assert.equal(r.status, 401);
});

test('a valid token passes the gate (upstream 502, never 401)', async () => {
  const token = signToken(SECRET, 7, { name: 'רועי', role: 'field_ops' });
  const r = await get('/api/data?action=requests', { Authorization: `Bearer ${token}` });
  assert.notEqual(r.status, 401);
  assert.equal(r.status, 502); // example.invalid is unroutable → proxy 502
});

test('a token forged with the wrong key → 401', async () => {
  const forged = signToken('w'.repeat(32), 7, { name: 'רועי', role: 'ops_manager' });
  const r = await get('/api/data?action=requests', { Authorization: `Bearer ${forged}` });
  assert.equal(r.status, 401);
});

test('a missing Authorization header on a write → 401 (no state change)', async () => {
  const r = await postJson('/api/action', { action: 'approve', payload: { id: 'X' } });
  assert.equal(r.status, 401);
});

test('login is rate-limited: the 9th attempt in the window → 429', async () => {
  _loginAttempts.clear();
  let last;
  for (let i = 0; i < 9; i++) {
    last = await postJson('/api/login', { name: 'רועי', pin: '000000' });
  }
  assert.equal(last.status, 429);
  // even the correct PIN is refused while limited
  const r = await postJson('/api/login', { name: 'רועי', pin: '123456' });
  assert.equal(r.status, 429);
  _loginAttempts.clear();
});

test('fail-closed startup: missing SESSION_SECRET → server refuses to start (non-zero exit)', () => {
  const entry = join(__dirname, '..', 'src', 'server.js');
  // Spawn with the OTHER required vars present but SESSION_SECRET absent. A fresh checkout has no
  // .env, so nothing repopulates it — the process must exit non-zero before binding a port.
  const env = {
    PATH: process.env.PATH,
    APPS_SCRIPT_EXEC_URL: 'https://example.invalid/exec',
    APP_PIN: '123456',
    SESSION_DAYS: '7',
    // SESSION_SECRET intentionally omitted
  };
  const r = spawnSync(process.execPath, [entry], { env, encoding: 'utf8', timeout: 10000 });
  assert.notEqual(r.status, 0, 'server should exit non-zero without SESSION_SECRET');
  assert.match(`${r.stderr}`, /SESSION_SECRET is required/);
});
