// test/roles.test.js — locks the role constants + permission predicates (increment 30).
// Mirrored verbatim into apps-script/Code.gs (see test/mirror-drift.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLE, ROLES, isRole, canApprove, canDefer, canDispatch, isManagerRole, houseInScope } from '../src/roles.js';

test('the five roles', () => {
  assert.deepEqual([...ROLES].sort(), [
    'ceo', 'coordinator', 'field_ops', 'maintenance', 'ops_manager',
  ].sort());
  assert.ok(isRole('ceo'));
  assert.ok(!isRole('nope'));
  assert.ok(!isRole(''));
});

test('canApprove: the resolved role may approve; ops_manager (single login) and ceo may approve at any amount', () => {
  // required = field_ops
  assert.equal(canApprove(ROLE.FIELD_OPS, ROLE.FIELD_OPS), true);
  assert.equal(canApprove(ROLE.OPS_MANAGER, ROLE.FIELD_OPS), true); // PR 1: every session is ops_manager; the approver CODE is the control
  assert.equal(canApprove(ROLE.CEO, ROLE.FIELD_OPS), true); // ceo always
  // required = ops_manager
  assert.equal(canApprove(ROLE.OPS_MANAGER, ROLE.OPS_MANAGER), true);
  assert.equal(canApprove(ROLE.FIELD_OPS, ROLE.OPS_MANAGER), false);
  assert.equal(canApprove(ROLE.CEO, ROLE.OPS_MANAGER), true); // ceo always
  // required = ceo
  assert.equal(canApprove(ROLE.CEO, ROLE.CEO), true);
  assert.equal(canApprove(ROLE.OPS_MANAGER, ROLE.CEO), true);
  // coordinator / maintenance never approve
  assert.equal(canApprove(ROLE.COORDINATOR, ROLE.FIELD_OPS), false);
  assert.equal(canApprove(ROLE.MAINTENANCE, ROLE.OPS_MANAGER), false);
});

test('canDefer: field_ops / ops_manager / ceo only', () => {
  assert.equal(canDefer(ROLE.FIELD_OPS), true);
  assert.equal(canDefer(ROLE.OPS_MANAGER), true);
  assert.equal(canDefer(ROLE.CEO), true);
  assert.equal(canDefer(ROLE.COORDINATOR), false);
  assert.equal(canDefer(ROLE.MAINTENANCE), false);
});

test('canDispatch: field_ops / ops_manager / ceo only', () => {
  assert.equal(canDispatch(ROLE.FIELD_OPS), true);
  assert.equal(canDispatch(ROLE.OPS_MANAGER), true);
  assert.equal(canDispatch(ROLE.CEO), true);
  assert.equal(canDispatch(ROLE.COORDINATOR), false);
  assert.equal(canDispatch(ROLE.MAINTENANCE), false);
});

test('isManagerRole: tier A = field_ops / ops_manager / ceo', () => {
  assert.equal(isManagerRole(ROLE.FIELD_OPS), true);
  assert.equal(isManagerRole(ROLE.OPS_MANAGER), true);
  assert.equal(isManagerRole(ROLE.CEO), true);
  assert.equal(isManagerRole(ROLE.COORDINATOR), false);
  assert.equal(isManagerRole(ROLE.MAINTENANCE), false);
});

test('houseInScope: managers see every house', () => {
  for (const r of [ROLE.FIELD_OPS, ROLE.OPS_MANAGER, ROLE.CEO]) {
    assert.equal(houseInScope(r, '', 'רעננה', 'sharon'), true);
    assert.equal(houseInScope(r, '', 'קיסריה עפרוני', 'caesarea'), true);
  }
});

test('houseInScope: a coordinator sees ONLY their own house', () => {
  assert.equal(houseInScope(ROLE.COORDINATOR, 'רעננה', 'רעננה', 'sharon'), true);
  assert.equal(houseInScope(ROLE.COORDINATOR, 'רעננה', 'ריהאב', 'caesarea'), false);
});

test('houseInScope: a maintenance lead sees the houses in their cluster(s)', () => {
  // רמי → sharon
  assert.equal(houseInScope(ROLE.MAINTENANCE, 'sharon', 'רעננה', 'sharon'), true);
  assert.equal(houseInScope(ROLE.MAINTENANCE, 'sharon', 'ריהאב', 'caesarea'), false);
  // צחי → caesarea + north (comma-separated, whitespace-tolerant)
  assert.equal(houseInScope(ROLE.MAINTENANCE, 'caesarea,north', 'ריהאב', 'caesarea'), true);
  assert.equal(houseInScope(ROLE.MAINTENANCE, 'caesarea, north', 'שדה אליעזר', 'north'), true);
  assert.equal(houseInScope(ROLE.MAINTENANCE, 'caesarea,north', 'רעננה', 'sharon'), false);
});
