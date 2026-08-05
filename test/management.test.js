// test/management.test.js — the simplified /management aggregation (PR B), built ONLY from Logistics-
// owned data: SLA/delays, recurring defects from Requests, and the opening/emergency readiness checklists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildManagementSummary, requestsPanel, recurringDefectsFromRequests, readinessByHouse, isDoneCell,
  RECURRENCE_WINDOW_DAYS, RECURRENCE_MIN,
} from '../src/management.js';
import { canManage, ROLE } from '../src/roles.js';

const NOW = new Date('2026-02-15T00:00:00Z');
const iso = (d) => new Date(d).toISOString();

const REQUESTS = [
  { id: 'R1', house: 'רמות השבים', status: 'מאושר', urgency: 'דחוף', due_at: '2026-02-10T00:00:00Z', blocked: 'FALSE', created_at: '2026-02-01T00:00:00Z', category: 'תיקון', description: 'ברז דולף' },
  { id: 'R2', house: 'רמות השבים', status: 'בביצוע', urgency: 'רגיל', due_at: '2026-02-20T00:00:00Z', blocked: 'TRUE', blocked_reason: 'ממתין לחלק', created_at: '2026-02-03T00:00:00Z', category: 'רכישה', description: 'ספה' },
  { id: 'R3', house: 'רעננה אשר', status: 'הושלם', due_at: '2026-02-05T00:00:00Z', completed_at: '2026-02-04T00:00:00Z', created_at: '2026-01-20T00:00:00Z', category: 'החלפה', description: 'מזגן' },
  { id: 'R4', house: 'רעננה אשר', status: 'הושלם', due_at: '2026-02-05T00:00:00Z', completed_at: '2026-02-09T00:00:00Z', created_at: '2026-01-25T00:00:00Z', category: 'תיקון', description: 'דלת' },
  { id: 'R6', house: 'רמות השבים', status: 'לא מאושר', created_at: '2026-02-05T00:00:00Z', category: 'רכישה', description: 'נדחה' },
];

const HOUSES = [
  { name: 'רמות השבים', status: 'open' },
  { name: 'רעננה אשר', status: 'open' },
  { name: 'שדה אליעזר', status: 'pre-opening' },
  { name: 'רעננה הפרדס', status: 'pre-opening' },
];

// ---- requests SLA / delays ----

test('requestsPanel: open / overdue / blocked counts, worst-first', () => {
  const p = requestsPanel(REQUESTS, NOW);
  assert.equal(p.openCount, 2);            // R1 (מאושר) + R2 (בביצוע); R3/R4 done, R6 rejected
  assert.equal(p.overdueCount, 1);         // R1 due 02-10 < now 02-15; R2 due 02-20 not yet
  assert.equal(p.blockedCount, 1);         // R2 blocked
  assert.equal(p.worst[0].id, 'R1');
  assert.equal(p.worst[0].days_overdue, 5);
});

// ---- recurring defects (from Requests only) ----

test('recurringDefectsFromRequests: same house + category + description ≥2 in window → listed', () => {
  const reqs = [
    { id: 'A', house: 'רעננה אשר', category: 'תיקון', description: 'ברז דולף', created_at: iso('2026-02-01') },
    { id: 'B', house: 'רעננה אשר', category: 'תיקון', description: 'ברז דולף', created_at: iso('2026-02-10') },
    { id: 'C', house: 'רעננה אשר', category: 'תיקון', description: 'ברז דולף', created_at: iso('2026-02-14') },
    { id: 'D', house: 'רמות השבים', category: 'תיקון', description: 'ברז דולף', created_at: iso('2026-02-12') }, // different house → not grouped
    { id: 'E', house: 'רעננה אשר', category: 'רכישה', description: 'ספה', created_at: iso('2026-02-11') },       // one-off
  ];
  const out = recurringDefectsFromRequests(reqs, NOW);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { house: 'רעננה אשר', category: 'תיקון', description: 'ברז דולף', count: 3 });
});

test('recurringDefectsFromRequests: normalizes description (whitespace/case) but keeps houses distinct', () => {
  const reqs = [
    { id: 'A', house: 'בית', category: 'תיקון', description: 'ברז  דולף', created_at: iso('2026-02-01') },
    { id: 'B', house: 'בית', category: 'תיקון', description: 'ברז דולף', created_at: iso('2026-02-02') },
  ];
  const out = recurringDefectsFromRequests(reqs, NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].count, 2);
});

test('recurringDefectsFromRequests: only the trailing window counts (older repeats excluded)', () => {
  const reqs = [
    { id: 'A', house: 'בית', category: 'תיקון', description: 'x', created_at: iso('2025-10-01') }, // >90d before NOW
    { id: 'B', house: 'בית', category: 'תיקון', description: 'x', created_at: iso('2026-02-10') },
  ];
  assert.deepEqual(recurringDefectsFromRequests(reqs, NOW), []); // only 1 within window → not recurring
  assert.equal(RECURRENCE_WINDOW_DAYS, 90);
  assert.equal(RECURRENCE_MIN, 2);
});

test('recurringDefectsFromRequests: sorted most-recurring first; empty/no-house safe', () => {
  const reqs = [
    { id: 'A', house: 'ב1', category: 'תיקון', description: 'x', created_at: iso('2026-02-10') },
    { id: 'B', house: 'ב1', category: 'תיקון', description: 'x', created_at: iso('2026-02-11') },
    { id: 'C', house: 'ב2', category: 'תיקון', description: 'y', created_at: iso('2026-02-10') },
    { id: 'D', house: 'ב2', category: 'תיקון', description: 'y', created_at: iso('2026-02-11') },
    { id: 'E', house: 'ב2', category: 'תיקון', description: 'y', created_at: iso('2026-02-12') },
    { id: 'F', category: 'תיקון', description: 'no house', created_at: iso('2026-02-12') },
  ];
  const out = recurringDefectsFromRequests(reqs, NOW);
  assert.deepEqual(out.map((g) => [g.house, g.count]), [['ב2', 3], ['ב1', 2]]);
  assert.deepEqual(recurringDefectsFromRequests([], NOW), []);
  assert.deepEqual(recurringDefectsFromRequests(null, NOW), []);
});

// ---- readiness checklists (opening / emergency) ----

test('isDoneCell tolerates TRUE / true / 1 / boolean; everything else is not done', () => {
  ['TRUE', 'true', ' TRUE ', '1', 1, true].forEach((v) => assert.equal(isDoneCell(v), true, String(v)));
  ['FALSE', '', '0', 'no', null, undefined, 'כן'].forEach((v) => assert.equal(isDoneCell(v), false, String(v)));
});

test('readinessByHouse groups rows per house with done/total counts; unmapped house omitted', () => {
  const rows = [
    { id: '1', house: 'שדה אליעזר', item: 'מים', done: 'TRUE', date: '2026-02-01', by: 'רועי' },
    { id: '2', house: 'שדה אליעזר', item: 'חשמל', done: 'FALSE', date: '', by: '' },
    { id: '3', house: 'רעננה הפרדס', item: 'ריהוט', done: 'TRUE', date: '2026-02-02', by: 'אולגה' },
    { id: '4', house: 'בית לא במיפוי', item: 'x', done: 'TRUE' }, // omitted — not in houses list
  ];
  const houses = [{ name: 'שדה אליעזר' }, { name: 'רעננה הפרדס' }];
  const out = readinessByHouse(rows, houses);
  assert.deepEqual(out.map((h) => [h.house, h.doneCount, h.total]), [['שדה אליעזר', 1, 2], ['רעננה הפרדס', 1, 1]]);
  assert.equal(out[0].items[0].by, 'רועי');
});

test('readinessByHouse: houses with no rows appear empty (0/0), order follows the houses list', () => {
  const out = readinessByHouse([], [{ name: 'א' }, { name: 'ב' }]);
  assert.deepEqual(out, [
    { house: 'א', items: [], doneCount: 0, total: 0 },
    { house: 'ב', items: [], doneCount: 0, total: 0 },
  ]);
});

// ---- full summary ----

test('buildManagementSummary bundles SLA, recurring defects, and both readiness checklists', () => {
  const data = {
    requests: REQUESTS,
    houses: HOUSES,
    openingChecklist: [{ id: 'o1', house: 'שדה אליעזר', item: 'מים', done: 'TRUE', date: '2026-02-01', by: 'רועי' }],
    emergencyReadiness: [{ id: 'e1', house: 'רמות השבים', item: 'גנרטור', done: 'FALSE' }],
  };
  const m = buildManagementSummary(data, NOW);
  assert.ok(m.requests && typeof m.requests.openCount === 'number');
  assert.ok(Array.isArray(m.recurringDefects));
  // opening readiness only covers pre-opening houses (שדה אליעזר, רעננה הפרדס)
  assert.deepEqual(m.openingReadiness.map((h) => h.house), ['שדה אליעזר', 'רעננה הפרדס']);
  // emergency readiness covers every house
  assert.deepEqual(m.emergencyReadiness.map((h) => h.house), ['רמות השבים', 'רעננה אשר', 'שדה אליעזר', 'רעננה הפרדס']);
  // no removed panels leak back in
  assert.equal(m.defectClosure, undefined);
  assert.equal(m.houseQuality, undefined);
  assert.equal(m.spend, undefined);
  assert.equal(m.unavailable, undefined);
});

test('empty inputs never crash and never fabricate', () => {
  const m = buildManagementSummary({}, NOW);
  assert.equal(m.requests.openCount, 0);
  assert.deepEqual(m.recurringDefects, []);
  assert.deepEqual(m.openingReadiness, []);
  assert.deepEqual(m.emergencyReadiness, []);
});

test('canManage: ops_manager and ceo pass; field_ops, coordinator, maintenance are refused', () => {
  assert.equal(canManage(ROLE.OPS_MANAGER), true);
  assert.equal(canManage(ROLE.CEO), true);
  assert.equal(canManage(ROLE.FIELD_OPS), false);
  assert.equal(canManage(ROLE.COORDINATOR), false);
  assert.equal(canManage(ROLE.MAINTENANCE), false);
});
