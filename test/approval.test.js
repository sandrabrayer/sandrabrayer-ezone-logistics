// test/approval.test.js — locks the heart of the app: chain-B routing + status transitions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  whoApproves, approvalRequired, canTransition, APPROVER,
} from '../src/approval.js';
import { STATUSES, URGENCY } from '../src/schema.js';

const T = 3000;          // approval_threshold
const OPEN = 'open';     // an open house
const PRE = 'טרום-פתיחה'; // a pre-opening house
const NO_CEILING = '';   // ceo_ceiling disabled

// ---- chain-B routing rules (each resolves to a ROLE, not a person) ----

test('rule 4 — normal cost under threshold, open house → field_ops', () => {
  assert.equal(whoApproves(500, URGENCY.NORMAL, OPEN, T, NO_CEILING), APPROVER.FIELD_OPS);
  assert.equal(whoApproves(3000, URGENCY.NORMAL, OPEN, T, NO_CEILING), APPROVER.FIELD_OPS); // exactly at threshold
});

test('rule 4 — blank/unknown cost → field_ops', () => {
  assert.equal(whoApproves('', URGENCY.NORMAL, OPEN, T, NO_CEILING), APPROVER.FIELD_OPS);
  assert.equal(whoApproves(null, URGENCY.NORMAL, OPEN, T, NO_CEILING), APPROVER.FIELD_OPS);
  assert.equal(whoApproves(undefined, URGENCY.NORMAL, OPEN, T, NO_CEILING), APPROVER.FIELD_OPS);
});

test('rule 3 — cost over threshold, open house, no ceiling → ops_manager', () => {
  assert.equal(whoApproves(3001, URGENCY.NORMAL, OPEN, T, NO_CEILING), APPROVER.OPS_MANAGER);
  assert.equal(whoApproves(10000, URGENCY.NORMAL, OPEN, T, NO_CEILING), APPROVER.OPS_MANAGER);
});

test('rule 2 — pre-opening house → ceo, even under threshold', () => {
  assert.equal(whoApproves(100, URGENCY.NORMAL, PRE, T, NO_CEILING), APPROVER.CEO);
  assert.equal(whoApproves('', URGENCY.NORMAL, PRE, T, NO_CEILING), APPROVER.CEO);
  // English 'pre-opening' (the value the Houses sheet historically stores) also routes to ceo.
  assert.equal(whoApproves(100, URGENCY.NORMAL, 'pre-opening', T, NO_CEILING), APPROVER.CEO);
});

test('rule 2 — ceo_ceiling set and cost exceeds it → ceo; blank ceiling → rule ignored', () => {
  // ceiling 5000: 6000 exceeds it → ceo (even though it is also over the ops_manager threshold)
  assert.equal(whoApproves(6000, URGENCY.NORMAL, OPEN, T, 5000), APPROVER.CEO);
  // at/under the ceiling but over the threshold → ops_manager (ceiling not exceeded)
  assert.equal(whoApproves(5000, URGENCY.NORMAL, OPEN, T, 5000), APPROVER.OPS_MANAGER);
  assert.equal(whoApproves(4000, URGENCY.NORMAL, OPEN, T, 5000), APPROVER.OPS_MANAGER);
  // blank ceiling → the ceiling rule is ignored; 6000 routes to ops_manager on the threshold alone
  assert.equal(whoApproves(6000, URGENCY.NORMAL, OPEN, T, NO_CEILING), APPROVER.OPS_MANAGER);
});

test('rule 1 — urgency חירום → auto (emergency bypass, no human approver), regardless of cost/house', () => {
  assert.equal(whoApproves(10000, URGENCY.EMERGENCY, OPEN, T, NO_CEILING), APPROVER.AUTO);
  assert.equal(whoApproves(50, URGENCY.EMERGENCY, PRE, T, 100), APPROVER.AUTO); // beats pre-opening + ceiling
});

// ---- deferral wake-up: amount re-checked through rules 1–4 from scratch ----

test('deferral wake-up re-check: small amount → field_ops, over-threshold amount → ops_manager', () => {
  assert.equal(whoApproves(500, URGENCY.NORMAL, OPEN, T, NO_CEILING), APPROVER.FIELD_OPS);
  assert.equal(whoApproves(4000, URGENCY.NORMAL, OPEN, T, NO_CEILING), APPROVER.OPS_MANAGER);
});

// ---- approval_required derivation follows chain B ----

test('approval_required: true iff the request escalates above field_ops (ops_manager or ceo)', () => {
  assert.equal(approvalRequired(500, URGENCY.NORMAL, OPEN, T, NO_CEILING), false); // field_ops
  assert.equal(approvalRequired('', URGENCY.NORMAL, OPEN, T, NO_CEILING), false);  // field_ops (blank)
  assert.equal(approvalRequired(4000, URGENCY.NORMAL, OPEN, T, NO_CEILING), true); // ops_manager
  assert.equal(approvalRequired(100, URGENCY.NORMAL, PRE, T, NO_CEILING), true);   // ceo (pre-opening)
  assert.equal(approvalRequired(9000, URGENCY.EMERGENCY, OPEN, T, NO_CEILING), false); // auto bypass
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
