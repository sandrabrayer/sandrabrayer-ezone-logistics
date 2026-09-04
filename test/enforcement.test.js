// test/enforcement.test.js — locks the role/scope enforcement decisions by composing the same pure
// functions the server + Code.gs use (whoApproves + roles predicates). These are the exact checks
// run before any write; an unauthorised actor is rejected with NO state change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whoApproves, APPROVER } from '../src/approval.js';
import { ROLE, canApprove, canDefer, canDispatch, canBlock, isManagerRole } from '../src/roles.js';

// Mirrors Code.gs actorMayApprove_: emergency (auto) needs no human approver → any dispatch-capable
// actor may record it; otherwise only ops_manager (chain B v3) may approve.
function mayApprove(actorRole, cost, urgency) {
  const required = whoApproves(cost, urgency);
  if (required === APPROVER.AUTO) return canDispatch(actorRole);
  return canApprove(actorRole, required);
}

test('אולגה (ops_manager) approves ANY amount; רועי (field_ops) approves NOTHING — large and small alike', () => {
  for (const cost of [4000, 500, 3000, '']) {
    assert.equal(whoApproves(cost, 'רגיל'), APPROVER.OPS_MANAGER);
    assert.equal(mayApprove(ROLE.OPS_MANAGER, cost, 'רגיל'), true, `אולגה approves cost=${cost}`);
    assert.equal(mayApprove(ROLE.FIELD_OPS, cost, 'רגיל'), false, `רועי may not approve cost=${cost}`);
  }
});

test('a stale ceo token approves nothing (the role no longer exists)', () => {
  assert.equal(mayApprove('ceo', 4000, 'רגיל'), false);
  assert.equal(mayApprove('ceo', 500, 'רגיל'), false);
  assert.equal(mayApprove('ceo', 9000, 'חירום'), false, 'not even the emergency auto path (not dispatch-capable)');
  assert.equal(canDefer('ceo'), false);
  assert.equal(canDispatch('ceo'), false);
  assert.equal(canBlock('ceo'), false);
  assert.equal(isManagerRole('ceo'), false);
});

test('a small request is NOT approved by field_ops / coordinator / maintenance — only ops_manager', () => {
  assert.equal(whoApproves(500, 'רגיל'), APPROVER.OPS_MANAGER);
  assert.equal(mayApprove(ROLE.FIELD_OPS, 500, 'רגיל'), false);
  assert.equal(mayApprove(ROLE.COORDINATOR, 500, 'רגיל'), false);
  assert.equal(mayApprove(ROLE.MAINTENANCE, 500, 'רגיל'), false);
  assert.equal(mayApprove(ROLE.OPS_MANAGER, 500, 'רגיל'), true);
});

test('a pre-opening house request routes to ops_manager like any other (no house-status branch, no ceo)', () => {
  assert.equal(whoApproves(800, 'רגיל'), APPROVER.OPS_MANAGER);
});

test('coordinator + maintenance (tier B) have no approve / defer / dispatch / block powers → 403 each', () => {
  for (const r of [ROLE.COORDINATOR, ROLE.MAINTENANCE]) {
    assert.equal(mayApprove(r, 500, 'רגיל'), false);   // approve/reject
    assert.equal(mayApprove(r, 4000, 'רגיל'), false);
    assert.equal(canDefer(r), false);                  // defer
    assert.equal(canDispatch(r), false);               // assign / dispatch / batch
    assert.equal(canBlock(r), false);                  // block/unblock (increment 36)
    assert.equal(isManagerRole(r), false);
  }
});

test('block/unblock is a manager-tier power: field_ops / ops_manager pass, tier B is 403', () => {
  // This is the exact predicate handleSetBlocked_ runs before any write — a 403 means NO state
  // change and NO success audit row (the handler returns before updateRequest_/writeAuditEntry).
  assert.equal(canBlock(ROLE.FIELD_OPS), true);
  assert.equal(canBlock(ROLE.OPS_MANAGER), true);
  assert.equal(canBlock(ROLE.COORDINATOR), false);
  assert.equal(canBlock(ROLE.MAINTENANCE), false);
});

test('emergency (auto) needs no human approver: dispatch-capable may record, coordinator cannot', () => {
  assert.equal(whoApproves(9000, 'חירום'), APPROVER.AUTO);
  assert.equal(mayApprove(ROLE.FIELD_OPS, 9000, 'חירום'), true);
  assert.equal(mayApprove(ROLE.OPS_MANAGER, 9000, 'חירום'), true);
  assert.equal(mayApprove(ROLE.COORDINATOR, 9000, 'חירום'), false);
});
