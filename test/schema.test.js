// test/schema.test.js — locks the data-model structure and the cluster-vs-lead distinction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HEADERS, SHEET_NAMES, SEED_HOUSES, SEED_TECHNICIANS, SEED_CONFIG, SEED_USERS, CLUSTERS, ROLES,
} from '../src/schema.js';

test('all six sheets are defined', () => {
  assert.deepEqual(
    SHEET_NAMES.sort(),
    ['AuditLog', 'Config', 'Houses', 'Requests', 'Technicians', 'Users'],
  );
});

test('Users sheet has the four spec columns in order', () => {
  assert.deepEqual(HEADERS.Users, ['name', 'role', 'house', 'active']);
});

test('Requests sheet has all 22 spec columns in order', () => {
  assert.equal(HEADERS.Requests.length, 22);
  assert.equal(HEADERS.Requests[0], 'id');
  // Spot-check the fields downstream logic depends on exist.
  for (const col of ['estimated_cost', 'urgency', 'status', 'approval_required',
    'deferred_until', 'assigned_to', 'assignment_type', 'batch_id']) {
    assert.ok(HEADERS.Requests.includes(col), `Requests missing column: ${col}`);
  }
});

test('Houses has exactly the six seed houses', () => {
  assert.equal(SEED_HOUSES.length, 6);
});

test('cluster ≠ maintenance lead: Tzachi covers caesarea AND north as separate clusters', () => {
  const byName = Object.fromEntries(SEED_HOUSES.map((h) => [h.name, h]));

  // Tzachi (צחי) is the internal lead for all three of his houses...
  assert.equal(byName['קיסריה עפרוני'].technician, 'צחי');
  assert.equal(byName['ריהאב'].technician, 'צחי');
  assert.equal(byName['שדה אליעזר'].technician, 'צחי');

  // ...but Sde Eliezer sits in a DIFFERENT cluster from the coastal two, so an external
  // visit there is never auto-batched with Ofroni + Rehab just because they share Tzachi.
  assert.equal(byName['קיסריה עפרוני'].cluster, CLUSTERS.CAESAREA);
  assert.equal(byName['ריהאב'].cluster, CLUSTERS.CAESAREA);
  assert.equal(byName['שדה אליעזר'].cluster, CLUSTERS.NORTH);
  assert.notEqual(byName['שדה אליעזר'].cluster, byName['ריהאב'].cluster);
});

test('Sharon cluster = Rami’s three houses', () => {
  const sharon = SEED_HOUSES.filter((h) => h.cluster === CLUSTERS.SHARON);
  assert.equal(sharon.length, 3);
  assert.ok(sharon.every((h) => h.technician === 'רמי'));
});

test('seeded technicians are the two internal leads', () => {
  assert.equal(SEED_TECHNICIANS.length, 2);
  assert.ok(SEED_TECHNICIANS.every((t) => t.type === 'internal'));
  assert.deepEqual(SEED_TECHNICIANS.map((t) => t.name).sort(), ['צחי', 'רמי']);
});

test('Config seeds the threshold, emergency-bypass flag, and the ceo_ceiling (blank=disabled)', () => {
  const byKey = Object.fromEntries(SEED_CONFIG.map((c) => [c.key, c.value]));
  assert.ok('approval_threshold' in byKey);
  assert.ok('emergency_bypasses_approval' in byKey);
  assert.ok('ceo_ceiling' in byKey);
  assert.equal(byKey.ceo_ceiling, ''); // disabled by default
});

test('Users seed matches the increment-28 roster with valid roles', () => {
  assert.equal(SEED_USERS.length, 9);
  const byName = Object.fromEntries(SEED_USERS.map((u) => [u.name, u]));
  assert.equal(byName['רועי'].role, ROLES.FIELD_OPS);
  assert.equal(byName['אולגה'].role, ROLES.OPS_MANAGER);
  assert.equal(byName['סנדרה'].role, ROLES.CEO);
  assert.equal(byName['רמי'].role, ROLES.MAINTENANCE);
  assert.equal(byName['צחי'].house, 'cluster:caesarea+north');
  assert.equal(byName['שירה'].house, 'קיסריה עפרוני');
  const validRoles = new Set(Object.values(ROLES));
  assert.ok(SEED_USERS.every((u) => validRoles.has(u.role)));
  assert.ok(SEED_USERS.every((u) => u.active === true)); // all seeded active
});
