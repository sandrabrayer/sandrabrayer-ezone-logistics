// test/approval.test.js — locks the heart of the app: §6 routing + status transitions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  whoApproves, approvalRequired, canApprove, canTransition, validateApproval, APPROVERS,
} from '../src/approval.js';
import { STATUSES, URGENCY } from '../src/schema.js';

const T = 3000; // threshold

// ---- whoApproves: routing by amount ----

test('threshold boundary: exactly 3000 → Roy, 3001 → Sandra', () => {
  assert.equal(whoApproves(3000, URGENCY.NORMAL, T), 'roy');   // ≤ threshold
  assert.equal(whoApproves(3001, URGENCY.NORMAL, T), 'sandra'); // > threshold
});

test('below threshold → Roy, well above → Sandra', () => {
  assert.equal(whoApproves(500, URGENCY.NORMAL, T), 'roy');
  assert.equal(whoApproves(4000, URGENCY.NORMAL, T), 'sandra');
});

test('emergency bypasses approval regardless of cost', () => {
  assert.equal(whoApproves(10000, URGENCY.EMERGENCY, T), 'auto');
  assert.equal(whoApproves(50, URGENCY.EMERGENCY, T), 'auto');
});

test('blank/unknown cost → Roy (falls under threshold for routing)', () => {
  assert.equal(whoApproves('', URGENCY.NORMAL, T), 'roy');
  assert.equal(whoApproves(null, URGENCY.NORMAL, T), 'roy');
  assert.equal(whoApproves(undefined, URGENCY.NORMAL, T), 'roy');
});

// ---- approvalRequired derived flag ----

test('approval_required: true only when cost > threshold and not emergency', () => {
  assert.equal(approvalRequired(4000, URGENCY.NORMAL, T), true);
  assert.equal(approvalRequired(3000, URGENCY.NORMAL, T), false); // exactly at threshold
  assert.equal(approvalRequired(4000, URGENCY.EMERGENCY, T), false); // emergency bypass
  assert.equal(approvalRequired('', URGENCY.NORMAL, T), false);   // blank
});

// ---- canApprove: who is authorized ----

test('Roy cannot approve above threshold; Sandra can', () => {
  assert.equal(canApprove(APPROVERS.ROY, 4000, URGENCY.NORMAL, T), false);
  assert.equal(canApprove(APPROVERS.SANDRA, 4000, URGENCY.NORMAL, T), true);
});

test('Roy can approve at/under threshold', () => {
  assert.equal(canApprove(APPROVERS.ROY, 3000, URGENCY.NORMAL, T), true);
  assert.equal(canApprove(APPROVERS.ROY, 500, URGENCY.NORMAL, T), true);
  assert.equal(canApprove(APPROVERS.ROY, '', URGENCY.NORMAL, T), true); // blank → Roy
});

test('emergency can be approved by anyone (already auto-approved)', () => {
  assert.equal(canApprove(APPROVERS.ROY, 9000, URGENCY.EMERGENCY, T), true);
});

// ---- deferred wake-up: amount re-checked ----

test('deferred wake-up re-checks amount: 500 → Roy, 4000 → Sandra', () => {
  // On wake-up the same routing applies — a small deferred request is Roy's, a large one Sandra's.
  assert.equal(whoApproves(500, URGENCY.NORMAL, T), 'roy');
  assert.equal(whoApproves(4000, URGENCY.NORMAL, T), 'sandra');
  // And authority is enforced the same way on wake-up:
  assert.equal(canApprove(APPROVERS.ROY, 4000, URGENCY.NORMAL, T), false);
});

// ---- status transitions ----

test('legal transitions', () => {
  assert.ok(canTransition(STATUSES.REQUEST, STATUSES.APPROVED));
  assert.ok(canTransition(STATUSES.DEFERRED, STATUSES.APPROVED));   // wake-up
  assert.ok(canTransition(STATUSES.APPROVED, STATUSES.IN_PROGRESS)); // no separate "assigned"
  assert.ok(canTransition(STATUSES.IN_PROGRESS, STATUSES.COMPLETED));
  assert.ok(canTransition(STATUSES.COMPLETED, STATUSES.CLOSED));
});

test('illegal transitions rejected', () => {
  assert.equal(canTransition(STATUSES.REQUEST, STATUSES.COMPLETED), false); // can't skip approval
  assert.equal(canTransition(STATUSES.NOT_APPROVED, STATUSES.APPROVED), false); // terminal
  assert.equal(canTransition(STATUSES.CLOSED, STATUSES.IN_PROGRESS), false); // terminal
});

test('validateApproval returns APPROVED for an authorized, legal approval', () => {
  const req = { status: STATUSES.REQUEST, estimated_cost: 500, urgency: URGENCY.NORMAL };
  assert.equal(validateApproval(req, APPROVERS.ROY, T), STATUSES.APPROVED);
});

test('validateApproval throws when Roy tries to approve above threshold', () => {
  const req = { status: STATUSES.REQUEST, estimated_cost: 4000, urgency: URGENCY.NORMAL };
  assert.throws(() => validateApproval(req, APPROVERS.ROY, T), /not authorized/);
});

test('validateApproval throws on an illegal status transition', () => {
  const req = { status: STATUSES.CLOSED, estimated_cost: 500, urgency: URGENCY.NORMAL };
  assert.throws(() => validateApproval(req, APPROVERS.ROY, T), /Cannot approve/);
});
