// test/access.test.js — role-based page + data-action visibility (owner's model, increment 38).
// Locks the matrix used by BOTH enforcement layers: the server-side data gate (canRead/canWriteAction)
// and the nav shim (navByRole/canOpenPage). The write gate is mirrored into Code.gs (guarded by
// mirror-drift.test.js). Also asserts existing gates are NOT weakened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canRead, canWriteAction, canOpenPage, navByRole, navLinksFor, canonicalPath,
} from '../src/access.js';
import { ROLE } from '../src/roles.js';

const ROLES = [ROLE.COORDINATOR, ROLE.MAINTENANCE, ROLE.FIELD_OPS, ROLE.OPS_MANAGER, ROLE.CEO];
// Entry-flow redesign: the request form is the PUBLIC '/request' (nav link), and '/status' is a
// coordinator-only own-house status page. The public landing '/' is NOT a gated nav page.
const ALL_PAGES = ['/request', '/dashboard', '/workorders', '/inventory', '/inspection', '/reports', '/status', '/events', '/management'];
const READS = ['houses', 'config', 'requests', 'users', 'technicians', 'checklist', 'inspections', 'findings', 'inventoryItems', 'inventoryCounts', 'events'];
const WRITES = ['createRequest', 'createEvent', 'updateEvent', 'managementData', 'approve', 'reject', 'defer', 'assign', 'setStatus', 'setExecution', 'setBlocked', 'createInspection', 'addFinding', 'confirmFinding', 'deleteRequest', 'editRequest', 'submitInventory'];

// ---- PAGE ACCESS MATRIX (role × each page: allowed/denied) ----

const PAGE_EXPECT = {
  coordinator: ['/request', '/status', '/events'],
  maintenance: ['/request', '/dashboard', '/workorders', '/inventory', '/inspection', '/reports'],
  field_ops: ['/request', '/dashboard', '/workorders', '/inventory', '/inspection', '/reports', '/events'],
  ops_manager: ['/request', '/dashboard', '/workorders', '/inventory', '/inspection', '/reports', '/events', '/management'],
  ceo: ['/request', '/dashboard', '/workorders', '/inventory', '/inspection', '/reports', '/events', '/management'],
};

for (const role of ROLES) {
  test(`page access matrix — ${role}`, () => {
    for (const page of ALL_PAGES) {
      const allowed = PAGE_EXPECT[role].indexOf(page) !== -1;
      assert.equal(canOpenPage(role, page), allowed, `${role} × ${page} should be ${allowed ? 'allowed' : 'denied'}`);
    }
  });
}

test('coordinator opens ONLY the request form, status and events (no dashboard/inventory/reports/בקרה/משימות/management)', () => {
  assert.equal(canOpenPage('coordinator', '/request'), true);
  assert.equal(canOpenPage('coordinator', '/status'), true);
  assert.equal(canOpenPage('coordinator', '/events'), true);
  for (const p of ['/dashboard', '/workorders', '/inventory', '/inspection', '/reports', '/management']) {
    assert.equal(canOpenPage('coordinator', p), false, `coordinator must not open ${p}`);
  }
});

test('field_ops sees everything EXCEPT /management and /status; execs see /management too', () => {
  for (const p of ALL_PAGES.filter((x) => x !== '/management' && x !== '/status')) assert.equal(canOpenPage('field_ops', p), true);
  assert.equal(canOpenPage('field_ops', '/management'), false);
  assert.equal(canOpenPage('field_ops', '/status'), false, '/status is coordinator-only');
  assert.equal(canOpenPage('ops_manager', '/management'), true);
  assert.equal(canOpenPage('ceo', '/management'), true);
});

test('canOpenPage normalizes .html forms; the public landing / is not a gated nav page', () => {
  assert.equal(canOpenPage('coordinator', '/request.html'), true);
  assert.equal(canOpenPage('coordinator', '/events.html'), true);
  assert.equal(canOpenPage('coordinator', '/dashboard.html'), false);
  assert.equal(canOpenPage('field_ops', '/reports.html'), true);
  // '/' (and /index.html) is the PUBLIC landing — reachable by anyone, but never a role-gated nav page.
  assert.equal(canOpenPage('coordinator', '/'), false);
  assert.equal(canonicalPath('/events.html?x=1'), '/events');
});

test('unknown / blank role fails closed to just the request form', () => {
  assert.equal(canOpenPage('', '/request'), true);
  assert.equal(canOpenPage('nonsense', '/dashboard'), false);
  assert.deepEqual(navLinksFor('nonsense').map((l) => l.href), ['/request']);
});

// ---- NAV MATRIX (shim renders exactly these, in order) ----

test('navByRole renders exactly the permitted links, in canonical order', () => {
  const nav = navByRole();
  assert.deepEqual(nav.coordinator.map((l) => l.href), ['/request', '/status', '/events']);
  assert.deepEqual(nav.coordinator.map((l) => l.label), ['דרישה חדשה', 'הדרישות שלי', 'אירועים חריגים']);
  assert.deepEqual(nav.field_ops.map((l) => l.href), ['/request', '/dashboard', '/workorders', '/inventory', '/inspection', '/reports', '/events']);
  assert.ok(!nav.field_ops.some((l) => l.href === '/management'), 'field_ops nav has no management link');
  assert.ok(!nav.field_ops.some((l) => l.href === '/status'), '/status is coordinator-only');
  assert.deepEqual(nav.ops_manager.map((l) => l.href), PAGE_EXPECT.ops_manager);
  assert.deepEqual(nav.ceo.map((l) => l.href), PAGE_EXPECT.ceo);
  assert.deepEqual(nav.maintenance.map((l) => l.href), ['/request', '/dashboard', '/workorders', '/inventory', '/inspection', '/reports']);
});

test('nav visibility exactly matches page access for every role (link ⇔ openable)', () => {
  const nav = navByRole();
  for (const role of ROLES) {
    for (const page of ALL_PAGES) {
      const inNav = nav[role].some((l) => l.href === page);
      assert.equal(inNav, canOpenPage(role, page), `${role}: nav(${page})=${inNav} but canOpen=${canOpenPage(role, page)}`);
    }
  }
});

// ---- READ MATRIX (role × data read) ----

test('reads: houses/config/requests open to all; users + manager-only reads are manager-tier', () => {
  for (const role of ROLES) {
    for (const a of ['houses', 'config', 'requests']) assert.equal(canRead(role, a), true, `${role} may read ${a}`);
  }
  const managerOnly = ['users', 'technicians', 'checklist', 'inspections', 'findings', 'inventoryItems', 'inventoryCounts', 'events'];
  for (const a of managerOnly) {
    assert.equal(canRead('coordinator', a), false, `coordinator must not read ${a}`);
    assert.equal(canRead('maintenance', a), false, `maintenance must not read ${a}`);
    assert.equal(canRead('field_ops', a), true, `field_ops may read ${a}`);
    assert.equal(canRead('ceo', a), true, `ceo may read ${a}`);
  }
});

// ---- WRITE MATRIX (role × data write) — the mirrored gate ----

test('writes: tier B limited to createRequest (+createEvent for coordinator); managers pass the early gate', () => {
  // coordinator
  assert.equal(canWriteAction('coordinator', 'createRequest'), true);
  assert.equal(canWriteAction('coordinator', 'createEvent'), true);
  for (const a of WRITES.filter((x) => x !== 'createRequest' && x !== 'createEvent')) {
    assert.equal(canWriteAction('coordinator', a), false, `coordinator must not ${a}`);
  }
  // maintenance — only createRequest (no createEvent, per existing events rule)
  assert.equal(canWriteAction('maintenance', 'createRequest'), true);
  assert.equal(canWriteAction('maintenance', 'createEvent'), false);
  for (const a of WRITES.filter((x) => x !== 'createRequest')) {
    assert.equal(canWriteAction('maintenance', a), false, `maintenance must not ${a}`);
  }
  // managers pass the early gate for every action (precise per-action gates run in the handlers)
  for (const role of [ROLE.FIELD_OPS, ROLE.OPS_MANAGER, ROLE.CEO]) {
    for (const a of WRITES) assert.equal(canWriteAction(role, a), true, `${role} passes early gate for ${a}`);
  }
});

test('the early write gate CLOSES the previously-ungated writes for tier B (never-UI-only)', () => {
  // These handlers had no server-side role check before; tier B is now refused them.
  for (const a of ['createInspection', 'addFinding', 'confirmFinding', 'submitInventory', 'editRequest']) {
    assert.equal(canWriteAction('coordinator', a), false);
    assert.equal(canWriteAction('maintenance', a), false);
  }
});

test('existing exec/manager gates are NOT weakened by the early gate (managementData/updateEvent still exec-only downstream)', () => {
  // canWriteAction returns true for field_ops on managementData/updateEvent by design — the PRECISE gate
  // (canManage) still runs in server.js handleAction + Code.gs handlers to 403 field_ops. The matrix
  // must not itself grant tier B these:
  assert.equal(canWriteAction('coordinator', 'managementData'), false);
  assert.equal(canWriteAction('maintenance', 'managementData'), false);
  assert.equal(canWriteAction('coordinator', 'updateEvent'), false);
});
