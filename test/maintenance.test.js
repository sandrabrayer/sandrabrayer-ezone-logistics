// test/maintenance.test.js — the preventive-maintenance scheduler (תחזוקה מונעת) pure logic.
// Exercises next_due derivation, due/overdue, duplicate-prevention, request shaping, last_done
// write-back, inactive/malformed handling, 'all' expansion, and the panel's unavailable-vs-zero
// discipline. The SAME functions run in apps-script/Code.gs (mirror-drift.test.js guards the copy).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  maintNum, maintActive, maintDateOnly, addMonthsToDate, maintDaysBetween, planTaskStatus,
  parsePlanRow, expandHouses, maintenanceRequestInput, planLastDoneOnComplete,
  planGenerationPlan, planAdherence,
} from '../src/maintenance.js';

// Canonical id → Hebrew name (reverse of DIGEST_HOUSE_IDS_, per HOUSE-IDS.md).
const ID_TO_NAME = {
  'ramot-hashavim': 'רמות השבים',
  'raanana-asher': 'רעננה אשר',
  'pardes': 'רעננה הפרדס',
  'caesarea-ofroni': 'קיסריה עפרוני',
  'caesarea-rehab': 'קיסריה ריהאב',
  'sde-eliezer': 'שדה אליעזר',
};
const MAPS = { idToName: ID_TO_NAME };
// The five OPEN houses (רעננה הפרדס opened Aug 2026; only sde-eliezer is pre-opening in the seed).
const OPEN = ['ramot-hashavim', 'raanana-asher', 'pardes', 'caesarea-ofroni', 'caesarea-rehab'];
const NOW = '2026-07-31';
const logger = () => { const out = []; const fn = (m) => out.push(m); fn.out = out; return fn; };

// ---- primitives ----

test('maintNum accepts positive integers only; blank/zero/negative/fraction/junk → null', () => {
  assert.equal(maintNum('6'), 6);
  assert.equal(maintNum(12), 12);
  assert.equal(maintNum(''), null);
  assert.equal(maintNum(null), null);
  assert.equal(maintNum('0'), null);
  assert.equal(maintNum('-3'), null);
  assert.equal(maintNum('1.5'), null);
  assert.equal(maintNum('abc'), null);
});

test('maintActive: only explicit TRUE (any case) is active; blank/other is inactive', () => {
  assert.equal(maintActive('TRUE'), true);
  assert.equal(maintActive('true'), true);
  assert.equal(maintActive('FALSE'), false);
  assert.equal(maintActive(''), false);
  assert.equal(maintActive(null), false);
  assert.equal(maintActive('yes'), false);
});

test('maintDateOnly normalizes ISO/date strings and Date objects; blank/junk → ""', () => {
  assert.equal(maintDateOnly('2026-01-15'), '2026-01-15');
  assert.equal(maintDateOnly('2026-01-15T09:30:00.000Z'), '2026-01-15');
  assert.equal(maintDateOnly(new Date(Date.UTC(2026, 0, 15))).slice(0, 4), '2026');
  assert.equal(maintDateOnly(''), '');
  assert.equal(maintDateOnly(null), '');
  assert.equal(maintDateOnly('not a date'), '');
});

test('maintDateOnly parses Israeli DAY-FIRST text dates (d/m/y, d.m.y), never month-first', () => {
  // 12/7/2026 is 12 July (day-first) — NOT 7 December (US month-first).
  assert.equal(maintDateOnly('12/7/2026'), '2026-07-12');
  assert.equal(maintDateOnly('12.7.2026'), '2026-07-12');
  assert.equal(maintDateOnly('12.7.26'), '2026-07-12');       // 2-digit year → 20xx
  assert.equal(maintDateOnly('12/07/26'), '2026-07-12');
  assert.equal(maintDateOnly('1/2/2026'), '2026-02-01');      // 1 Feb, day-first
  assert.equal(maintDateOnly('31/12/2026'), '2026-12-31');    // valid end-of-year
  assert.equal(maintDateOnly(' 12/7/2026 '), '2026-07-12');   // trimmed
  // Impossible dates → '' (caller skips + logs).
  assert.equal(maintDateOnly('13/13/2026'), '');              // month 13
  assert.equal(maintDateOnly('31/2/2026'), '');               // Feb has no 31st
  assert.equal(maintDateOnly('0/7/2026'), '');                // day 0
});

test('addMonthsToDate adds months and clamps the day to the target month length', () => {
  assert.equal(addMonthsToDate('2026-01-15', 6), '2026-07-15');
  assert.equal(addMonthsToDate('2026-01-31', 1), '2026-02-28');   // clamp Feb
  assert.equal(addMonthsToDate('2026-11-30', 3), '2027-02-28');   // roll into next year + clamp
  assert.equal(addMonthsToDate('2024-01-31', 1), '2024-02-29');   // leap year
  assert.equal(addMonthsToDate('junk', 1), '');
});

test('maintDaysBetween is signed (to - from), 0 for equal, null for junk', () => {
  assert.equal(maintDaysBetween('2026-07-31', '2026-07-15'), -16);
  assert.equal(maintDaysBetween('2026-07-15', '2026-07-31'), 16);
  assert.equal(maintDaysBetween('2026-07-31', '2026-07-31'), 0);
  assert.equal(maintDaysBetween('junk', '2026-07-31'), null);
});

// ---- next_due derivation ----

test('planTaskStatus: overdue when nextDue is in the past', () => {
  const s = planTaskStatus('2026-01-15', 6, NOW);       // due 2026-07-15
  assert.equal(s.nextDue, '2026-07-15');
  assert.equal(s.daysUntil, -16);
  assert.equal(s.overdue, true);
});

test('planTaskStatus: not overdue when nextDue is in the future', () => {
  const s = planTaskStatus('2026-06-01', 6, NOW);       // due 2026-12-01
  assert.equal(s.nextDue, '2026-12-01');
  assert.ok(s.daysUntil > 0);
  assert.equal(s.overdue, false);
});

test('planTaskStatus: due EXACTLY today counts as overdue (daysUntil 0)', () => {
  const s = planTaskStatus('2026-01-31', 6, NOW);       // due 2026-07-31 == NOW
  assert.equal(s.nextDue, '2026-07-31');
  assert.equal(s.daysUntil, 0);
  assert.equal(s.overdue, true);
});

test('planTaskStatus: blank last_done (never done) → due immediately', () => {
  const s = planTaskStatus('', 6, NOW);
  assert.deepEqual(s, { nextDue: '', daysUntil: 0, overdue: true });
});

test('planTaskStatus: bad frequency → due immediately (never a silent default)', () => {
  assert.deepEqual(planTaskStatus('2026-01-15', 0, NOW), { nextDue: '', daysUntil: 0, overdue: true });
});

// ---- parsePlanRow validation ----

test('parsePlanRow: a well-formed row parses with normalized fields', () => {
  const log = logger();
  const p = parsePlanRow(
    { id: 'MP1', house: 'caesarea-ofroni', task: 'בדיקת מטפי כיבוי', frequency_months: '6',
      last_done: '2026-01-15T00:00:00.000Z', active: 'TRUE', notes: 'x' }, ID_TO_NAME, log);
  assert.deepEqual(p, {
    id: 'MP1', house: 'caesarea-ofroni', task: 'בדיקת מטפי כיבוי', frequency: 6,
    lastDone: '2026-01-15', active: true, notes: 'x',
  });
  assert.equal(log.out.length, 0);
});

test('parsePlanRow: the literal "all" house is accepted', () => {
  const p = parsePlanRow({ id: 'MP2', house: 'all', task: 'ניקוי מזגנים', frequency_months: 3, active: 'TRUE' }, ID_TO_NAME, logger());
  assert.equal(p.house, 'all');
});

test('parsePlanRow: malformed rows are skipped AND logged (missing id/task, bad freq, unknown house)', () => {
  const log = logger();
  assert.equal(parsePlanRow({ id: '', house: 'all', task: 't', frequency_months: 3 }, ID_TO_NAME, log), null);
  assert.equal(parsePlanRow({ id: 'A', house: 'all', task: '', frequency_months: 3 }, ID_TO_NAME, log), null);
  assert.equal(parsePlanRow({ id: 'B', house: 'all', task: 't', frequency_months: 'x' }, ID_TO_NAME, log), null);
  assert.equal(parsePlanRow({ id: 'C', house: 'nope', task: 't', frequency_months: 3 }, ID_TO_NAME, log), null);
  assert.equal(log.out.length, 4, 'each malformed row logs exactly once');
});

test('expandHouses: "all" → every open house; a specific id → itself', () => {
  assert.deepEqual(expandHouses('all', OPEN), OPEN);
  assert.deepEqual(expandHouses('caesarea-ofroni', OPEN), ['caesarea-ofroni']);
});

// ---- request shaping ----

test('maintenanceRequestInput: a NORMAL request (תיקון / רגיל) carrying plan_id + system author', () => {
  const input = maintenanceRequestInput({ planId: 'MP1', houseId: 'caesarea-ofroni', houseName: 'קיסריה עפרוני', task: 'בדיקת מטפי כיבוי' });
  assert.equal(input.category, 'תיקון');
  assert.equal(input.urgency, 'רגיל');
  assert.equal(input.house, 'קיסריה עפרוני');
  assert.equal(input.description, 'בדיקת מטפי כיבוי (תחזוקה מונעת)');
  assert.equal(input.created_by, 'מערכת - תחזוקה מונעת');
  assert.equal(input.plan_id, 'MP1');
  assert.equal(input.estimated_cost, '');
});

// ---- last_done write-back on completion ----

test('planLastDoneOnComplete: a completed plan-linked request → { planId, day }', () => {
  assert.deepEqual(
    planLastDoneOnComplete({ plan_id: 'MP1', completed_at: '2026-07-31T10:00:00.000Z' }),
    { planId: 'MP1', day: '2026-07-31' });
});

test('planLastDoneOnComplete: no plan_id or no completion date → null (a normal request is untouched)', () => {
  assert.equal(planLastDoneOnComplete({ plan_id: '', completed_at: '2026-07-31T10:00:00.000Z' }), null);
  assert.equal(planLastDoneOnComplete({ plan_id: 'MP1', completed_at: '' }), null);
  assert.equal(planLastDoneOnComplete(null), null);
});

// ---- generation pass ----

test('generation: a due active plan for a specific house creates ONE request carrying plan_id', () => {
  const plans = [{ id: 'MP1', house: 'caesarea-ofroni', task: 'בדיקת מטפי כיבוי', frequency_months: 6, last_done: '2026-01-15', active: 'TRUE' }];
  const g = planGenerationPlan(plans, [], OPEN, MAPS, NOW, logger());
  assert.equal(g.toCreate.length, 1);
  assert.deepEqual(g.toCreate[0], { planId: 'MP1', houseId: 'caesarea-ofroni', houseName: 'קיסריה עפרוני', task: 'בדיקת מטפי כיבוי' });
});

test('generation: a plan NOT yet due creates nothing', () => {
  const plans = [{ id: 'MP1', house: 'caesarea-ofroni', task: 't', frequency_months: 6, last_done: '2026-06-01', active: 'TRUE' }];
  const g = planGenerationPlan(plans, [], OPEN, MAPS, NOW, logger());
  assert.equal(g.toCreate.length, 0);
});

test('generation: a blank last_done (never done) is due immediately → one request', () => {
  const plans = [{ id: 'MP1', house: 'caesarea-ofroni', task: 't', frequency_months: 6, last_done: '', active: 'TRUE' }];
  const g = planGenerationPlan(plans, [], OPEN, MAPS, NOW, logger());
  assert.equal(g.toCreate.length, 1);
});

test('duplicate-prevention: an OPEN request with the same plan_id + house blocks a re-generation', () => {
  const plans = [{ id: 'MP1', house: 'caesarea-ofroni', task: 't', frequency_months: 6, last_done: '', active: 'TRUE' }];
  const requests = [{ id: 'REQ-1', plan_id: 'MP1', house: 'קיסריה עפרוני', status: 'דרישה' }];
  const g = planGenerationPlan(plans, requests, OPEN, MAPS, NOW, logger());
  assert.equal(g.toCreate.length, 0);
  assert.equal(g.skippedDuplicate, 1);
});

test('duplicate-prevention: a TERMINAL (הושלם) request does NOT block — the next cycle regenerates', () => {
  const plans = [{ id: 'MP1', house: 'caesarea-ofroni', task: 't', frequency_months: 6, last_done: '', active: 'TRUE' }];
  for (const st of ['הושלם', 'סגור', 'לא מאושר']) {
    const g = planGenerationPlan(plans, [{ id: 'R', plan_id: 'MP1', house: 'קיסריה עפרוני', status: st }], OPEN, MAPS, NOW, logger());
    assert.equal(g.toCreate.length, 1, `${st} must not block regeneration`);
  }
});

test('inactive plans never generate (counted separately)', () => {
  const plans = [{ id: 'MP1', house: 'caesarea-ofroni', task: 't', frequency_months: 6, last_done: '', active: 'FALSE' }];
  const g = planGenerationPlan(plans, [], OPEN, MAPS, NOW, logger());
  assert.equal(g.toCreate.length, 0);
  assert.equal(g.skippedInactive, 1);
});

test('"all" expands to every OPEN house — one request each, none for a duplicate open house', () => {
  const plans = [{ id: 'MPALL', house: 'all', task: 'ניקוי מזגנים', frequency_months: 3, last_done: '', active: 'TRUE' }];
  // Pretend one open house already has an open request for this plan.
  const requests = [{ id: 'R', plan_id: 'MPALL', house: 'רעננה אשר', status: 'בביצוע' }];
  const g = planGenerationPlan(plans, requests, OPEN, MAPS, NOW, logger());
  assert.equal(g.toCreate.length, OPEN.length - 1);
  assert.equal(g.skippedDuplicate, 1);
  assert.ok(g.toCreate.every((t) => t.planId === 'MPALL'));
  assert.deepEqual(g.toCreate.map((t) => t.houseId).sort(), ['caesarea-ofroni', 'caesarea-rehab', 'pardes', 'ramot-hashavim'].sort());
});

test('generation: malformed rows are skipped + logged; unknown house id never generates', () => {
  const log = logger();
  const plans = [
    { id: 'BAD1', house: 'caesarea-ofroni', task: 't', frequency_months: 'oops', last_done: '', active: 'TRUE' },
    { id: 'BAD2', house: 'atlantis', task: 't', frequency_months: 3, last_done: '', active: 'TRUE' },
  ];
  const g = planGenerationPlan(plans, [], OPEN, MAPS, NOW, log);
  assert.equal(g.toCreate.length, 0);
  assert.equal(g.skippedMalformed, 2);
  assert.equal(log.out.length, 2);
});

test('generation: two plan rows for the same plan+house within one pass do not double-create', () => {
  const plans = [
    { id: 'MP1', house: 'caesarea-ofroni', task: 't', frequency_months: 6, last_done: '', active: 'TRUE' },
    { id: 'MP1', house: 'caesarea-ofroni', task: 't', frequency_months: 6, last_done: '', active: 'TRUE' },
  ];
  const g = planGenerationPlan(plans, [], OPEN, MAPS, NOW, logger());
  assert.equal(g.toCreate.length, 1);
  assert.equal(g.skippedDuplicate, 1);
});

// ---- adherence panel ----

test('adherence: every OPEN house is listed; one with no plan row → planDefined:false (never a 0)', () => {
  const a = planAdherence([], MAPS, OPEN, NOW, logger());
  assert.equal(a.houses.length, OPEN.length);
  assert.ok(a.houses.every((h) => h.planDefined === false));
  assert.ok(a.houses.every((h) => h.tasks.length === 0 && h.overdueCount === 0));
});

test('adherence: tasks are worst-first (overdue first, then soonest-due) and overdueCount is right', () => {
  const plans = [
    { id: 'A', house: 'caesarea-ofroni', task: 'עתידי', frequency_months: 6, last_done: '2026-06-01', active: 'TRUE' }, // future
    { id: 'B', house: 'caesarea-ofroni', task: 'באיחור', frequency_months: 6, last_done: '2026-01-15', active: 'TRUE' }, // overdue
    { id: 'C', house: 'caesarea-ofroni', task: 'מעולם', frequency_months: 6, last_done: '', active: 'TRUE' },            // never → overdue
  ];
  const a = planAdherence(plans, MAPS, OPEN, NOW, logger());
  const house = a.houses.find((h) => h.id === 'caesarea-ofroni');
  assert.equal(house.planDefined, true);
  assert.equal(house.overdueCount, 2);
  assert.equal(house.tasks[0].overdue, true);
  assert.equal(house.tasks[house.tasks.length - 1].overdue, false); // future task sorts last
  // Houses are worst-first: the house with overdue tasks sorts ahead of clean ones.
  assert.equal(a.houses[0].id, 'caesarea-ofroni');
});

test('adherence: inactive plans are not tracked; malformed rows are skipped + counted', () => {
  const log = logger();
  const plans = [
    { id: 'X', house: 'caesarea-ofroni', task: 'inactive', frequency_months: 6, last_done: '', active: 'FALSE' },
    { id: '', house: 'caesarea-ofroni', task: 'bad', frequency_months: 6, last_done: '', active: 'TRUE' },
  ];
  const a = planAdherence(plans, MAPS, OPEN, NOW, log);
  assert.equal(a.skipped, 1);
  const house = a.houses.find((h) => h.id === 'caesarea-ofroni');
  assert.equal(house.planDefined, false); // inactive task not shown → house has no active plan
});

test('adherence: an "all" plan attaches its task to every open house', () => {
  const plans = [{ id: 'ALL', house: 'all', task: 'ניקוי מזגנים', frequency_months: 3, last_done: '', active: 'TRUE' }];
  const a = planAdherence(plans, MAPS, OPEN, NOW, logger());
  assert.ok(a.houses.every((h) => h.planDefined === true));
  assert.ok(a.houses.every((h) => h.tasks.some((t) => t.task === 'ניקוי מזגנים')));
});
