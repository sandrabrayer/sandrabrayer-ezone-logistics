// test/schema.test.js — locks the data-model structure and the cluster-vs-lead distinction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HEADERS, SHEET_NAMES, SEED_HOUSES, SEED_TECHNICIANS, SEED_CONFIG, CLUSTERS,
  EXECUTION_STATUS, EXECUTION_STATUS_CHOICES, ASSIGNABLE_LEADS,
} from '../src/schema.js';

test('all sheets are defined (core + inspection module)', () => {
  assert.deepEqual(SHEET_NAMES.sort(), [
    'AuditLog', 'ChecklistItems', 'Config', 'Houses', 'InspectionFindings',
    'Inspections', 'Requests', 'Technicians',
  ]);
});

test('Requests sheet has all 24 columns in order (execution_status appended last)', () => {
  assert.equal(HEADERS.Requests.length, 24);
  assert.equal(HEADERS.Requests[0], 'id');
  // execution_status is APPEND-ONLY at the end (never reorder mid-array — position-mapped sheet).
  assert.equal(HEADERS.Requests[HEADERS.Requests.length - 1], 'execution_status');
  // Spot-check the fields downstream logic depends on exist.
  for (const col of ['estimated_cost', 'urgency', 'status', 'approval_required',
    'deferred_until', 'assigned_to', 'assignment_type', 'trade', 'batch_id', 'execution_status']) {
    assert.ok(HEADERS.Requests.includes(col), `Requests missing column: ${col}`);
  }
});

test('execution-status vocabulary: three pickable values + empty default', () => {
  assert.deepEqual(EXECUTION_STATUS_CHOICES, ['בוצע', 'לא בוצע', 'אחר']);
  assert.equal(EXECUTION_STATUS.NONE, '');
  assert.equal(EXECUTION_STATUS.DONE, 'בוצע');
});

test('assignable leads on הפניה לביצוע are רמי / צחי / רועי', () => {
  assert.deepEqual(ASSIGNABLE_LEADS, ['רמי', 'צחי', 'רועי']);
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

test('Config seeds the threshold and the emergency-bypass flag', () => {
  const keys = SEED_CONFIG.map((c) => c.key);
  assert.ok(keys.includes('approval_threshold'));
  assert.ok(keys.includes('emergency_bypasses_approval'));
});
