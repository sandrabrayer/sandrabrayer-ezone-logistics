// test/enforcement.test.js — locks the role/scope enforcement decisions by composing the same pure
// functions the server + Code.gs use (whoApproves + roles predicates). These are the exact checks
// run before any write; an unauthorised actor is rejected with NO state change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whoApproves, APPROVER } from '../src/approval.js';
import { ROLE, canApprove, canDefer, canDispatch, canBlock, isManagerRole } from '../src/roles.js';

const T = 3000;

// Mirrors Code.gs actorMayApprove_: emergency (auto) needs no human approver → any dispatch-capable
// actor may record it; otherwise only the chain-B role (or ceo) may approve.
function mayApprove(actorRole, cost, urgency) {
  const required = whoApproves(cost, urgency, T);
  if (required === APPROVER.AUTO) return canDispatch(actorRole);
  return canApprove(actorRole, required);
}

test('רועי (field_ops) may approve a >3000 request too — Roy approves alone (the amount only sets the reporting flag)', () => {
  // whoApproves still REPORTS ops_manager for >3000 (drives the approval_required flag for budget), but
  // approval AUTHORITY is the manager tier: Roy, Olga and the CEO may all approve it.
  assert.equal(whoApproves(4000, 'רגיל', T), APPROVER.OPS_MANAGER);
  assert.equal(mayApprove(ROLE.FIELD_OPS, 4000, 'רגיל'), true);    // רועי CAN approve (bug fix)
  assert.equal(mayApprove(ROLE.OPS_MANAGER, 4000, 'רגיל'), true);  // אולגה can
  assert.equal(mayApprove(ROLE.CEO, 4000, 'רגיל'), true);          // ceo always
  // tier B still cannot approve at any amount
  assert.equal(mayApprove(ROLE.COORDINATOR, 4000, 'רגיל'), false);
  assert.equal(mayApprove(ROLE.MAINTENANCE, 4000, 'רגיל'), false);
});

test('a field_ops request (≤3000) is approved by field_ops, not by a coordinator/maintenance', () => {
  assert.equal(whoApproves(500, 'רגיל', T), APPROVER.FIELD_OPS);
  assert.equal(mayApprove(ROLE.FIELD_OPS, 500, 'רגיל'), true);
  assert.equal(mayApprove(ROLE.COORDINATOR, 500, 'רגיל'), false);
  assert.equal(mayApprove(ROLE.MAINTENANCE, 500, 'רגיל'), false);
});

test('a pre-opening house low-cost request routes to field_ops by amount (NOT ceo)', () => {
  // whoApproves no longer takes house status — pre-opening is irrelevant; amount decides.
  assert.equal(whoApproves(800, 'רגיל', T), APPROVER.FIELD_OPS);
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

test('block/unblock is a manager-tier power: field_ops / ops_manager / ceo pass, tier B is 403', () => {
  // This is the exact predicate handleSetBlocked_ runs before any write — a 403 means NO state
  // change and NO success audit row (the handler returns before updateRequest_/writeAuditEntry).
  assert.equal(canBlock(ROLE.FIELD_OPS), true);
  assert.equal(canBlock(ROLE.OPS_MANAGER), true);
  assert.equal(canBlock(ROLE.CEO), true);
  assert.equal(canBlock(ROLE.COORDINATOR), false);
  assert.equal(canBlock(ROLE.MAINTENANCE), false);
});

test('emergency (auto) needs no human approver: dispatch-capable may record, coordinator cannot', () => {
  assert.equal(whoApproves(9000, 'חירום', T), APPROVER.AUTO);
  assert.equal(mayApprove(ROLE.FIELD_OPS, 9000, 'חירום'), true);
  assert.equal(mayApprove(ROLE.OPS_MANAGER, 9000, 'חירום'), true);
  assert.equal(mayApprove(ROLE.COORDINATOR, 9000, 'חירום'), false);
});
