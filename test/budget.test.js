// test/budget.test.js — budget adherence (עמידה בתקציב). Pure logic mirrored into apps-script/Code.gs
// (MIRROR:budget). Locks: the attribution rule (actual vs estimated fallback, month bucketing,
// completed-vs-not, rejected/unmapped omitted), the adherence math, missing-budget → not-defined
// (never 0), and malformed budget rows skipped + logged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUDGET_TZ, periodInJerusalem, requestPeriod, requestActual, attributeRequest, parseBudgetRow, computeAdherence, budgetPeriods,
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

// ---- Israel-time month boundary (PR 4) ----

test('periodInJerusalem: the month flips at ISRAEL midnight, not UTC midnight (both directions, summer + winter)', () => {
  assert.equal(BUDGET_TZ, 'Asia/Jerusalem');
  // 31 Aug 22:30 UTC = 1 Sep 01:30 Israel (UTC+3, summer) → September
  assert.equal(periodInJerusalem('2026-08-31T22:30:00.000Z'), '2026-09');
  // 31 Aug 20:59 UTC = 31 Aug 23:59 Israel → still August
  assert.equal(periodInJerusalem('2026-08-31T20:59:00.000Z'), '2026-08');
  // 31 Dec 22:30 UTC = 1 Jan 00:30 Israel (UTC+2, winter) → January of the next year
  assert.equal(periodInJerusalem('2026-12-31T22:30:00.000Z'), '2027-01');
  assert.equal(periodInJerusalem('2026-12-31T21:30:00.000Z'), '2026-12');
  // a Date object (what Apps Script returns for a date cell) and a date-only string behave the same
  assert.equal(periodInJerusalem(new Date('2026-08-31T22:30:00.000Z')), '2026-09');
  assert.equal(periodInJerusalem('2026-08-31'), '2026-08');
  assert.equal(periodInJerusalem('2026-08-01'), '2026-08');
  // unparseable → its own YYYY-MM prefix; garbage / blank → ''
  assert.equal(periodInJerusalem('2026-05-notadate'), '2026-05');
  assert.equal(periodInJerusalem('bad'), '');
  assert.equal(periodInJerusalem(''), '');
  assert.equal(periodInJerusalem(null), '');
});

test('the spend month follows the Israel boundary: a request completed 22:30 UTC on 31 Aug is SEPTEMBER spend', () => {
  const r = { house: 'רמות השבים', status: 'הושלם', created_at: '2026-08-20T08:00:00.000Z', completed_at: '2026-08-31T22:30:00.000Z', actual_cost: 100 };
  assert.equal(requestPeriod(r), '2026-09');
  assert.equal(attributeRequest(r, NAME2ID).period, '2026-09');
  assert.equal(computeAdherence([], [r], MAPS, '2026-09').houses[0].actual, 100);
  assert.equal(computeAdherence([], [r], MAPS, '2026-08').houses.length, 0, 'not counted in August');
});

// ---- THE spend rule on fixtures (PR 4: one definition, the server's) ----

test('spend rule: completed → month of completion; not completed → month of creation; ANY non-rejected status counts', () => {
  const rows = [
    { house: 'רמות השבים', status: 'הושלם', created_at: '2026-02-10T08:00:00Z', completed_at: '2026-03-02T08:00:00Z', actual_cost: 100 }, // → March
    { house: 'רמות השבים', status: 'בביצוע', created_at: '2026-03-15T08:00:00Z', estimated_cost: 200 },                                    // open → March (created)
    { house: 'רמות השבים', status: 'מאושר', created_at: '2026-03-20T08:00:00Z', estimated_cost: 50 },                                      // approved, not started → March
    { house: 'רמות השבים', status: 'דרישה', created_at: '2026-02-28T08:00:00Z', estimated_cost: 999 },                                     // → February
    { house: 'רמות השבים', status: 'לא מאושר', created_at: '2026-03-01T08:00:00Z', estimated_cost: 5000 },                                 // rejected → never
  ];
  const mar = computeAdherence([], rows, MAPS, '2026-03');
  assert.equal(mar.houses[0].actual, 350, '100 actual + 200 + 50 estimated');
  assert.equal(mar.houses[0].usedEstimated, true);
  assert.equal(mar.usedEstimated, true);
  const feb = computeAdherence([], rows, MAPS, '2026-02');
  assert.equal(feb.houses[0].actual, 999);
  assert.equal(computeAdherence([], rows.filter((r) => r.status === 'לא מאושר'), MAPS, '2026-03').houses.length, 0, 'rejected is never spend');
});

test('spend rule: actual_cost wins over estimated_cost; 0 actual is a real 0; estimate-only flags the house', () => {
  const rows = [
    { house: 'רמות השבים', status: 'הושלם', created_at: '2026-03-01T08:00:00Z', completed_at: '2026-03-02T08:00:00Z', actual_cost: 0, estimated_cost: 900 },
    { house: 'רעננה אשר', status: 'הושלם', created_at: '2026-03-01T08:00:00Z', completed_at: '2026-03-02T08:00:00Z', actual_cost: '', estimated_cost: 400 },
  ];
  const r = computeAdherence([], rows, MAPS, '2026-03');
  const ramot = r.houses.find((h) => h.id === 'ramot-hashavim'), asher = r.houses.find((h) => h.id === 'raanana-asher');
  assert.equal(ramot.actual, 0); assert.equal(ramot.usedEstimated, false);
  assert.equal(asher.actual, 400); assert.equal(asher.usedEstimated, true);
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

test('malformed budget rows (bad period / non-numeric amount) are counted in `skipped`; an unknown house id is LISTED in unmappedHouses', () => {
  const logs = [];
  const bad = [
    { house: 'caesarea-ofroni', period: '2026/03', amount: 1000 }, // bad period format → skipped
    { house: 'caesarea-ofroni', period: '2026-03', amount: 'lots' }, // non-numeric → skipped
    { house: 'not-a-house', period: '2026-03', amount: 500 },        // unknown house id → unmapped (a typo, surfaced)
    { house: 'Ramot Hashavim', period: '2026-03', amount: 500 },     // a Hebrew/English name instead of the id → unmapped
    { house: 'caesarea-ofroni', period: '2026-03', amount: 1000 },   // the one good row
  ];
  const r = computeAdherence(bad, [], MAPS, '2026-03', (m) => logs.push(m));
  assert.equal(r.skipped, 2, 'only the malformed rows');
  assert.deepEqual(r.unmappedHouses, ['Ramot Hashavim', 'not-a-house'], 'unknown ids listed (sorted, unique)');
  assert.equal(logs.length, 4);
  assert.equal(r.houses.length, 1);
  assert.equal(r.houses[0].budget, 1000);
  assert.equal(r.usedEstimated, false);
});

test('a request whose house name maps to no canonical id is SURFACED in unmappedRequestHouses for that month (never counted, never silent)', () => {
  const rows = [
    { house: 'בית חדש', status: 'הושלם', created_at: '2026-03-01T08:00:00Z', completed_at: '2026-03-02T08:00:00Z', actual_cost: 700 },
    { house: 'בית חדש', status: 'לא מאושר', created_at: '2026-03-01T08:00:00Z', estimated_cost: 1 },  // rejected → not surfaced
    { house: 'בית אחר', status: 'דרישה', created_at: '2026-02-01T08:00:00Z', estimated_cost: 1 },      // other month → not surfaced here
  ];
  const r = computeAdherence([], rows, MAPS, '2026-03');
  assert.deepEqual(r.unmappedRequestHouses, ['בית חדש']);
  assert.equal(r.houses.length, 0, 'never counted under a guessed house');
  assert.deepEqual(computeAdherence([], rows, MAPS, '2026-02').unmappedRequestHouses, ['בית אחר']);
});

test('parseBudgetRow returns null (and logs) for a malformed row; a valid row parses', () => {
  const logs = [];
  assert.equal(parseBudgetRow({ house: 'x', period: 'nope', amount: 1 }, (m) => logs.push(m)), null);
  assert.equal(parseBudgetRow({ house: 'x', period: '2026-03', amount: '' }, (m) => logs.push(m)), null);
  assert.ok(logs.length >= 2);
  assert.deepEqual(parseBudgetRow({ house: 'caesarea-ofroni', period: '2026-03', amount: 1000 }), { houseId: 'caesarea-ofroni', period: '2026-03', amount: 1000 });
});

// ---- month selector list ----

test('budgetPeriods (month selector): ONLY months with a mapped Budgets row or spend, most-recent first — the current month is NOT added by itself', () => {
  assert.deepEqual(budgetPeriods(BUDGETS, REQUESTS, MAPS), ['2026-03', '2026-02']);
  assert.deepEqual(budgetPeriods([], [], MAPS), [], 'no data → no months');
  // an unmapped / malformed budget row does not create a month; a rejected request does not either
  const junk = [{ house: 'not-a-house', period: '2026-05', amount: 1 }, { house: 'caesarea-ofroni', period: '2026/06', amount: 1 }];
  const rejected = [{ house: 'רעננה אשר', status: 'לא מאושר', created_at: '2026-07-01T08:00:00Z', estimated_cost: 9 }];
  assert.deepEqual(budgetPeriods(junk, rejected, MAPS), []);
  // spend alone (no budget row) does create a month; a legacy 4th argument is ignored
  assert.deepEqual(budgetPeriods([], REQUESTS, MAPS, '2026-04'), ['2026-03']);
});
