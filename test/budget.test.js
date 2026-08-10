// test/budget.test.js — budget adherence (עמידה בתקציב). Pure logic mirrored into apps-script/Code.gs
// (MIRROR:budget). Locks: the attribution rule (actual vs estimated fallback, month bucketing,
// completed-vs-not, rejected/unmapped omitted), the adherence math, missing-budget → not-defined
// (never 0), and malformed budget rows skipped + logged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  requestPeriod, requestActual, attributeRequest, parseBudgetRow, computeAdherence, budgetPeriods,
} from '../src/budget.js';

// Hebrew house name → canonical id, and the reverse (HOUSE-IDS.md).
const NAME2ID = {
  'רמות השבים': 'ramot-hashavim', 'רעננה אשר': 'raanana-asher', 'רעננה הפרדס': 'pardes',
  'קיסריה עפרוני': 'caesarea-ofroni', 'קיסריה ריהאב': 'caesarea-rehab', 'שדה אליעזר': 'sde-eliezer',
};
const ID2NAME = Object.fromEntries(Object.entries(NAME2ID).map(([k, v]) => [v, k]));
const MAPS = { nameToId: NAME2ID, idToName: ID2NAME };

// ---- attribution rule ----

test('requestPeriod: completed_at month when completed, else created_at month', () => {
  assert.equal(requestPeriod({ created_at: '2026-01-20T00:00:00Z', completed_at: '2026-03-05T00:00:00Z' }), '2026-03');
  assert.equal(requestPeriod({ created_at: '2026-01-20T00:00:00Z', completed_at: '' }), '2026-01'); // not completed
  assert.equal(requestPeriod({ created_at: '2026-01-20T00:00:00Z' }), '2026-01');
  assert.equal(requestPeriod({ created_at: 'bad' }), '');
});

test('requestActual: actual_cost preferred; falls back to estimated_cost; flags which', () => {
  assert.deepEqual(requestActual({ actual_cost: 1800, estimated_cost: 2000 }), { amount: 1800, source: 'actual' });
  assert.deepEqual(requestActual({ actual_cost: '', estimated_cost: 2000 }), { amount: 2000, source: 'estimated' });
  assert.deepEqual(requestActual({ actual_cost: '', estimated_cost: '' }), { amount: null, source: null });
  assert.deepEqual(requestActual({ actual_cost: 0, estimated_cost: 999 }), { amount: 0, source: 'actual' }); // 0 is a real actual
});

test('attributeRequest: maps house→id, buckets month, omits rejected / unmapped / costless', () => {
  const base = { house: 'קיסריה עפרוני', status: 'הושלם', created_at: '2026-03-02T00:00:00Z', completed_at: '2026-03-10T00:00:00Z', actual_cost: 500 };
  assert.deepEqual(attributeRequest(base, NAME2ID), { houseId: 'caesarea-ofroni', period: '2026-03', amount: 500, source: 'actual' });
  assert.equal(attributeRequest({ ...base, status: 'לא מאושר' }, NAME2ID), null); // rejected → not spend
  assert.equal(attributeRequest({ ...base, house: 'בית לא ידוע' }, NAME2ID), null); // unmapped → omit
  assert.equal(attributeRequest({ ...base, actual_cost: '', estimated_cost: '' }, NAME2ID), null); // no cost
});

// ---- adherence math ----

const BUDGETS = [
  { house: 'caesarea-ofroni', period: '2026-03', amount: 1000, notes: '' },
  { house: 'raanana-asher', period: '2026-03', amount: 2000, notes: '' },
  { house: 'ramot-hashavim', period: '2026-02', amount: 5000, notes: '' }, // different month
];
const REQUESTS = [
  // caesarea-ofroni: 1200 actual in 2026-03 → OVER its 1000 budget
  { house: 'קיסריה עפרוני', status: 'הושלם', created_at: '2026-03-01T00:00:00Z', completed_at: '2026-03-08T00:00:00Z', actual_cost: 1200 },
  // raanana-asher: 500 (estimated fallback) in 2026-03 → under its 2000 budget
  { house: 'רעננה אשר', status: 'בביצוע', created_at: '2026-03-03T00:00:00Z', actual_cost: '', estimated_cost: 500 },
  // caesarea-rehab: 300 actual in 2026-03 but NO budget row → "not defined"
  { house: 'קיסריה ריהאב', status: 'הושלם', created_at: '2026-03-04T00:00:00Z', completed_at: '2026-03-06T00:00:00Z', actual_cost: 300 },
  // a rejected request that must NOT count as spend
  { house: 'רעננה אשר', status: 'לא מאושר', created_at: '2026-03-05T00:00:00Z', estimated_cost: 9999 },
];

test('computeAdherence: budget/actual/remaining/percent/over, worst-first', () => {
  const r = computeAdherence(BUDGETS, REQUESTS, MAPS, '2026-03');
  // worst-first: over-budget caesarea-ofroni first.
  assert.equal(r.houses[0].id, 'caesarea-ofroni');
  const ofroni = r.houses.find((h) => h.id === 'caesarea-ofroni');
  assert.deepEqual(
    { budget: ofroni.budget, actual: ofroni.actual, remaining: ofroni.remaining, percentUsed: ofroni.percentUsed, over: ofroni.over },
    { budget: 1000, actual: 1200, remaining: -200, percentUsed: 120, over: true });
  const asher = r.houses.find((h) => h.id === 'raanana-asher');
  assert.equal(asher.actual, 500);
  assert.equal(asher.percentUsed, 25);
  assert.equal(asher.over, false);
  assert.equal(asher.usedEstimated, true);   // fallback flagged
});

test('a house with spend but NO budget row → budgetDefined:false ("not defined"), never a fake 0', () => {
  const r = computeAdherence(BUDGETS, REQUESTS, MAPS, '2026-03');
  const rehab = r.houses.find((h) => h.id === 'caesarea-rehab');
  assert.ok(rehab, 'a house that spent money must appear even with no budget');
  assert.equal(rehab.budgetDefined, false);
  assert.equal(rehab.actual, 300);
  assert.ok(!('budget' in rehab), 'no fabricated budget');
  assert.ok(!('percentUsed' in rehab), 'no fabricated percent');
});

test('a house with a budget but no spend shows actual 0 (0 spend is real here, not "unavailable")', () => {
  const r = computeAdherence(
    [{ house: 'sde-eliezer', period: '2026-03', amount: 800 }], [], MAPS, '2026-03');
  assert.equal(r.houses.length, 1);
  assert.equal(r.houses[0].budget, 800);
  assert.equal(r.houses[0].actual, 0);
  assert.equal(r.houses[0].percentUsed, 0);
});

test('other months are not mixed in (month bucketing is strict)', () => {
  const r = computeAdherence(BUDGETS, REQUESTS, MAPS, '2026-02');
  // Only ramot-hashavim has a 2026-02 budget and no 2026-02 spend.
  assert.deepEqual(r.houses.map((h) => h.id), ['ramot-hashavim']);
  assert.equal(r.houses[0].actual, 0);
});

// ---- malformed budget rows: skipped + logged ----

test('malformed budget rows (bad period / non-numeric amount / unknown house) skipped and logged', () => {
  const logs = [];
  const bad = [
    { house: 'caesarea-ofroni', period: '2026/03', amount: 1000 }, // bad period format
    { house: 'caesarea-ofroni', period: '2026-03', amount: 'lots' }, // non-numeric
    { house: 'not-a-house', period: '2026-03', amount: 500 },        // unknown house id
    { house: 'caesarea-ofroni', period: '2026-03', amount: 1000 },   // the one good row
  ];
  const r = computeAdherence(bad, [], MAPS, '2026-03', (m) => logs.push(m));
  assert.equal(r.skipped, 3);
  assert.equal(logs.length, 3);
  assert.equal(r.houses.length, 1);
  assert.equal(r.houses[0].budget, 1000);
});

test('parseBudgetRow returns null (and logs) for a malformed row; a valid row parses', () => {
  const logs = [];
  assert.equal(parseBudgetRow({ house: 'x', period: 'nope', amount: 1 }, (m) => logs.push(m)), null);
  assert.equal(parseBudgetRow({ house: 'x', period: '2026-03', amount: '' }, (m) => logs.push(m)), null);
  assert.ok(logs.length >= 2);
  assert.deepEqual(parseBudgetRow({ house: 'caesarea-ofroni', period: '2026-03', amount: 1000 }), { houseId: 'caesarea-ofroni', period: '2026-03', amount: 1000 });
});

// ---- month selector list ----

test('budgetPeriods: union of budget + request periods and the current month, most-recent first', () => {
  const periods = budgetPeriods(BUDGETS, REQUESTS, MAPS, '2026-04');
  assert.deepEqual(periods, ['2026-04', '2026-03', '2026-02']);
});
