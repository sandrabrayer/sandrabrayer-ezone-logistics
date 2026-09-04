// test/schema.test.js — locks the data-model structure and the cluster-vs-lead distinction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HEADERS, SHEET_NAMES, SEED_HOUSES, SEED_TECHNICIANS, SEED_CONFIG, CLUSTERS,
  EXECUTION_STATUS, EXECUTION_STATUS_CHOICES, ASSIGNABLE_LEADS, SEED_USERS, USER_ROLES,
} from '../src/schema.js';

test('all sheets are defined (core + inspection + inventory modules)', () => {
  assert.deepEqual(SHEET_NAMES.sort(), [
    'AuditLog', 'Budgets', 'ChecklistItems', 'Compliance', 'Config', 'Events', 'Houses',
    'InspectionFindings', 'Inspections', 'InventoryCounts', 'InventoryItems', 'MaintenancePlan',
    'NotifyLog', 'Requests', 'Technicians', 'Users',
  ].sort());
});

test('Events sheet has the append-only exceptional-events columns', () => {
  assert.deepEqual(HEADERS.Events, [
    'id', 'created_at', 'created_by', 'house', 'occurred_at', 'event_type', 'severity',
    'description', 'immediate_action', 'root_cause', 'lessons', 'corrective_request_id',
    'status', 'closed_at', 'notes',
  ]);
});

test('Requests sheet has all 31 columns; rejected_at appended last (digest rejection retention)', () => {
  assert.equal(HEADERS.Requests.length, 31);
  assert.equal(HEADERS.Requests[0], 'id');
  // rejected_at is APPEND-ONLY at the very end; execution_status keeps its position (index 23).
  assert.equal(HEADERS.Requests[HEADERS.Requests.length - 1], 'rejected_at');
  assert.equal(HEADERS.Requests[23], 'execution_status');
  // The SLA columns (36), plan_id (maintenance) and compliance_id stay put just before rejected_at.
  assert.equal(HEADERS.Requests[27], 'blocked_at');
  assert.equal(HEADERS.Requests[28], 'plan_id');
  assert.equal(HEADERS.Requests[29], 'compliance_id');
  // Spot-check the fields downstream logic depends on exist.
  for (const col of ['estimated_cost', 'urgency', 'status', 'approval_required',
    'deferred_until', 'assigned_to', 'assignment_type', 'trade', 'batch_id', 'execution_status',
    'due_at', 'blocked', 'blocked_reason', 'blocked_at', 'plan_id', 'compliance_id', 'rejected_at']) {
    assert.ok(HEADERS.Requests.includes(col), `Requests missing column: ${col}`);
  }
});

test('MaintenancePlan sheet has the append-only plan columns', () => {
  assert.deepEqual(HEADERS.MaintenancePlan,
    ['id', 'house', 'task', 'frequency_months', 'last_done', 'active', 'notes']);
});

test('Compliance sheet has the append-only compliance columns', () => {
  assert.deepEqual(HEADERS.Compliance,
    ['id', 'house', 'item', 'expires_at', 'reminder_days', 'doc_url', 'notes', 'active']);
});

test('execution-status vocabulary: three pickable values + empty default', () => {
  assert.deepEqual(EXECUTION_STATUS_CHOICES, ['בוצע', 'לא בוצע', 'אחר']);
  assert.equal(EXECUTION_STATUS.NONE, '');
  assert.equal(EXECUTION_STATUS.DONE, 'בוצע');
});

test('assignable leads on העברה לביצוע are רמי / צחי / רועי', () => {
  assert.deepEqual(ASSIGNABLE_LEADS, ['רמי', 'צחי', 'רועי']);
});

test('Houses has exactly the six seed houses', () => {
  assert.equal(SEED_HOUSES.length, 6);
});

test('cluster ≠ maintenance lead: Tzachi covers caesarea AND north as separate clusters', () => {
  const byName = Object.fromEntries(SEED_HOUSES.map((h) => [h.name, h]));

  // Tzachi (צחי) is the internal lead for all three of his houses...
  assert.equal(byName['קיסריה עפרוני'].technician, 'צחי');
  assert.equal(byName['קיסריה ריהאב'].technician, 'צחי');
  assert.equal(byName['שדה אליעזר'].technician, 'צחי');

  // ...but Sde Eliezer sits in a DIFFERENT cluster from the coastal two, so an external
  // visit there is never auto-batched with Ofroni + Rehab just because they share Tzachi.
  assert.equal(byName['קיסריה עפרוני'].cluster, CLUSTERS.CAESAREA);
  assert.equal(byName['קיסריה ריהאב'].cluster, CLUSTERS.CAESAREA);
  assert.equal(byName['שדה אליעזר'].cluster, CLUSTERS.NORTH);
  assert.notEqual(byName['שדה אליעזר'].cluster, byName['קיסריה ריהאב'].cluster);
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

test('Config seeds the (legacy) threshold and the emergency-bypass flag; ceo_ceiling is no longer seeded', () => {
  const keys = SEED_CONFIG.map((c) => c.key);
  assert.ok(keys.includes('approval_threshold'), 'legacy key kept in place (unused by routing)');
  assert.ok(keys.includes('emergency_bypasses_approval'));
  assert.equal(keys.includes('ceo_ceiling'), false, 'ceo_ceiling removed with the ceo role (PR 2)');
  // sla_days (increment 36) — the tunable SLA spec.
  assert.ok(keys.includes('sla_days'));
  assert.equal(SEED_CONFIG.find((c) => c.key === 'sla_days').value, 'חירום:1|דחוף:3|רגיל:14');
  // compliance_reminder_days (compliance tracker) — default reminder window, seeded 30.
  assert.ok(keys.includes('compliance_reminder_days'));
  assert.equal(SEED_CONFIG.find((c) => c.key === 'compliance_reminder_days').value, '30');
  // event_types (exceptional-events register) — the allowed categories spec.
  assert.ok(keys.includes('event_types'));
  assert.equal(SEED_CONFIG.find((c) => c.key === 'event_types').value, 'בטיחות|תרופות|התנהגות|תשתיות|תברואה|אחר');
  // Foreign digest ids (read-only consumption): kitchen seeded with the known id, coordinators blank,
  // training seeded with the coordinators-published TrainingCompliance digest id.
  assert.equal(SEED_CONFIG.find((c) => c.key === 'kitchen_digest_id').value, '1sJ62lUfgyaes_Ippv1CH3acLmExju3aZXAfk12g0zfE');
  assert.equal(SEED_CONFIG.find((c) => c.key === 'coordinators_digest_id').value, '');
  assert.equal(SEED_CONFIG.find((c) => c.key === 'training_digest_id').value, '1RgLLrvymIhRh0sN6jOuCcgr5VT8hQL8wofhjUUt1CCI');
});

test('Users sheet: headers + the seeded roster (roles from the controlled set)', () => {
  // pin_hash (increment 31) is APPENDED at the end — never reorder the earlier columns.
  assert.deepEqual(HEADERS.Users, ['name', 'role', 'house', 'active', 'pin_hash']);
  assert.equal(HEADERS.Users[HEADERS.Users.length - 1], 'pin_hash');
  const byName = Object.fromEntries(SEED_USERS.map((u) => [u.name, u]));
  assert.equal(byName['רועי'].role, 'field_ops');
  assert.equal(byName['אולגה'].role, 'ops_manager');
  assert.equal('סנדרה' in byName, false, 'סנדרה (ceo) is no longer seeded (PR 2)');
  assert.equal(SEED_USERS.some((u) => u.role === 'ceo'), false, 'no ceo row in the seed');
  assert.equal(USER_ROLES.includes('ceo'), false, 'ceo is not a role');
  assert.equal(byName['רמי'].role, 'maintenance');
  assert.equal(byName['צחי'].role, 'maintenance');
  assert.equal(byName['שירה'].role, 'coordinator');
  // field_ops / ops_manager carry no own house (all houses); every user active + a valid role.
  assert.equal(byName['רועי'].house, '');
  assert.equal(byName['אולגה'].house, '');
  for (const u of SEED_USERS) {
    assert.equal(u.active, 'TRUE');
    assert.ok(USER_ROLES.includes(u.role), `unknown role: ${u.role}`);
    // pin_hash is a legacy, append-only column: always blank, nothing writes it (setUserPin is retired).
    assert.equal(u.pin_hash, '');
  }
});
