// test/approval.test.js — locks the heart of the app: chain-B v3 routing + status transitions.
//
// Chain B v3 (PR 2): אולגה approves everything. Two rules only — emergency → auto; everything else →
// ops_manager. No amount tier (approval_threshold is a legacy Config key nothing reads), no house-status
// branch, no ceo. A deferral wake-up re-routes through the same two rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whoApproves, approvalRequired, canTransition, APPROVER } from '../src/approval.js';
import { STATUSES, URGENCY } from '../src/schema.js';

// ---- chain-B v3 routing (returns a role) ----

test('emergency (חירום) → auto, regardless of cost', () => {
  assert.equal(whoApproves(10000, URGENCY.EMERGENCY), APPROVER.AUTO);
  assert.equal(whoApproves(50, URGENCY.EMERGENCY), APPROVER.AUTO);
  assert.equal(whoApproves('', URGENCY.EMERGENCY), APPROVER.AUTO);
});

test('every non-emergency request → ops_manager, whatever the cost (incl. blank / unknown)', () => {
  for (const cost of [0, 1, 500, 2999, 3000, 3001, 10000, 999999, '', null, undefined, 'abc']) {
    for (const urgency of [URGENCY.NORMAL, URGENCY.URGENT, '', undefined, 'לא ידוע']) {
      assert.equal(whoApproves(cost, urgency), APPROVER.OPS_MANAGER, `cost=${JSON.stringify(cost)} urgency=${JSON.stringify(urgency)}`);
    }
  }
});

test('the approver vocabulary is exactly auto | ops_manager — no field_ops tier, no ceo', () => {
  assert.deepEqual(Object.keys(APPROVER).sort(), ['AUTO', 'OPS_MANAGER']);
  assert.deepEqual(Object.values(APPROVER).sort(), ['auto', 'ops_manager']);
});

test('NO request ever routes to ceo or field_ops — exhaustive grid of cost × urgency × extra args', () => {
  const costs = [-1, 0, 1, 500, 3000, 3001, 1e6, '', null, undefined, '12', 'x'];
  const urgencies = [URGENCY.EMERGENCY, URGENCY.URGENT, URGENCY.NORMAL, '', null, undefined, 'ceo', 'field_ops'];
  // a legacy third argument (the old threshold) must not change the result either
  const extras = [undefined, 3000, 0, '3000', null];
  for (const c of costs) for (const u of urgencies) for (const t of extras) {
    const r = whoApproves(c, u, t);
    assert.notEqual(r, 'ceo', `ceo must never be an approver (cost=${c}, urgency=${u})`);
    assert.notEqual(r, 'field_ops', `field_ops must never be an approver (cost=${c}, urgency=${u})`);
    assert.ok(r === APPROVER.AUTO || r === APPROVER.OPS_MANAGER, `unexpected route ${r}`);
    assert.equal(r === APPROVER.AUTO, u === URGENCY.EMERGENCY, 'auto iff emergency');
  }
});

test('deferral wake-up re-routes through the same two rules and lands on ops_manager', () => {
  // A deferred request (נדחה לתאריך) wakes up and is re-decided: small, large, blank → ops_manager;
  // an emergency that was deferred → auto.
  for (const cost of [500, 4000, '']) assert.equal(whoApproves(cost, URGENCY.NORMAL), APPROVER.OPS_MANAGER);
  assert.equal(whoApproves(9000, URGENCY.EMERGENCY), APPROVER.AUTO);
  assert.ok(canTransition(STATUSES.DEFERRED, STATUSES.APPROVED), 'wake-up → approved is a legal move');
  assert.ok(canTransition(STATUSES.DEFERRED, STATUSES.NOT_APPROVED), 'wake-up → rejected is a legal move');
});

// ---- approval_required derivation (follows chain B v3) ----

test('approval_required: true for every non-emergency request, false only for the emergency auto path', () => {
  assert.equal(approvalRequired(4000, URGENCY.NORMAL), true);
  assert.equal(approvalRequired(3000, URGENCY.NORMAL), true);
  assert.equal(approvalRequired(500, URGENCY.NORMAL), true);
  assert.equal(approvalRequired('', URGENCY.NORMAL), true);
  assert.equal(approvalRequired(9000, URGENCY.EMERGENCY), false); // auto bypass
});

// ---- status transitions (unchanged) ----

test('legal transitions', () => {
  assert.ok(canTransition(STATUSES.REQUEST, STATUSES.APPROVED));
  assert.ok(canTransition(STATUSES.DEFERRED, STATUSES.APPROVED));    // wake-up
  assert.ok(canTransition(STATUSES.APPROVED, STATUSES.IN_PROGRESS));
  assert.ok(canTransition(STATUSES.IN_PROGRESS, STATUSES.COMPLETED));
  assert.ok(canTransition(STATUSES.COMPLETED, STATUSES.CLOSED));
});

test('illegal transitions rejected', () => {
  assert.equal(canTransition(STATUSES.REQUEST, STATUSES.COMPLETED), false);
  assert.equal(canTransition(STATUSES.NOT_APPROVED, STATUSES.APPROVED), false);
  assert.equal(canTransition(STATUSES.CLOSED, STATUSES.IN_PROGRESS), false);
});
