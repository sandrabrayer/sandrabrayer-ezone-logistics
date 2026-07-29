// test/enforcement.test.js — locks the Step-5 role enforcement decisions by composing the same
// pure functions Code.gs uses (whoApproves + roles predicates). These are the exact checks the
// server + Code.gs run before any write; an unauthorised actor is rejected with NO state change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whoApproves, APPROVER } from '../src/approval.js';
import { ROLE, canApprove, canDefer, canDispatch } from '../src/roles.js';

const T = 3000;
const OPEN = 'open';
const NO_CEILING = '';

// Mirrors Code.gs actorMayApprove_: emergency (auto) needs no human approver → any dispatch-capable
// actor may record it; otherwise only the chain-B role (or ceo) may approve.
function mayApprove(actorRole, cost, urgency, houseStatus) {
  const required = whoApproves(cost, urgency, houseStatus, T, NO_CEILING);
  if (required === APPROVER.AUTO) return canDispatch(actorRole);
  return canApprove(actorRole, required);
}

test('coordinator attempting approve on an ops_manager request → rejected', () => {
  // 4000 > threshold, open house → routes to ops_manager
  assert.equal(whoApproves(4000, 'רגיל', OPEN, T, NO_CEILING), APPROVER.OPS_MANAGER);
  assert.equal(mayApprove(ROLE.COORDINATOR, 4000, 'רגיל', OPEN), false);
  assert.equal(mayApprove(ROLE.MAINTENANCE, 4000, 'רגיל', OPEN), false);
  assert.equal(mayApprove(ROLE.FIELD_OPS, 4000, 'רגיל', OPEN), false); // field_ops can't approve an ops_manager request
  // the resolved role and the ceo can
  assert.equal(mayApprove(ROLE.OPS_MANAGER, 4000, 'רגיל', OPEN), true);
  assert.equal(mayApprove(ROLE.CEO, 4000, 'רגיל', OPEN), true);
});

test('a field_ops request may be approved by field_ops (and ceo), not by a coordinator', () => {
  assert.equal(whoApproves(500, 'רגיל', OPEN, T, NO_CEILING), APPROVER.FIELD_OPS);
  assert.equal(mayApprove(ROLE.FIELD_OPS, 500, 'רגיל', OPEN), true);
  assert.equal(mayApprove(ROLE.CEO, 500, 'רגיל', OPEN), true);
  assert.equal(mayApprove(ROLE.COORDINATOR, 500, 'רגיל', OPEN), false);
  assert.equal(mayApprove(ROLE.MAINTENANCE, 500, 'רגיל', OPEN), false);
  assert.equal(mayApprove(ROLE.OPS_MANAGER, 500, 'רגיל', OPEN), false); // ops_manager is not the resolved role here
});

test('a pre-opening (ceo) request may be approved only by the ceo', () => {
  assert.equal(whoApproves(100, 'רגיל', 'טרום-פתיחה', T, NO_CEILING), APPROVER.CEO);
  assert.equal(mayApprove(ROLE.CEO, 100, 'רגיל', 'טרום-פתיחה'), true);
  assert.equal(mayApprove(ROLE.OPS_MANAGER, 100, 'רגיל', 'טרום-פתיחה'), false);
  assert.equal(mayApprove(ROLE.FIELD_OPS, 100, 'רגיל', 'טרום-פתיחה'), false);
});

test('emergency (auto) needs no human approver: dispatch-capable may record, coordinator cannot', () => {
  assert.equal(whoApproves(9000, 'חירום', OPEN, T, NO_CEILING), APPROVER.AUTO);
  assert.equal(mayApprove(ROLE.FIELD_OPS, 9000, 'חירום', OPEN), true);
  assert.equal(mayApprove(ROLE.OPS_MANAGER, 9000, 'חירום', OPEN), true);
  assert.equal(mayApprove(ROLE.CEO, 9000, 'חירום', OPEN), true);
  assert.equal(mayApprove(ROLE.COORDINATOR, 9000, 'חירום', OPEN), false);
  assert.equal(mayApprove(ROLE.MAINTENANCE, 9000, 'חירום', OPEN), false);
});

test('defer + dispatch are field_ops / ops_manager / ceo only', () => {
  for (const r of [ROLE.FIELD_OPS, ROLE.OPS_MANAGER, ROLE.CEO]) {
    assert.equal(canDefer(r), true);
    assert.equal(canDispatch(r), true);
  }
  for (const r of [ROLE.COORDINATOR, ROLE.MAINTENANCE]) {
    assert.equal(canDefer(r), false);
    assert.equal(canDispatch(r), false);
  }
});
