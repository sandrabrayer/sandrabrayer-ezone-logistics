// test/management.test.js — the /management aggregation (increment 37), built ONLY from Logistics-
// owned data. Also locks the honesty rule: a metric with no source renders as unavailable, never 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildManagementSummary, requestsPanel, defectClosurePanel, houseQualityPanel, spendPanel,
  preOpeningPanel, unavailable, UNAVAILABLE_CAPABILITIES,
} from '../src/management.js';
import { canManage, ROLE } from '../src/roles.js';

const NOW = new Date('2026-02-15T00:00:00Z');

const REQUESTS = [
  { id: 'R1', house: 'רמות השבים', status: 'מאושר', urgency: 'דחוף', due_at: '2026-02-10T00:00:00Z', blocked: 'FALSE', estimated_cost: 1000, actual_cost: 0, category: 'תיקון', description: 'ברז' },
  { id: 'R2', house: 'רמות השבים', status: 'בביצוע', urgency: 'רגיל', due_at: '2026-02-20T00:00:00Z', blocked: 'TRUE', blocked_reason: 'ממתין לחלק', estimated_cost: 500, actual_cost: 0, category: 'רכישה', description: 'ספה' },
  { id: 'R3', house: 'רעננה אשר', status: 'הושלם', due_at: '2026-02-05T00:00:00Z', completed_at: '2026-02-04T00:00:00Z', estimated_cost: 2000, actual_cost: 1800, category: 'החלפה', description: 'מזגן' },
  { id: 'R4', house: 'רעננה אשר', status: 'הושלם', due_at: '2026-02-05T00:00:00Z', completed_at: '2026-02-09T00:00:00Z', estimated_cost: 300, actual_cost: 320, category: 'תיקון', description: 'דלת' },
  { id: 'R5', house: 'רעננה אשר', status: 'סגור', due_at: '', completed_at: '2026-02-01T00:00:00Z', estimated_cost: 0, actual_cost: 0, category: 'תיקון', description: 'צבע' },
  { id: 'R6', house: 'רמות השבים', status: 'לא מאושר', estimated_cost: 0, actual_cost: 0, category: 'רכישה', description: 'נדחה' },
];

const INSPECTIONS = [
  { id: 'I1', house: 'רמות השבים', inspection_date: '2026-02-01' },
  { id: 'I2', house: 'רעננה אשר', inspection_date: '2026-02-03' },
];

const FINDINGS = [
  { id: 'F1', inspection_id: 'I1', finding_type: 'physical_defect', severity: 'high', finding_text: 'נזילה במקלחת', linked_request_id: '' },
  { id: 'F2', inspection_id: 'I1', finding_type: 'physical_defect', severity: 'medium', finding_text: 'ידית שבורה', linked_request_id: 'R3' },
  { id: 'F3', inspection_id: 'I2', finding_type: 'physical_defect', severity: 'low', finding_text: 'נורה', linked_request_id: 'R4' },
  { id: 'F4', inspection_id: 'I1', finding_type: 'physical_defect', severity: 'high', finding_text: 'נזילה במקלחת', linked_request_id: '' }, // recurs with F1
  { id: 'F5', inspection_id: 'I2', finding_type: 'physical_defect', severity: 'low', finding_text: 'סדק', linked_request_id: 'R5' },       // closed, no due date
  { id: 'F6', inspection_id: 'I1', finding_type: 'process_note', severity: 'low', finding_text: 'הערה', linked_request_id: '' },          // NOT a defect
];

const HOUSES = [
  { name: 'רמות השבים', status: 'open' },
  { name: 'רעננה אשר', status: 'open' },
  { name: 'שדה אליעזר', status: 'pre-opening' },
];

const COUNTS = [{ house: 'שדה אליעזר', week_start: '2026-02-08', item: 'נייר טואלט', quantity_base: 10 }];

// ---- requests SLA / delays ----

test('requestsPanel: open / overdue / blocked counts, worst-first', () => {
  const p = requestsPanel(REQUESTS, NOW);
  assert.equal(p.openCount, 2);       // R1, R2 (R3/R4 completed, R5 closed, R6 not-approved)
  assert.equal(p.overdueCount, 1);    // R1 only (R2 due in the future)
  assert.equal(p.blockedCount, 1);    // R2
  assert.equal(p.worst[0].id, 'R1');
  assert.equal(p.worst[0].days_overdue, 5);
});

// ---- defect closure on time ----

test('defectClosurePanel: on-time vs late vs open; closed-without-due excluded from the rate', () => {
  const p = defectClosurePanel(FINDINGS, REQUESTS, NOW);
  assert.equal(p.totalDefects, 5);    // F1..F5 (process_note F6 excluded)
  assert.equal(p.open, 2);            // F1, F4 (unlinked)
  assert.equal(p.closedOnTime, 1);    // F2 → R3 completed before due
  assert.equal(p.closedLate, 1);      // F3 → R4 completed after due
  assert.equal(p.closedNoDueDate, 1); // F5 → R5 closed, no due date
  assert.deepEqual(p.onTimeRate, { available: true, value: 50 }); // 1 of 2 measured
});

test('onTimeRate is UNAVAILABLE (not 0%) when nothing has closed against a due date', () => {
  const p = defectClosurePanel(
    [{ id: 'X', finding_type: 'physical_defect', severity: 'high', finding_text: 'a', linked_request_id: '' }],
    REQUESTS, NOW);
  assert.equal(p.onTimeRate.available, false);
  assert.ok(p.onTimeRate.reason);
  assert.notEqual(p.onTimeRate.value, 0);   // must NOT be rendered as zero
});

// ---- house quality + recurring ----

test('houseQualityPanel: last inspection, open findings by severity, recurring defects', () => {
  const rows = houseQualityPanel(HOUSES, INSPECTIONS, FINDINGS, NOW);
  const ramot = rows.find((r) => r.house === 'רמות השבים');
  assert.equal(ramot.lastInspection, '2026-02-01');
  assert.equal(ramot.openFindings.high, 2);   // F1, F4 (both unlinked, high)
  assert.equal(ramot.recurringDefects, 1);    // "נזילה במקלחת" appears twice
  const raanana = rows.find((r) => r.house === 'רעננה אשר');
  assert.equal(raanana.openFindings.high, 0); // F3/F5 are linked → not open
  assert.equal(raanana.recurringDefects, 0);
  const sde = rows.find((r) => r.house === 'שדה אליעזר');
  assert.equal(sde.lastInspection, '');       // never inspected → blank, not a fake date
});

// ---- spend (owned cost); budget adherence unavailable ----

test('spendPanel totals owned cost; budget adherence is unavailable, never a fake number', () => {
  const p = spendPanel(REQUESTS);
  assert.equal(p.estimatedTotal, 3800);   // 1000+500+2000+300
  assert.equal(p.actualTotal, 2120);      // 1800+320
  assert.equal(p.budgetAdherence.available, false);
  assert.ok(p.budgetAdherence.reason);
});

// ---- pre-opening readiness ----

test('preOpeningPanel: only pre-opening houses; readiness facts', () => {
  const p = preOpeningPanel(HOUSES, REQUESTS, INSPECTIONS, FINDINGS, COUNTS);
  assert.equal(p.length, 1);
  assert.equal(p[0].house, 'שדה אליעזר');
  assert.equal(p[0].openRequests, 0);
  assert.equal(p[0].inventoryCounted, true);
});

// ---- whole summary + the unavailable list ----

test('buildManagementSummary bundles every panel and the unavailable-capabilities list', () => {
  const m = buildManagementSummary(
    { requests: REQUESTS, inspections: INSPECTIONS, findings: FINDINGS, houses: HOUSES, inventoryCounts: COUNTS }, NOW);
  assert.ok(m.requests && m.defectClosure && m.houseQuality && m.spend && m.preOpening);
  assert.equal(m.unavailable, UNAVAILABLE_CAPABILITIES);
  // budget, training, adoption, record-quality, preventive-maintenance remain unavailable.
  const keys = m.unavailable.map((u) => u.key);
  for (const k of ['budget_adherence', 'training_adherence', 'systems_adoption', 'record_quality', 'preventive_maintenance']) {
    assert.ok(keys.includes(k), `missing unavailable capability: ${k}`);
  }
  // food_quality is now a LIVE panel (kitchen digest read), NOT in the static unavailable list.
  assert.ok(!keys.includes('food_quality'), 'food_quality is now a live panel, not a static unavailable');
});

test('empty inputs never crash and never fabricate — counts are 0, rates are unavailable', () => {
  const m = buildManagementSummary({}, NOW);
  assert.equal(m.requests.openCount, 0);
  assert.equal(m.defectClosure.onTimeRate.available, false);  // no data → unavailable, NOT 0%
  assert.equal(m.spend.actualTotal, 0);
  assert.deepEqual(m.preOpening, []);
});

test('unavailable() marks a metric absent, distinct from a zero value', () => {
  const u = unavailable('no source');
  assert.equal(u.available, false);
  assert.equal(u.reason, 'no source');
  assert.notEqual(u.value, 0);
});

// ---- role gating (ops_manager + ceo only; field_ops and tier B get 403) ----

test('canManage: ops_manager and ceo pass; field_ops, coordinator, maintenance are refused', () => {
  assert.equal(canManage(ROLE.OPS_MANAGER), true);
  assert.equal(canManage(ROLE.CEO), true);
  assert.equal(canManage(ROLE.FIELD_OPS), false);   // manager tier elsewhere, but NOT on /management
  assert.equal(canManage(ROLE.COORDINATOR), false);
  assert.equal(canManage(ROLE.MAINTENANCE), false);
});
