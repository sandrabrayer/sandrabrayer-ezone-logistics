// test/approval.test.js — locks the heart of the app: chain-B v2 routing + status transitions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whoApproves, approvalRequired, canTransition, APPROVER } from '../src/approval.js';
import { STATUSES, URGENCY } from '../src/schema.js';

const T = 3000; // approval_threshold

// ---- chain-B v2 routing (by AMOUNT only; returns a role) ----

test('emergency (חירום) → auto, regardless of cost', () => {
  assert.equal(whoApproves(10000, URGENCY.EMERGENCY, T), APPROVER.AUTO);
  assert.equal(whoApproves(50, URGENCY.EMERGENCY, T), APPROVER.AUTO);
  assert.equal(whoApproves('', URGENCY.EMERGENCY, T), APPROVER.AUTO);
});

test('cost > threshold → ops_manager', () => {
  assert.equal(whoApproves(3001, URGENCY.NORMAL, T), APPROVER.OPS_MANAGER);
  assert.equal(whoApproves(10000, URGENCY.NORMAL, T), APPROVER.OPS_MANAGER);
});

test('cost ≤ threshold → field_ops (incl. exactly at threshold)', () => {
  assert.equal(whoApproves(3000, URGENCY.NORMAL, T), APPROVER.FIELD_OPS);
  assert.equal(whoApproves(500, URGENCY.NORMAL, T), APPROVER.FIELD_OPS);
});

test('blank / unknown cost → field_ops', () => {
  assert.equal(whoApproves('', URGENCY.NORMAL, T), APPROVER.FIELD_OPS);
  assert.equal(whoApproves(null, URGENCY.NORMAL, T), APPROVER.FIELD_OPS);
  assert.equal(whoApproves(undefined, URGENCY.NORMAL, T), APPROVER.FIELD_OPS);
});

test('chain B v2 never returns ceo — routing is amount-only (pre-opening removed)', () => {
  // whatever the amount / urgency, the result is one of auto | ops_manager | field_ops.
  const results = [
    whoApproves(100, URGENCY.NORMAL, T),
    whoApproves(5000, URGENCY.NORMAL, T),
    whoApproves(9000, URGENCY.EMERGENCY, T),
  ];
  for (const r of results) assert.notEqual(r, 'ceo');
});

test('deferral wake-up re-check: small amount → field_ops, over-threshold amount → ops_manager', () => {
  assert.equal(whoApproves(500, URGENCY.NORMAL, T), APPROVER.FIELD_OPS);
  assert.equal(whoApproves(4000, URGENCY.NORMAL, T), APPROVER.OPS_MANAGER);
});

// ---- approval_required derivation (follows chain B v2) ----

test('approval_required: true iff routes to ops_manager', () => {
  assert.equal(approvalRequired(4000, URGENCY.NORMAL, T), true);   // ops_manager
  assert.equal(approvalRequired(3000, URGENCY.NORMAL, T), false);  // field_ops (at threshold)
  assert.equal(approvalRequired(500, URGENCY.NORMAL, T), false);   // field_ops
  assert.equal(approvalRequired('', URGENCY.NORMAL, T), false);    // field_ops (blank)
  assert.equal(approvalRequired(9000, URGENCY.EMERGENCY, T), false); // auto bypass
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
