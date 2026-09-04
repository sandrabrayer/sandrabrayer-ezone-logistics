// test/management.test.js — the simplified /management aggregation (PR B), built ONLY from Logistics-
// owned data: SLA/delays, recurring defects from Requests, and the opening/emergency readiness checklists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildManagementSummary, requestsPanel, recurringDefectsFromRequests, readinessByHouse, isDoneCell,
  RECURRENCE_WINDOW_DAYS, RECURRENCE_MIN,
  budgetTotalPercent, readinessPercent, readinessAveragePercent,
  preventiveCompletion, trainingsByHouse,
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
  { name: 'רעננה הפרדס', status: 'open' }, // opened Aug 2026
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
  // opening readiness only covers pre-opening houses — רעננה הפרדס opened (Aug 2026), so only שדה אליעזר
  assert.deepEqual(m.openingReadiness.map((h) => h.house), ['שדה אליעזר']);
  // emergency readiness covers every house, open and pre-opening alike
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

test('canManage: ONLY ops_manager passes; field_ops, coordinator, maintenance and a stale ceo are refused', () => {
  assert.equal(canManage(ROLE.OPS_MANAGER), true);
  assert.equal(canManage('ceo'), false);
  assert.equal(canManage(ROLE.FIELD_OPS), false);
  assert.equal(canManage(ROLE.COORDINATOR), false);
  assert.equal(canManage(ROLE.MAINTENANCE), false);
});

// ── Budget adherence (עמידה בתקציב): the SERVER rows are rendered as-is (PR 4); only the hub KPI is client-side ──

test('budgetTotalPercent: aggregate utilization over houses WITH a budget; a "not defined" house is listed but not summed; null when no budget', () => {
  assert.equal(budgetTotalPercent([{ budget: 1000, actual: 500 }, { budget: 1000, actual: 500 }]), 50);
  assert.equal(budgetTotalPercent([{ budget: 1000, actual: 500, budgetDefined: true }, { actual: 9999, budgetDefined: false }]), 50, 'no-budget spend has no denominator');
  assert.equal(budgetTotalPercent([{ actual: 300, budgetDefined: false }]), null);
  assert.equal(budgetTotalPercent([]), null);
});

test('no client-side spend recomputation exists any more (the server rule is the only one)', async () => {
  const mod = await import('../src/management.js');
  assert.equal('budgetAdherenceByHouse' in mod, false);
});

// ── Readiness percentages ──

test('readinessPercent + average', () => {
  assert.equal(readinessPercent({ total: 4, doneCount: 1 }), 25);
  assert.equal(readinessPercent({ total: 0, doneCount: 0 }), null);
  assert.equal(readinessAveragePercent([{ total: 4, doneCount: 2 }, { total: 2, doneCount: 2 }]), 75); // 50 + 100 / 2
  assert.equal(readinessAveragePercent([{ total: 0, doneCount: 0 }]), null);
});

// ── PreventiveDaily completion (per house per day) ──

test('preventiveCompletion: distinct done template items per house per date; template length is the total', () => {
  const template = ['a', 'b', 'c'];
  const houses = [{ name: 'א' }, { name: 'ב' }];
  const rows = [
    { house: 'א', date: '2026-02-14', item: 'a', done: 'TRUE' },
    { house: 'א', date: '2026-02-14', item: 'b', done: 'TRUE' },
    { house: 'א', date: '2026-02-14', item: 'a', done: 'TRUE' }, // dup item — counted once
    { house: 'א', date: '2026-02-13', item: 'a', done: 'FALSE' }, // not done
    { house: 'ב', date: '2026-02-14', item: 'a', done: 'TRUE' },
  ];
  const out = preventiveCompletion(rows, template, houses, ['2026-02-13', '2026-02-14']);
  const a = out.find(h => h.house === 'א');
  assert.deepEqual(a.days.map(d => [d.date, d.doneCount, d.total]), [['2026-02-13', 0, 3], ['2026-02-14', 2, 3]]);
  assert.equal(out.find(h => h.house === 'ב').days[1].doneCount, 1);
});

// ── Trainings grouping (מעקב הדרכות) ──

test('trainingsByHouse: grouped per house, newest-first; unmapped house omitted', () => {
  const houses = [{ name: 'א' }, { name: 'ב' }];
  const rows = [
    { id: 't1', house: 'א', topic: 'בטיחות', date: '2026-01-10', attended: 'צוות', by: 'אולגה' },
    { id: 't2', house: 'א', topic: 'עזרה ראשונה', date: '2026-02-01', attended: 'מדריכים', by: 'אולגה' },
    { id: 't3', house: 'לא-במיפוי', topic: 'x', date: '2026-02-02' },
  ];
  const out = trainingsByHouse(rows, houses);
  assert.deepEqual(out.map(h => h.house), ['א', 'ב']);
  assert.deepEqual(out.find(h => h.house === 'א').items.map(i => i.id), ['t2', 't1']); // newest first
  assert.equal(out.find(h => h.house === 'ב').items.length, 0);
});
