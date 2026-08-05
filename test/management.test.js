// test/management.test.js — the /management aggregation (Olga's ניהול תפעולי רשת) after the PR B
// cleanup: SLA/delays, recurring issues derived from REQUESTS, and two Logistics-owned readiness
// checklists (opening + emergency). Budget/maintenance/compliance are computed server-side and tested
// in their own suites; here we lock the pure OWNED-data shapers + the role gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildManagementSummary, requestsPanel, recurringDefectsPanel,
  openingReadinessPanel, emergencyReadinessPanel, isChecklistDone,
} from '../src/management.js';
import { isOverdue, isBlocked } from '../src/sla.js';
import { canManage, ROLE } from '../src/roles.js';

const NOW = new Date('2026-02-15T00:00:00Z');
const DAY = 86400000;
const ago = (days) => new Date(NOW.getTime() - days * DAY).toISOString();

const REQUESTS = [
  { id: 'R1', house: 'רמות השבים', status: 'מאושר', urgency: 'דחוף', due_at: '2026-02-10T00:00:00Z', blocked: 'FALSE', category: 'תיקון', description: 'ברז דולף', created_at: ago(5) },
  { id: 'R2', house: 'רמות השבים', status: 'בביצוע', urgency: 'רגיל', due_at: '2026-02-20T00:00:00Z', blocked: 'TRUE', category: 'תיקון', description: 'ברז דולף', created_at: ago(20) }, // recurs with R1 (same house+cat+desc)
  { id: 'R3', house: 'רעננה אשר', status: 'הושלם', category: 'החלפה', description: 'מזגן', created_at: ago(10) },
  { id: 'R4', house: 'רעננה אשר', status: 'לא מאושר', category: 'רכישה', description: 'ספה', created_at: ago(3) },
  { id: 'R5', house: 'רמות השבים', status: 'מאושר', urgency: 'רגיל', category: 'תיקון', description: 'ברז דולף', created_at: ago(200) }, // too old → not counted for recurrence
];

const HOUSES = [
  { name: 'רמות השבים', status: 'open' },
  { name: 'רעננה אשר', status: 'open' },
  { name: 'רעננה הפרדס', status: 'pre-opening' },
  { name: 'שדה אליעזר', status: 'pre-opening' },
];

const OPENING = [
  { house: 'רעננה הפרדס', item: 'חשמל מחובר', done: 'TRUE', date: '2026-02-10', by: 'רועי' },
  { house: 'רעננה הפרדס', item: 'ריהוט הותקן', done: 'FALSE', date: '', by: '' },
  { house: 'שדה אליעזר', item: 'חשמל מחובר', done: 'FALSE', date: '', by: '' },
  { house: 'רמות השבים', item: 'לא רלוונטי (בית פתוח)', done: 'TRUE', date: '', by: '' }, // open house → ignored
];

const EMERGENCY = [
  { house: 'רמות השבים', item: 'גנרטור', done: 'TRUE', date: '2026-01-01', by: 'רמי' },
  { house: 'רמות השבים', item: 'עזרה ראשונה', done: 'FALSE', date: '', by: '' },
  { house: 'רעננה אשר', item: 'גנרטור', done: 'TRUE', date: '2026-01-05', by: 'אורן' },
];

// ---- requests SLA / delays ----

test('requestsPanel: open / overdue / blocked counts, worst-first (isOverdue/isBlocked injected)', () => {
  const p = requestsPanel(REQUESTS, NOW, isOverdue, isBlocked);
  assert.equal(p.openCount, 3);       // R1, R2, R5 (R3 completed, R4 not-approved)
  assert.equal(p.overdueCount, 1);    // R1 only (due passed; R2 future, R5 no due_at)
  assert.equal(p.blockedCount, 1);    // R2
  assert.equal(p.worst[0].id, 'R1');
  assert.equal(p.worst[0].days_overdue, 5);
});

// ---- recurring issues from REQUESTS (simplified) ----

test('recurringDefectsPanel: same house + category + description ≥2 within 90 days → one recurring row', () => {
  const rows = recurringDefectsPanel(REQUESTS, NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].house, 'רמות השבים');
  assert.equal(rows[0].category, 'תיקון');
  assert.equal(rows[0].description, 'ברז דולף');
  assert.equal(rows[0].count, 2);     // R1 + R2 (R5 is 200 days old → outside the window)
});

test('recurringDefectsPanel: nothing recurs when each defect is unique → empty', () => {
  const rows = recurringDefectsPanel([
    { house: 'א', category: 'תיקון', description: 'דלת', created_at: ago(1) },
    { house: 'א', category: 'תיקון', description: 'חלון', created_at: ago(2) },
  ], NOW);
  assert.deepEqual(rows, []);
});

test('recurringDefectsPanel: description match is whitespace/case-insensitive, no scores or levels', () => {
  const rows = recurringDefectsPanel([
    { house: 'ב', category: 'תיקון', description: 'ברז  דולף', created_at: ago(1) },
    { house: 'ב', category: 'תיקון', description: 'ברז דולף ', created_at: ago(2) },
  ], NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 2);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['category', 'count', 'description', 'house']); // no severity/level/score
});

// ---- readiness checklists ----

test('isChecklistDone tolerates TRUE / true / 1 / boolean, and treats everything else as not done', () => {
  for (const v of ['TRUE', 'true', '1', true, 1]) assert.equal(isChecklistDone(v), true);
  for (const v of ['FALSE', '', '0', null, undefined, 'no']) assert.equal(isChecklistDone(v), false);
});

test('openingReadinessPanel: only pre-opening houses; per-house done/total + rows; open-house rows ignored', () => {
  const rows = openingReadinessPanel(HOUSES, OPENING);
  const byHouse = Object.fromEntries(rows.map((r) => [r.house, r]));
  assert.deepEqual(Object.keys(byHouse).sort(), ['רעננה הפרדס', 'שדה אליעזר'].sort()); // only pre-opening
  assert.equal(byHouse['רעננה הפרדס'].total, 2);
  assert.equal(byHouse['רעננה הפרדס'].done, 1);
  assert.equal(byHouse['שדה אליעזר'].done, 0);
  assert.equal(byHouse['שדה אליעזר'].total, 1);
});

test('openingReadinessPanel: a pre-opening house with no checklist rows reads total 0 (טרם הוזנה), never fabricated', () => {
  const rows = openingReadinessPanel(HOUSES, []);
  assert.ok(rows.every((r) => r.total === 0 && r.done === 0 && r.items.length === 0));
});

test('emergencyReadinessPanel: every house; per-house progress + rows carry item/done/date/by', () => {
  const rows = emergencyReadinessPanel(HOUSES, EMERGENCY);
  const byHouse = Object.fromEntries(rows.map((r) => [r.house, r]));
  assert.equal(rows.length, HOUSES.length);      // every house included
  assert.equal(byHouse['רמות השבים'].total, 2);
  assert.equal(byHouse['רמות השבים'].done, 1);
  const gen = byHouse['רמות השבים'].items.find((i) => i.item === 'גנרטור');
  assert.deepEqual(gen, { item: 'גנרטור', done: true, date: '2026-01-01', by: 'רמי' });
  assert.equal(byHouse['רעננה הפרדס'].total, 0); // no emergency rows yet → not fabricated
});

// ---- whole summary ----

test('buildManagementSummary bundles the owned-data panels only', () => {
  const m = buildManagementSummary(
    { requests: REQUESTS, houses: HOUSES, openingChecklist: OPENING, emergencyReadiness: EMERGENCY }, NOW, isOverdue, isBlocked);
  assert.ok(m.requests && m.recurringDefects && m.openingReadiness && m.emergencyReadiness);
  assert.equal(m.requests.openCount, 3);
  assert.equal(m.recurringDefects.length, 1);
  // No removed panels leak back in.
  for (const gone of ['defectClosure', 'houseQuality', 'spend', 'preOpening', 'unavailable', 'kitchen', 'training', 'events']) {
    assert.ok(!(gone in m), `${gone} must be gone from the summary`);
  }
});

test('empty inputs never crash and never fabricate', () => {
  const m = buildManagementSummary({}, NOW, isOverdue, isBlocked);
  assert.equal(m.requests.openCount, 0);
  assert.deepEqual(m.recurringDefects, []);
  assert.deepEqual(m.openingReadiness, []);
  assert.deepEqual(m.emergencyReadiness, []);
});

// ---- role gating (ops_manager + ceo only; field_ops and tier B get 403) ----

test('canManage: ops_manager and ceo pass; field_ops, coordinator, maintenance are refused', () => {
  assert.equal(canManage(ROLE.OPS_MANAGER), true);
  assert.equal(canManage(ROLE.CEO), true);
  assert.equal(canManage(ROLE.FIELD_OPS), false);
  assert.equal(canManage(ROLE.COORDINATOR), false);
  assert.equal(canManage(ROLE.MAINTENANCE), false);
});
