// test/sla.test.js — SLA due-date derivation + aging (increment 36). These pure functions are
// mirrored verbatim in apps-script/Code.gs (MIRROR:sla) and drive the server, the digest and the UI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSlaSpec, slaDaysFor, deriveDueAt, daysOpen, isOverdue, daysOverdue, isBlocked, ticketAging,
  blockValidation,
} from '../src/sla.js';

const SPEC = 'חירום:1|דחוף:3|רגיל:14';   // the seeded default

// ---- spec parsing ----

test('parseSlaSpec parses urgency:days pairs; first-to-last', () => {
  assert.deepEqual(parseSlaSpec(SPEC), { 'חירום': 1, 'דחוף': 3, 'רגיל': 14 });
});

test('parseSlaSpec rejects malformed specs (→ null, never a wrong guess)', () => {
  assert.equal(parseSlaSpec(''), null);
  assert.equal(parseSlaSpec('רגיל'), null);          // no colon
  assert.equal(parseSlaSpec('רגיל:'), null);         // no days
  assert.equal(parseSlaSpec(':14'), null);           // no label
  assert.equal(parseSlaSpec('רגיל:0'), null);        // not > 0
  assert.equal(parseSlaSpec('רגיל:-3'), null);       // negative
  assert.equal(parseSlaSpec('רגיל:2.5'), null);      // not a whole number
  assert.equal(parseSlaSpec('רגיל:x'), null);        // NaN
  assert.equal(parseSlaSpec('דחוף:3|bad'), null);    // one bad pair fails the whole spec
});

// ---- due date derived per urgency ----

test('deriveDueAt: due date = created + days-for-urgency (UTC)', () => {
  const from = '2026-01-01T00:00:00.000Z';
  assert.equal(deriveDueAt(from, 'חירום', SPEC), '2026-01-02T00:00:00.000Z');   // +1
  assert.equal(deriveDueAt(from, 'דחוף', SPEC), '2026-01-04T00:00:00.000Z');    // +3
  assert.equal(deriveDueAt(from, 'רגיל', SPEC), '2026-01-15T00:00:00.000Z');    // +14
});

test('slaDaysFor: unknown urgency → null', () => {
  assert.equal(slaDaysFor(SPEC, 'רגיל'), 14);
  assert.equal(slaDaysFor(SPEC, 'לא-קיים'), null);
});

test('malformed sla_days → no due date AND logged (never a silently wrong default)', () => {
  const logs = [];
  const log = (m) => logs.push(m);
  assert.equal(deriveDueAt('2026-01-01T00:00:00Z', 'רגיל', 'this is not a spec', log), '');
  assert.equal(deriveDueAt('2026-01-01T00:00:00Z', 'לא-קיים', SPEC, log), '');   // unknown urgency
  assert.equal(logs.length, 2, 'both blank derivations must be logged');
});

// ---- days_open freezes at completion ----

test('daysOpen counts created_at → now, and FREEZES at completed_at', () => {
  const created = '2026-01-01T00:00:00Z';
  assert.equal(daysOpen(created, '', '2026-01-11T00:00:00Z'), 10);          // still open → 10 days
  assert.equal(daysOpen(created, '2026-01-05T00:00:00Z', '2026-01-30T00:00:00Z'), 4); // frozen at completion
  assert.equal(daysOpen(created, '', '2025-12-30T00:00:00Z'), 0);          // never negative
  assert.equal(daysOpen('bad', '', '2026-01-11T00:00:00Z'), null);
});

// ---- overdue semantics ----

const DUE = '2026-01-15T00:00:00Z';
const AFTER = '2026-01-20T00:00:00Z';
const BEFORE = '2026-01-10T00:00:00Z';

test('overdue only past due_at and only while ageing', () => {
  assert.equal(isOverdue(DUE, 'מאושר', AFTER), true);    // past due, active → overdue
  assert.equal(isOverdue(DUE, 'מאושר', BEFORE), false);  // before due → not
  assert.equal(isOverdue('', 'מאושר', AFTER), false);    // no due date → never overdue
});

test('completed / closed are never overdue', () => {
  assert.equal(isOverdue(DUE, 'הושלם', AFTER), false);
  assert.equal(isOverdue(DUE, 'סגור', AFTER), false);
});

test('a deferred request is NOT overdue while deferred (the SLA is parked)', () => {
  assert.equal(isOverdue(DUE, 'נדחה לתאריך', AFTER), false);
});

test('daysOverdue = whole days past due, 0 when not overdue', () => {
  assert.equal(daysOverdue(DUE, 'מאושר', AFTER), 5);
  assert.equal(daysOverdue(DUE, 'נדחה לתאריך', AFTER), 0);
  assert.equal(daysOverdue(DUE, 'מאושר', BEFORE), 0);
});

// ---- deferral wake-up: due_at re-derived from the deferral date FORWARD ----

test('on wake-up, due_at is re-derived from the deferral date forward (not from creation)', () => {
  // created long ago, deferred to 2026-03-01, woken as רגיל (+14) → due 2026-03-15, NOT creation+14.
  const deferredUntil = '2026-03-01T00:00:00Z';
  const wokenDue = deriveDueAt(deferredUntil, 'רגיל', SPEC);
  assert.equal(wokenDue, '2026-03-15T00:00:00.000Z');
  // Just after wake-up (still active) it is not yet overdue...
  assert.equal(isOverdue(wokenDue, 'מאושר', '2026-03-10T00:00:00Z'), false);
  // ...but once the NEW due date passes, a woken request IS overdue.
  assert.equal(isOverdue(wokenDue, 'מאושר', '2026-03-20T00:00:00Z'), true);
});

// ---- blocked flag ----

test('isBlocked reads the TRUE/FALSE cell; block requires a reason', () => {
  assert.equal(isBlocked('TRUE'), true);
  assert.equal(isBlocked('FALSE'), false);
  assert.equal(isBlocked(''), false);
  // blockValidation: blocking with no reason is rejected; unblocking needs none.
  assert.match(blockValidation(true, ''), /סיבה/);
  assert.match(blockValidation('TRUE', '   '), /סיבה/);
  assert.equal(blockValidation(true, 'ממתין לחלק'), null);
  assert.equal(blockValidation(false, ''), null);
});

test('a blocked request still ages and can still be overdue (blocked ≠ paused)', () => {
  // ticketAging reports blocked AND overdue independently.
  const req = { created_at: '2026-01-01T00:00:00Z', status: 'מאושר', due_at: DUE, blocked: 'TRUE' };
  const aging = ticketAging(req, AFTER);
  assert.equal(aging.blocked, true);
  assert.equal(aging.overdue, true);        // overdue despite being blocked
  assert.equal(aging.days_overdue, 5);
  assert.ok(aging.days_open >= 19);
});

test('ticketAging on a fresh, on-time request: open but not overdue, not blocked', () => {
  const req = { created_at: '2026-01-14T00:00:00Z', status: 'מאושר', due_at: DUE, blocked: 'FALSE' };
  const aging = ticketAging(req, '2026-01-14T12:00:00Z');
  assert.equal(aging.overdue, false);
  assert.equal(aging.blocked, false);
  assert.equal(aging.days_overdue, 0);
});
