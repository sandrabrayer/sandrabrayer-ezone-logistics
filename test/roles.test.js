// test/roles.test.js — locks the role constants + permission predicates (increment 30).
// Mirrored verbatim into apps-script/Code.gs (see test/mirror-drift.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLE, ROLES, isRole, canApprove, canDefer, canDispatch, isManagerRole, houseInScope } from '../src/roles.js';

test('the four roles — ceo is gone (PR 2)', () => {
  assert.deepEqual([...ROLES].sort(), [
    'coordinator', 'field_ops', 'maintenance', 'ops_manager',
  ].sort());
  assert.ok(isRole('ops_manager'));
  assert.equal(isRole('ceo'), false, 'ceo is not a role any more');
  assert.equal('CEO' in ROLE, false, 'no ROLE.CEO constant');
  assert.ok(!isRole('nope'));
  assert.ok(!isRole(''));
});

test('canApprove: ONLY ops_manager approves (chain B v3); field_ops / coordinator / maintenance / a removed ceo never do', () => {
  assert.equal(canApprove(ROLE.OPS_MANAGER, ROLE.OPS_MANAGER), true);
  assert.equal(canApprove(ROLE.FIELD_OPS, ROLE.OPS_MANAGER), false);
  assert.equal(canApprove(ROLE.COORDINATOR, ROLE.OPS_MANAGER), false);
  assert.equal(canApprove(ROLE.MAINTENANCE, ROLE.OPS_MANAGER), false);
  assert.equal(canApprove('ceo', ROLE.OPS_MANAGER), false, 'a stale ceo token approves nothing');
  // a nonsensical required role approves nothing either (fail closed)
  assert.equal(canApprove(ROLE.OPS_MANAGER, 'field_ops'), false);
  assert.equal(canApprove(ROLE.OPS_MANAGER, 'ceo'), false);
  assert.equal(canApprove(ROLE.FIELD_OPS, 'field_ops'), false, 'the field_ops approval tier is gone');
});

test('canDefer: field_ops / ops_manager only', () => {
  assert.equal(canDefer(ROLE.FIELD_OPS), true);
  assert.equal(canDefer(ROLE.OPS_MANAGER), true);
  assert.equal(canDefer('ceo'), false);
  assert.equal(canDefer(ROLE.COORDINATOR), false);
  assert.equal(canDefer(ROLE.MAINTENANCE), false);
});

test('canDispatch: field_ops / ops_manager only', () => {
  assert.equal(canDispatch(ROLE.FIELD_OPS), true);
  assert.equal(canDispatch(ROLE.OPS_MANAGER), true);
  assert.equal(canDispatch('ceo'), false);
  assert.equal(canDispatch(ROLE.COORDINATOR), false);
  assert.equal(canDispatch(ROLE.MAINTENANCE), false);
});

test('isManagerRole: tier A = field_ops / ops_manager', () => {
  assert.equal(isManagerRole(ROLE.FIELD_OPS), true);
  assert.equal(isManagerRole(ROLE.OPS_MANAGER), true);
  assert.equal(isManagerRole('ceo'), false);
  assert.equal(isManagerRole(ROLE.COORDINATOR), false);
  assert.equal(isManagerRole(ROLE.MAINTENANCE), false);
});

test('houseInScope: managers see every house', () => {
  for (const r of [ROLE.FIELD_OPS, ROLE.OPS_MANAGER]) {
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
