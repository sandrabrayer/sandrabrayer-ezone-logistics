// test/access-server.test.js — the role-based data gate at the HTTP layer (src/server.js). Signs a real
// token per role and drives /api/data + /api/action through the actual requestHandler. The upstream
// (APPS_SCRIPT_EXEC_URL) is unroutable, so a request that PASSES the gate returns 502 while a request
// the role may not perform returns 403 BEFORE any upstream call — that 403-vs-502 split proves the gate.
process.env.APPS_SCRIPT_EXEC_URL = 'https://example.invalid/exec';
process.env.APP_PIN = '123456';
process.env.SESSION_SECRET = 'k'.repeat(32);
process.env.SESSION_DAYS = '7';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { signToken } from '../src/auth.js';

const { requestHandler } = await import('../src/server.js');
const SECRET = 'k'.repeat(32);

let server, base;
before(async () => {
  server = createServer(requestHandler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((r) => server.close(r)); });

const tok = (role) => signToken(SECRET, 7, { name: role, role, scope: role === 'coordinator' ? 'רמות השבים' : '' });
const getData = (action, role) => fetch(`${base}/api/data?action=${action}`, { headers: { Authorization: `Bearer ${tok(role)}` } });
const postAction = (action, role) => fetch(`${base}/api/action`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok(role)}` },
  body: JSON.stringify({ action, payload: {} }),
});
const PASSED = 502; // gate passed → proxy tried the unroutable upstream
const DENIED = 403;

// ---- READS ----

test('reads: houses/config/requests pass the gate for every role', async () => {
  for (const role of ['coordinator', 'maintenance', 'field_ops', 'ops_manager', 'ceo']) {
    for (const a of ['houses', 'config', 'requests']) {
      assert.equal((await getData(a, role)).status, PASSED, `${role} should read ${a}`);
    }
  }
});

test('reads: tier B (coordinator/maintenance) get 403 on manager-only reads; managers pass', async () => {
  const managerOnly = ['users', 'inspections', 'findings', 'inventoryItems', 'inventoryCounts', 'checklist', 'technicians', 'events'];
  for (const a of managerOnly) {
    assert.equal((await getData(a, 'coordinator')).status, DENIED, `coordinator must not read ${a}`);
    assert.equal((await getData(a, 'maintenance')).status, DENIED, `maintenance must not read ${a}`);
    assert.equal((await getData(a, 'field_ops')).status, PASSED, `field_ops may read ${a}`);
    assert.equal((await getData(a, 'ceo')).status, PASSED, `ceo may read ${a}`);
  }
});

// ---- WRITES ----

test('writes: coordinator may createRequest + createEvent; every other write → 403', async () => {
  assert.equal((await postAction('createRequest', 'coordinator')).status, PASSED);
  assert.equal((await postAction('createEvent', 'coordinator')).status, PASSED);
  for (const a of ['createInspection', 'addFinding', 'confirmFinding', 'submitInventory', 'editRequest', 'approve', 'assign', 'setStatus', 'deleteRequest']) {
    assert.equal((await postAction(a, 'coordinator')).status, DENIED, `coordinator must not ${a}`);
  }
});

test('writes: maintenance may only createRequest (createEvent + all manager writes → 403)', async () => {
  assert.equal((await postAction('createRequest', 'maintenance')).status, PASSED);
  for (const a of ['createEvent', 'createInspection', 'submitInventory', 'approve', 'assign', 'editRequest']) {
    assert.equal((await postAction(a, 'maintenance')).status, DENIED, `maintenance must not ${a}`);
  }
});

test('writes: the previously-ungated handlers are now 403 for tier B (never-UI-only gap closed)', async () => {
  for (const a of ['createInspection', 'addFinding', 'confirmFinding', 'submitInventory', 'editRequest']) {
    assert.equal((await postAction(a, 'coordinator')).status, DENIED);
    assert.equal((await postAction(a, 'maintenance')).status, DENIED);
    assert.equal((await postAction(a, 'field_ops')).status, PASSED, `field_ops still may ${a}`);
  }
});

// ---- existing exec/manager gates NOT weakened ----

test('managementData stays exec-only: field_ops + tier B → 403; ceo/ops_manager pass', async () => {
  assert.equal((await postAction('managementData', 'coordinator')).status, DENIED);
  assert.equal((await postAction('managementData', 'maintenance')).status, DENIED);
  assert.equal((await postAction('managementData', 'field_ops')).status, DENIED, 'field_ops is NOT exec — must stay 403');
  assert.equal((await postAction('managementData', 'ops_manager')).status, PASSED);
  assert.equal((await postAction('managementData', 'ceo')).status, PASSED);
});

test('updateEvent stays exec-only: field_ops → 403; ceo passes. createEvent blocked for maintenance', async () => {
  assert.equal((await postAction('updateEvent', 'field_ops')).status, DENIED, 'updateEvent is exec-only');
  assert.equal((await postAction('updateEvent', 'ceo')).status, PASSED);
  assert.equal((await postAction('createEvent', 'maintenance')).status, DENIED);
  assert.equal((await postAction('createEvent', 'field_ops')).status, PASSED);
});

// ---- HTML shells are served role-agnostic (enforcement is the data gate + shim redirect) ----

test('HTML routes serve the shell (200) to any session — role enforcement is the data gate + nav redirect', async () => {
  // The document GET carries no token (navigation), so the shell is 200 for everyone; a disallowed role
  // is bounced client-side by the nav shim and gets 403 on every data call for that page.
  for (const p of ['/', '/dashboard', '/management']) {
    const r = await fetch(`${base}${p}`);
    assert.equal(r.status, 200, `${p} shell should serve`);
  }
  // '/events' was removed (nav + page + route) — its shell no longer serves.
  assert.equal((await fetch(`${base}/events`)).status, 404, '/events route is gone');
});
