// test/approval.test.js — locks the heart of the app: the §6 approval chain (a–d) + status
// transitions. Increment 28 replaced the old Roy→Sandra threshold split with a role chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveApprover, approvalRequired, canApprove, canTransition, validateApproval,
} from '../src/approval.js';
import { STATUSES, URGENCY, ROLES } from '../src/schema.js';

const T = 3000;        // approval_threshold
const OPEN = false;    // house NOT pre-opening
const PRE = true;      // house IS pre-opening (טרום-פתיחה)
const NO_CEIL = '';    // ceo_ceiling disabled

// ---- resolveApprover: the chain a–d ----

test('d. otherwise → field_ops, including blank/unknown cost', () => {
  assert.equal(resolveApprover(500, URGENCY.NORMAL, OPEN, T, NO_CEIL), ROLES.FIELD_OPS);
  assert.equal(resolveApprover(3000, URGENCY.NORMAL, OPEN, T, NO_CEIL), ROLES.FIELD_OPS); // at threshold
  assert.equal(resolveApprover('', URGENCY.NORMAL, OPEN, T, NO_CEIL), ROLES.FIELD_OPS);   // blank
  assert.equal(resolveApprover(null, URGENCY.NORMAL, OPEN, T, NO_CEIL), ROLES.FIELD_OPS);
  assert.equal(resolveApprover(undefined, URGENCY.NORMAL, OPEN, T, NO_CEIL), ROLES.FIELD_OPS);
});

test('c. cost > approval_threshold → ops_manager', () => {
  assert.equal(resolveApprover(3001, URGENCY.NORMAL, OPEN, T, NO_CEIL), ROLES.OPS_MANAGER);
  assert.equal(resolveApprover(9000, URGENCY.NORMAL, OPEN, T, NO_CEIL), ROLES.OPS_MANAGER);
});

test('b. pre-opening house → ceo, regardless of amount (even blank)', () => {
  assert.equal(resolveApprover(50, URGENCY.NORMAL, PRE, T, NO_CEIL), ROLES.CEO);
  assert.equal(resolveApprover('', URGENCY.NORMAL, PRE, T, NO_CEIL), ROLES.CEO);
  assert.equal(resolveApprover(9000, URGENCY.NORMAL, PRE, T, NO_CEIL), ROLES.CEO);
});

test('a. emergency → auto, bypassing every other rule (even pre-opening)', () => {
  assert.equal(resolveApprover(9000, URGENCY.EMERGENCY, OPEN, T, NO_CEIL), 'auto');
  assert.equal(resolveApprover(50, URGENCY.EMERGENCY, PRE, T, '2000'), 'auto');
});

// ---- ceo_ceiling: disabled (blank) vs set ----

test('ceo_ceiling blank (disabled): a big non-emergency stays ops_manager, never ceo', () => {
  assert.equal(resolveApprover(100000, URGENCY.NORMAL, OPEN, T, ''), ROLES.OPS_MANAGER);
  assert.equal(resolveApprover(100000, URGENCY.NORMAL, OPEN, T, null), ROLES.OPS_MANAGER);
});

test('ceo_ceiling set: cost above it → ceo; at/below it → ops_manager (threshold rule)', () => {
  const CEIL = 5000;
  assert.equal(resolveApprover(5001, URGENCY.NORMAL, OPEN, T, CEIL), ROLES.CEO);
  assert.equal(resolveApprover(5000, URGENCY.NORMAL, OPEN, T, CEIL), ROLES.OPS_MANAGER); // == ceiling
  assert.equal(resolveApprover(4000, URGENCY.NORMAL, OPEN, T, CEIL), ROLES.OPS_MANAGER); // > threshold
  assert.equal(resolveApprover(500, URGENCY.NORMAL, OPEN, T, CEIL), ROLES.FIELD_OPS);    // under threshold
  assert.equal(resolveApprover('', URGENCY.NORMAL, OPEN, T, CEIL), ROLES.FIELD_OPS);     // blank never crosses
});

// ---- approvalRequired derived flag ----

test('approval_required: true iff resolved approver is ops_manager or ceo', () => {
  assert.equal(approvalRequired(4000, URGENCY.NORMAL, OPEN, T, NO_CEIL), true);  // ops_manager
  assert.equal(approvalRequired(50, URGENCY.NORMAL, PRE, T, NO_CEIL), true);     // ceo (pre-opening)
  assert.equal(approvalRequired(500, URGENCY.NORMAL, OPEN, T, NO_CEIL), false);  // field_ops
  assert.equal(approvalRequired(3000, URGENCY.NORMAL, OPEN, T, NO_CEIL), false); // at threshold → field_ops
  assert.equal(approvalRequired(9000, URGENCY.EMERGENCY, OPEN, T, NO_CEIL), false); // auto
  assert.equal(approvalRequired('', URGENCY.NORMAL, OPEN, T, NO_CEIL), false);   // blank → field_ops
});

// ---- canApprove: who may act on a resolved request ----

test('canApprove: only the resolved role, plus ceo can approve anything', () => {
  assert.equal(canApprove(ROLES.FIELD_OPS, ROLES.FIELD_OPS), true);
  assert.equal(canApprove(ROLES.OPS_MANAGER, ROLES.FIELD_OPS), false); // ops_manager ≠ field_ops tier
  assert.equal(canApprove(ROLES.FIELD_OPS, ROLES.OPS_MANAGER), false); // field_ops can't reach up
  assert.equal(canApprove(ROLES.OPS_MANAGER, ROLES.OPS_MANAGER), true);
  assert.equal(canApprove(ROLES.CEO, ROLES.OPS_MANAGER), true);        // ceo overrides
  assert.equal(canApprove(ROLES.CEO, ROLES.FIELD_OPS), true);
  assert.equal(canApprove(ROLES.FIELD_OPS, 'auto'), true);             // emergency: any actor
});

// ---- deferred wake-up: amount re-checked through a–d ----

test('deferred wake-up re-checks amount: small → field_ops, large → ops_manager, pre-opening → ceo', () => {
  // A deferred request is re-routed by exactly the same chain when it wakes up.
  assert.equal(resolveApprover(500, URGENCY.NORMAL, OPEN, T, NO_CEIL), ROLES.FIELD_OPS);
  assert.equal(resolveApprover(4000, URGENCY.NORMAL, OPEN, T, NO_CEIL), ROLES.OPS_MANAGER);
  assert.equal(resolveApprover(4000, URGENCY.NORMAL, PRE, T, NO_CEIL), ROLES.CEO);
  // And authority is enforced the same way on wake-up:
  assert.equal(canApprove(ROLES.FIELD_OPS, resolveApprover(4000, URGENCY.NORMAL, OPEN, T, NO_CEIL)), false);
});

// ---- status transitions (unchanged) ----

test('legal transitions', () => {
  assert.ok(canTransition(STATUSES.REQUEST, STATUSES.APPROVED));
  assert.ok(canTransition(STATUSES.DEFERRED, STATUSES.APPROVED));    // wake-up
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
  const req = { status: STATUSES.REQUEST };
  assert.equal(validateApproval(req, ROLES.FIELD_OPS, ROLES.FIELD_OPS), STATUSES.APPROVED);
});

test('validateApproval throws when the role is not the resolved approver', () => {
  const req = { status: STATUSES.REQUEST };
  assert.throws(() => validateApproval(req, ROLES.FIELD_OPS, ROLES.OPS_MANAGER), /not the resolved approver/);
});

test('validateApproval throws on an illegal status transition', () => {
  const req = { status: STATUSES.CLOSED };
  assert.throws(() => validateApproval(req, ROLES.CEO, ROLES.OPS_MANAGER), /Cannot approve/);
});
