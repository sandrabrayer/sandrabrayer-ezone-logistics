// test/compliance.test.js — the compliance tracker (עמידה באמות מידה) pure logic. Exercises status
// derivation (valid / expiring / expired incl. the boundaries at exactly reminder_days and at 0),
// per-row reminder_days override, malformed/blank expires_at handling, duplicate-prevention, renewal
// request shaping (compliance_id + urgency דחוף/רגיל), inactive/malformed skipping, 'all' expansion,
// and the panel's unavailable-vs-zero discipline. The SAME functions run in apps-script/Code.gs
// (mirror-drift.test.js guards the copy).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as complianceNS from '../src/compliance.js';
import {
  complianceNum, complianceStatus, parseComplianceRow, complianceRequestInput,
  complianceGenerationPlan, complianceAdherence,
} from '../src/compliance.js';

const ID_TO_NAME = {
  'ramot-hashavim': 'רמות השבים',
  'raanana-asher': 'רעננה אשר',
  'pardes': 'רעננה הפרדס',
  'caesarea-ofroni': 'קיסריה עפרוני',
  'caesarea-rehab': 'קיסריה ריהאב',
  'sde-eliezer': 'שדה אליעזר',
};
const MAPS = { idToName: ID_TO_NAME };
const OPEN = ['ramot-hashavim', 'raanana-asher', 'caesarea-ofroni', 'caesarea-rehab'];
const NOW = '2026-07-31';
const DEF = 30; // Config default reminder window
const logger = () => { const out = []; const fn = (m) => out.push(m); fn.out = out; return fn; };

// ---- primitives ----

test('complianceNum accepts non-negative integers (incl. 0); blank/negative/fraction/junk → null', () => {
  assert.equal(complianceNum('30'), 30);
  assert.equal(complianceNum(0), 0);
  assert.equal(complianceNum('0'), 0);
  assert.equal(complianceNum(''), null);
  assert.equal(complianceNum(null), null);
  assert.equal(complianceNum('-5'), null);
  assert.equal(complianceNum('1.5'), null);
  assert.equal(complianceNum('soon'), null);
});

// ---- status derivation + boundaries ----

test('complianceStatus: valid when expiry is beyond the reminder window', () => {
  const s = complianceStatus('2026-09-29', DEF, NOW);   // 60 days out
  assert.equal(s.daysToExpiry, 60);
  assert.equal(s.status, 'בתוקף');
  assert.equal(s.expiring, false);
  assert.equal(s.expired, false);
});

test('complianceStatus: expiring at EXACTLY reminder_days (boundary, inclusive)', () => {
  const s = complianceStatus('2026-08-30', DEF, NOW);   // 30 days out == window
  assert.equal(s.daysToExpiry, 30);
  assert.equal(s.status, 'פג בקרוב');
  assert.equal(s.expiring, true);
  assert.equal(s.expired, false);
});

test('complianceStatus: expiring at EXACTLY 0 days (expires today → still valid-but-expiring, not expired)', () => {
  const s = complianceStatus('2026-07-31', DEF, NOW);   // today
  assert.equal(s.daysToExpiry, 0);
  assert.equal(s.status, 'פג בקרוב');
  assert.equal(s.expiring, true);
  assert.equal(s.expired, false);
});

test('complianceStatus: expired the day AFTER expiry (daysToExpiry < 0)', () => {
  const s = complianceStatus('2026-07-30', DEF, NOW);   // yesterday
  assert.equal(s.daysToExpiry, -1);
  assert.equal(s.status, 'פג תוקף');
  assert.equal(s.expired, true);
  assert.equal(s.expiring, false);
});

// ---- parse + per-row reminder override ----

test('parseComplianceRow: a well-formed row parses with normalized fields + effective reminder', () => {
  const p = parseComplianceRow(
    { id: 'C1', house: 'caesarea-ofroni', item: 'רישיון עסק', expires_at: '2026-09-01T00:00:00.000Z',
      reminder_days: '', doc_url: ' https://x/y ', notes: 'n', active: 'TRUE' }, ID_TO_NAME, DEF, logger());
  assert.deepEqual(p, {
    id: 'C1', house: 'caesarea-ofroni', item: 'רישיון עסק', expires: '2026-09-01',
    reminderDays: DEF, docUrl: 'https://x/y', notes: 'n', active: true,
  });
});

test('parseComplianceRow: a per-row reminder_days OVERRIDES the Config default', () => {
  const p = parseComplianceRow(
    { id: 'C1', house: 'all', item: 'ביטוח', expires_at: '2026-09-29', reminder_days: '90', active: 'TRUE' },
    ID_TO_NAME, DEF, logger());
  assert.equal(p.reminderDays, 90);
  // 60 days out is VALID under the 30-day default but EXPIRING under this row's 90-day window.
  assert.equal(complianceStatus(p.expires, DEF, NOW).status, 'בתוקף');
  assert.equal(complianceStatus(p.expires, p.reminderDays, NOW).status, 'פג בקרוב');
});

test('parseComplianceRow: a NON-blank but invalid reminder_days is logged and falls back to the default', () => {
  const log = logger();
  const p = parseComplianceRow(
    { id: 'C1', house: 'all', item: 'ביטוח', expires_at: '2026-09-01', reminder_days: 'soon', active: 'TRUE' },
    ID_TO_NAME, DEF, log);
  assert.equal(p.reminderDays, DEF);
  assert.equal(log.out.length, 1);
});

test('parseComplianceRow: malformed rows skipped + logged (missing id/item, blank/bad expires_at, unknown house)', () => {
  const log = logger();
  assert.equal(parseComplianceRow({ id: '', house: 'all', item: 'x', expires_at: '2026-09-01' }, ID_TO_NAME, DEF, log), null);
  assert.equal(parseComplianceRow({ id: 'A', house: 'all', item: '', expires_at: '2026-09-01' }, ID_TO_NAME, DEF, log), null);
  assert.equal(parseComplianceRow({ id: 'B', house: 'all', item: 'x', expires_at: '' }, ID_TO_NAME, DEF, log), null);
  assert.equal(parseComplianceRow({ id: 'C', house: 'all', item: 'x', expires_at: 'not-a-date' }, ID_TO_NAME, DEF, log), null);
  assert.equal(parseComplianceRow({ id: 'D', house: 'atlantis', item: 'x', expires_at: '2026-09-01' }, ID_TO_NAME, DEF, log), null);
  assert.equal(log.out.length, 5, 'each malformed row logs exactly once');
});

// ---- request shaping ----

test('complianceRequestInput: EXPIRED → urgency דחוף; carries compliance_id + system author + tagged description', () => {
  const input = complianceRequestInput({ complianceId: 'C1', houseId: 'caesarea-ofroni', houseName: 'קיסריה עפרוני', item: 'רישיון עסק', expired: true });
  assert.equal(input.category, 'תיקון');
  assert.equal(input.urgency, 'דחוף');
  assert.equal(input.house, 'קיסריה עפרוני');
  assert.equal(input.description, 'חידוש: רישיון עסק — קיסריה עפרוני (עמידה באמות מידה)');
  assert.equal(input.created_by, 'מערכת - אמות מידה');
  assert.equal(input.compliance_id, 'C1');
});

test('complianceRequestInput: EXPIRING (not yet expired) → urgency רגיל', () => {
  const input = complianceRequestInput({ complianceId: 'C1', houseId: 'caesarea-ofroni', houseName: 'קיסריה עפרוני', item: 'ביטוח', expired: false });
  assert.equal(input.urgency, 'רגיל');
});

// ---- generation pass ----

test('generation: an expiring active item creates ONE request (רגיל) carrying compliance_id', () => {
  const items = [{ id: 'C1', house: 'caesarea-ofroni', item: 'ביטוח', expires_at: '2026-08-30', active: 'TRUE' }]; // 30 days → expiring
  const g = complianceGenerationPlan(items, [], OPEN, MAPS, DEF, NOW, logger());
  assert.equal(g.toCreate.length, 1);
  assert.deepEqual(g.toCreate[0], { complianceId: 'C1', houseId: 'caesarea-ofroni', houseName: 'קיסריה עפרוני', item: 'ביטוח', expired: false });
});

test('generation: an expired active item is flagged expired (→ דחוף downstream)', () => {
  const items = [{ id: 'C1', house: 'caesarea-ofroni', item: 'רישיון עסק', expires_at: '2026-06-01', active: 'TRUE' }];
  const g = complianceGenerationPlan(items, [], OPEN, MAPS, DEF, NOW, logger());
  assert.equal(g.toCreate.length, 1);
  assert.equal(g.toCreate[0].expired, true);
});

test('generation: a still-VALID item creates nothing', () => {
  const items = [{ id: 'C1', house: 'caesarea-ofroni', item: 'ביטוח', expires_at: '2026-12-31', active: 'TRUE' }];
  const g = complianceGenerationPlan(items, [], OPEN, MAPS, DEF, NOW, logger());
  assert.equal(g.toCreate.length, 0);
});

test('duplicate-prevention: an OPEN request with the same compliance_id + house blocks re-generation', () => {
  const items = [{ id: 'C1', house: 'caesarea-ofroni', item: 'ביטוח', expires_at: '2026-08-30', active: 'TRUE' }];
  const requests = [{ id: 'R', compliance_id: 'C1', house: 'קיסריה עפרוני', status: 'ממתין לאישור' }];
  const g = complianceGenerationPlan(items, requests, OPEN, MAPS, DEF, NOW, logger());
  assert.equal(g.toCreate.length, 0);
  assert.equal(g.skippedDuplicate, 1);
});

test('duplicate-prevention: a TERMINAL request does NOT block — the item can regenerate', () => {
  const items = [{ id: 'C1', house: 'caesarea-ofroni', item: 'ביטוח', expires_at: '2026-08-30', active: 'TRUE' }];
  for (const st of ['הושלם', 'סגור', 'לא מאושר']) {
    const g = complianceGenerationPlan(items, [{ id: 'R', compliance_id: 'C1', house: 'קיסריה עפרוני', status: st }], OPEN, MAPS, DEF, NOW, logger());
    assert.equal(g.toCreate.length, 1, `${st} must not block regeneration`);
  }
});

test('inactive items never generate (counted separately)', () => {
  const items = [{ id: 'C1', house: 'caesarea-ofroni', item: 'ביטוח', expires_at: '2026-06-01', active: 'FALSE' }];
  const g = complianceGenerationPlan(items, [], OPEN, MAPS, DEF, NOW, logger());
  assert.equal(g.toCreate.length, 0);
  assert.equal(g.skippedInactive, 1);
});

test('"all" expands to every OPEN house — one request each, none for a duplicate open house', () => {
  const items = [{ id: 'CALL', house: 'all', item: 'בדיקת גז', expires_at: '2026-06-01', active: 'TRUE' }]; // expired everywhere
  const requests = [{ id: 'R', compliance_id: 'CALL', house: 'רעננה אשר', status: 'בביצוע' }];
  const g = complianceGenerationPlan(items, requests, OPEN, MAPS, DEF, NOW, logger());
  assert.equal(g.toCreate.length, OPEN.length - 1);
  assert.equal(g.skippedDuplicate, 1);
  assert.ok(g.toCreate.every((t) => t.complianceId === 'CALL' && t.expired === true));
});

test('generation: unknown house id + bad rows are skipped + logged (never generate)', () => {
  const log = logger();
  const items = [
    { id: 'B1', house: 'atlantis', item: 'x', expires_at: '2026-06-01', active: 'TRUE' },
    { id: 'B2', house: 'caesarea-ofroni', item: 'x', expires_at: '', active: 'TRUE' },
  ];
  const g = complianceGenerationPlan(items, [], OPEN, MAPS, DEF, NOW, log);
  assert.equal(g.toCreate.length, 0);
  assert.equal(g.skippedMalformed, 2);
  assert.equal(log.out.length, 2);
});

test('generation: two rows for the same compliance+house within one pass do not double-create', () => {
  const items = [
    { id: 'C1', house: 'caesarea-ofroni', item: 'ביטוח', expires_at: '2026-06-01', active: 'TRUE' },
    { id: 'C1', house: 'caesarea-ofroni', item: 'ביטוח', expires_at: '2026-06-01', active: 'TRUE' },
  ];
  const g = complianceGenerationPlan(items, [], OPEN, MAPS, DEF, NOW, logger());
  assert.equal(g.toCreate.length, 1);
  assert.equal(g.skippedDuplicate, 1);
});

test('completion does NOT touch expires_at: the module intentionally has NO write-back function', () => {
  // Unlike maintenance (planLastDoneOnComplete), compliance never writes back on completion — the new
  // expiry is on the new certificate, and Olga edits expires_at by hand. Guard that intent here.
  const names = Object.keys(complianceNS);
  assert.ok(!names.some((n) => /complete|lastdone|writeback|onhoshlam/i.test(n)),
    `compliance must expose no completion write-back; found: ${names.join(', ')}`);
});

// ---- adherence panel ----

test('adherence: every OPEN house is listed; one with no compliance row → defined:false (never a 0)', () => {
  const a = complianceAdherence([], MAPS, OPEN, DEF, NOW, logger());
  assert.equal(a.houses.length, OPEN.length);
  assert.ok(a.houses.every((h) => h.defined === false));
  assert.ok(a.houses.every((h) => h.items.length === 0 && h.expiredCount === 0 && h.expiringCount === 0));
});

test('adherence: items are worst-first (expired first, then soonest-to-expire); counts are right', () => {
  const items = [
    { id: 'A', house: 'caesarea-ofroni', item: 'עתידי', expires_at: '2026-12-31', active: 'TRUE' },      // valid
    { id: 'B', house: 'caesarea-ofroni', item: 'בקרוב', expires_at: '2026-08-10', active: 'TRUE' },       // expiring
    { id: 'C', house: 'caesarea-ofroni', item: 'פג', expires_at: '2026-06-01', active: 'TRUE' },          // expired
  ];
  const a = complianceAdherence(items, MAPS, OPEN, DEF, NOW, logger());
  const house = a.houses.find((h) => h.id === 'caesarea-ofroni');
  assert.equal(house.defined, true);
  assert.equal(house.expiredCount, 1);
  assert.equal(house.expiringCount, 1);
  assert.equal(house.items[0].item, 'פג');      // expired sorts first (most negative daysToExpiry)
  assert.equal(house.items[house.items.length - 1].item, 'עתידי'); // valid sorts last
  assert.equal(a.houses[0].id, 'caesarea-ofroni'); // house with the worst compliance sorts first
});

test('adherence: doc link is carried through; inactive not tracked; malformed skipped + counted', () => {
  const log = logger();
  const items = [
    { id: 'A', house: 'caesarea-ofroni', item: 'רישיון עסק', expires_at: '2026-08-10', doc_url: 'https://d/1', active: 'TRUE' },
    { id: 'X', house: 'caesarea-ofroni', item: 'inactive', expires_at: '2026-06-01', active: 'FALSE' },
    { id: '', house: 'caesarea-ofroni', item: 'bad', expires_at: '2026-06-01', active: 'TRUE' },
  ];
  const a = complianceAdherence(items, MAPS, OPEN, DEF, NOW, log);
  assert.equal(a.skipped, 1);
  const house = a.houses.find((h) => h.id === 'caesarea-ofroni');
  assert.equal(house.items.length, 1);
  assert.equal(house.items[0].docUrl, 'https://d/1');
});

test('adherence: an "all" item attaches to every open house', () => {
  const items = [{ id: 'ALL', house: 'all', item: 'תו תקן מטבח', expires_at: '2026-08-10', active: 'TRUE' }];
  const a = complianceAdherence(items, MAPS, OPEN, DEF, NOW, logger());
  assert.ok(a.houses.every((h) => h.defined === true));
  assert.ok(a.houses.every((h) => h.items.some((it) => it.item === 'תו תקן מטבח')));
});
