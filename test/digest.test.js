// test/digest.test.js — locks the OpenTickets digest inclusion rule.
//
// The behavior under test: rejected (לא מאושר) requests stay in the digest for
// `archive_after_days` days after rejection — the SAME grace window as completed/closed — then
// drop out. A coordinator must see that a request was denied, not have it silently vanish.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDigestTicket, digestIncludeTicket, digestStatusTone, digestArchiveAnchor,
  selectDigestTickets, DIGEST_ARCHIVING_STATUSES,
} from '../src/digest.js';
import { STATUSES } from '../src/schema.js';

const S = STATUSES;
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-09T12:00:00.000Z');
const WINDOW = 7;

// Helper: an ISO timestamp `days` before NOW.
const ago = (days) => new Date(NOW.getTime() - days * DAY).toISOString();

// ---- live requests are always in the digest ----

test('live statuses are always included regardless of age', () => {
  for (const status of [S.REQUEST, S.PENDING_APPROVAL, S.APPROVED, S.DEFERRED, S.IN_PROGRESS]) {
    const req = { status, created_at: ago(999) };
    assert.equal(isDigestTicket(req, NOW, WINDOW), true, `${status} should be included`);
  }
});

// ---- the new behavior: rejected lingers, then drops ----

test('rejected request is VISIBLE within the window, with its red status', () => {
  const req = { status: S.NOT_APPROVED, rejected_at: ago(3), rejection_reason: 'יקר מדי' };
  assert.equal(isDigestTicket(req, NOW, WINDOW), true);
  // ...and it renders in red, so it reads as denied at a glance while it lingers.
  assert.equal(digestStatusTone(S.NOT_APPROVED), 'red');
});

test('rejected request DROPS OUT after the window', () => {
  const req = { status: S.NOT_APPROVED, rejected_at: ago(10) };
  assert.equal(isDigestTicket(req, NOW, WINDOW), false);
});

test('rejected request does NOT vanish immediately on rejection (day 0)', () => {
  const req = { status: S.NOT_APPROVED, rejected_at: NOW.toISOString() };
  assert.equal(isDigestTicket(req, NOW, WINDOW), true);
});

test('window boundary: visible just before, gone at/after exactly N days', () => {
  assert.equal(isDigestTicket({ status: S.NOT_APPROVED, rejected_at: ago(6.99) }, NOW, WINDOW), true);
  assert.equal(isDigestTicket({ status: S.NOT_APPROVED, rejected_at: ago(WINDOW) }, NOW, WINDOW), false);
  assert.equal(isDigestTicket({ status: S.NOT_APPROVED, rejected_at: ago(7.01) }, NOW, WINDOW), false);
});

// ---- rejected shares the completed/closed window ----

test('rejected ages on the same window as completed and closed', () => {
  for (const status of [S.NOT_APPROVED, S.COMPLETED, S.CLOSED]) {
    const inWindow = status === S.NOT_APPROVED
      ? { status, rejected_at: ago(2) }
      : { status, completed_at: ago(2) };
    const outWindow = status === S.NOT_APPROVED
      ? { status, rejected_at: ago(9) }
      : { status, completed_at: ago(9) };
    assert.equal(isDigestTicket(inWindow, NOW, WINDOW), true, `${status} in window`);
    assert.equal(isDigestTicket(outWindow, NOW, WINDOW), false, `${status} out of window`);
  }
  assert.ok(DIGEST_ARCHIVING_STATUSES.has(S.NOT_APPROVED));
});

// ---- aging anchor + fallbacks ----

test('rejection aging uses rejected_at, falling back to updated_at then created_at', () => {
  assert.equal(digestArchiveAnchor({ status: S.NOT_APPROVED, rejected_at: 'A', updated_at: 'B', created_at: 'C' }), 'A');
  assert.equal(digestArchiveAnchor({ status: S.NOT_APPROVED, updated_at: 'B', created_at: 'C' }), 'B');
  assert.equal(digestArchiveAnchor({ status: S.NOT_APPROVED, created_at: 'C' }), 'C');
});

test('a rejected row with no timestamp at all stays visible (fail-safe, never silently vanishes)', () => {
  assert.equal(isDigestTicket({ status: S.NOT_APPROVED }, NOW, WINDOW), true);
});

// ---- window is configurable ----

test('the window is driven by archive_after_days, not hardcoded', () => {
  const req = { status: S.NOT_APPROVED, rejected_at: ago(5) };
  assert.equal(isDigestTicket(req, NOW, 3), false); // 5 days old, 3-day window → gone
  assert.equal(isDigestTicket(req, NOW, 14), true); // 5 days old, 14-day window → still here
});

// ---- misc ----

test('unknown / missing status is excluded', () => {
  assert.equal(isDigestTicket({ status: 'not-a-real-status', created_at: ago(0) }, NOW, WINDOW), false);
  assert.equal(isDigestTicket({}, NOW, WINDOW), false);
  assert.equal(isDigestTicket(null, NOW, WINDOW), false);
});

test('digestIncludeTicket is an alias of isDigestTicket', () => {
  assert.equal(digestIncludeTicket, isDigestTicket);
});

test('selectDigestTickets keeps a fresh rejection and drops a stale one', () => {
  const rows = [
    { id: 'a', status: S.IN_PROGRESS, created_at: ago(30) },      // live → in
    { id: 'b', status: S.NOT_APPROVED, rejected_at: ago(1) },     // fresh reject → in
    { id: 'c', status: S.NOT_APPROVED, rejected_at: ago(20) },    // stale reject → out
    { id: 'd', status: S.COMPLETED, completed_at: ago(1) },       // fresh done → in
    { id: 'e', status: S.CLOSED, completed_at: ago(20) },         // stale done → out
  ];
  const ids = selectDigestTickets(rows, NOW, WINDOW).map((r) => r.id);
  assert.deepEqual(ids, ['a', 'b', 'd']);
});
