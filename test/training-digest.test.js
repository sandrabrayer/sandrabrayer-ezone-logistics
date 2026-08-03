// test/training-digest.test.js — pure shaping of the READ-ONLY coordinators digest (TrainingCompliance).
// Mirrored verbatim in apps-script/Code.gs (MIRROR:trainingdigest). Locks the DIGEST-CONTRACT.md
// discipline: read by header NAME (order-independent), omit houses not in the canonical id map, render
// "unavailable" (never 0) on a missing header / unreadable source, keep notRecorded DISTINCT (never ok),
// list guides worst-first, and distinguish a house absent from the digest from the digest being down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTrainingCompliance, trainingCompliancePanel, trainingFmtDate, trainingStatusRank } from '../src/training-digest.js';

// Canonical house id → city-first Hebrew display name (HOUSE-IDS.md).
const ID2NAME = {
  'ramot-hashavim': 'רמות השבים', 'raanana-asher': 'רעננה אשר', 'pardes': 'רעננה הפרדס',
  'caesarea-ofroni': 'קיסריה עפרוני', 'caesarea-rehab': 'קיסריה ריהאב', 'sde-eliezer': 'שדה אליעזר',
};
const HEADERS = ['house', 'guideName', 'firstAidStatus', 'firstAidDate', 'instructorStatus', 'instructorDate', 'overallStatus', 'updatedAt'];

// Build header-keyed row objects from a header row + value rows — mirrors how Code.gs objectsFromSheet_
// reads a real sheet, so we can prove the shaper reads BY NAME regardless of column order.
function toObjects(headers, values) {
  return values.map((row) => {
    const o = {};
    headers.forEach((h, i) => { o[h] = row[i]; });
    return o;
  });
}

test('reads columns BY HEADER NAME — identical result when the columns are reordered', () => {
  const a = toObjects(HEADERS,
    [['caesarea-ofroni', 'דנה', 'ok', '2026-01-05', 'ok', '2026-02-10', 'ok', 'x']]);
  const reordered = ['overallStatus', 'guideName', 'instructorDate', 'firstAidStatus', 'house', 'instructorStatus', 'firstAidDate', 'updatedAt'];
  const b = toObjects(reordered,
    [['ok', 'דנה', '2026-02-10', 'ok', 'caesarea-ofroni', 'ok', '2026-01-05', 'x']]);
  const ra = summarizeTrainingCompliance(a, ID2NAME);
  const rb = summarizeTrainingCompliance(b, ID2NAME);
  assert.deepEqual(ra, rb);
  const ofroni = ra.houses.find((h) => h.id === 'caesarea-ofroni');
  assert.equal(ofroni.house, 'קיסריה עפרוני'); // city-first display
  assert.equal(ofroni.hasData, true);
  assert.equal(ofroni.total, 1);
  assert.equal(ofroni.compliancePercent, 100);
  assert.equal(ofroni.guides[0].firstAidDate, '05/01/2026'); // dd/mm/yyyy
});

test('every canonical house gets an entry; an absent house is hasData:false ("אין נתונים"), never invisible', () => {
  const rows = toObjects(HEADERS, [['caesarea-ofroni', 'דנה', 'ok', '', 'ok', '', 'ok', '']]);
  const r = summarizeTrainingCompliance(rows, ID2NAME);
  assert.equal(r.available, true);
  assert.equal(r.houses.length, Object.keys(ID2NAME).length); // ALL houses present
  const ofroni = r.houses.find((h) => h.id === 'caesarea-ofroni');
  assert.equal(ofroni.hasData, true);
  const absent = r.houses.find((h) => h.id === 'sde-eliezer');
  assert.equal(absent.hasData, false); // absent from digest → distinct "no data for this house"
  assert.equal(absent.compliancePercent, null);
  assert.deepEqual(absent.guides, []);
});

test('notRecorded is DISTINCT and NEVER counted as ok (compliance percent excludes it)', () => {
  const rows = toObjects(HEADERS, [
    ['pardes', 'א', 'ok', '2026-01-01', 'ok', '2026-01-01', 'ok', ''],
    ['pardes', 'ב', 'notRecorded', '', 'notRecorded', '', 'notRecorded', ''],
    ['pardes', 'ג', 'ok', '2026-01-01', 'warn', '2026-01-01', 'warn', ''],
    ['pardes', 'ד', 'blocked', '', 'ok', '2026-01-01', 'blocked', ''],
  ]);
  const h = summarizeTrainingCompliance(rows, ID2NAME).houses.find((x) => x.id === 'pardes');
  assert.equal(h.total, 4);
  assert.deepEqual(h.counts, { ok: 1, warn: 1, blocked: 1, notRecorded: 1 });
  assert.equal(h.compliancePercent, 25); // ok(1) / total(4) — notRecorded is NOT ok
});

test('guides are listed worst-first: blocked, then notRecorded, then warn, then ok', () => {
  const rows = toObjects(HEADERS, [
    ['pardes', 'okGuide', 'ok', '', 'ok', '', 'ok', ''],
    ['pardes', 'warnGuide', 'warn', '', 'ok', '', 'warn', ''],
    ['pardes', 'notRecGuide', 'notRecorded', '', 'ok', '', 'notRecorded', ''],
    ['pardes', 'blockedGuide', 'blocked', '', 'ok', '', 'blocked', ''],
  ]);
  const h = summarizeTrainingCompliance(rows, ID2NAME).houses.find((x) => x.id === 'pardes');
  assert.deepEqual(h.guides.map((g) => g.overallStatus), ['blocked', 'notRecorded', 'warn', 'ok']);
});

test('"lacking" names which training is missing (first aid / instructor), ok → nothing lacking', () => {
  const rows = toObjects(HEADERS, [
    ['pardes', 'א', 'ok', '2026-01-01', 'notRecorded', '', 'notRecorded', ''],
    ['pardes', 'ב', 'blocked', '', 'warn', '', 'blocked', ''],
    ['pardes', 'ג', 'ok', '2026-01-01', 'ok', '2026-01-01', 'ok', ''],
  ]);
  const g = summarizeTrainingCompliance(rows, ID2NAME).houses.find((x) => x.id === 'pardes').guides;
  const byName = Object.fromEntries(g.map((x) => [x.guideName, x]));
  assert.deepEqual(byName['א'].lacking, ['הדרכת מדריכים']);
  assert.deepEqual(byName['ב'].lacking, ['עזרה ראשונה', 'הדרכת מדריכים']);
  assert.deepEqual(byName['ג'].lacking, []);
});

test('a house id NOT in the canonical map is OMITTED, never guessed', () => {
  const rows = toObjects(HEADERS, [
    ['caesarea-ofroni', 'דנה', 'ok', '', 'ok', '', 'ok', ''],
    ['some-unknown-house', 'רפאל', 'ok', '', 'ok', '', 'ok', ''],
    ['', 'ריק', 'ok', '', 'ok', '', 'ok', ''],
  ]);
  const r = summarizeTrainingCompliance(rows, ID2NAME);
  assert.ok(!r.houses.some((h) => h.id === 'some-unknown-house'));
  const ofroni = r.houses.find((h) => h.id === 'caesarea-ofroni');
  assert.equal(ofroni.hasData, true);
  assert.equal(ofroni.total, 1); // the unmapped + blank rows did not leak into any house
});

test('empty digest → available with EVERY house hasData:false (not an error, not a fabricated 0)', () => {
  const r = summarizeTrainingCompliance([], ID2NAME);
  assert.equal(r.available, true);
  assert.equal(r.houses.length, Object.keys(ID2NAME).length);
  assert.ok(r.houses.every((h) => h.hasData === false));
});

test('missing a required header on a non-empty digest → UNAVAILABLE (never 0)', () => {
  const rows = toObjects(['house', 'guideName', 'foo'], [['pardes', 'א', 'x']]);
  const r = summarizeTrainingCompliance(rows, ID2NAME);
  assert.equal(r.available, false);
  assert.ok(r.reason);
  assert.ok(!('houses' in r) || r.houses === undefined); // no fabricated shape
});

// ---- date formatting ----

test('trainingFmtDate: ISO → dd/mm/yyyy, blank → "", unparseable passes through', () => {
  assert.equal(trainingFmtDate('2026-03-09'), '09/03/2026');
  assert.equal(trainingFmtDate('2026-03-09T08:00:00Z'), '09/03/2026');
  assert.equal(trainingFmtDate(''), '');
  assert.equal(trainingFmtDate(null), '');
  assert.equal(trainingFmtDate('בקרוב'), 'בקרוב');
});

test('trainingStatusRank orders blocked < notRecorded < warn < ok < unknown', () => {
  assert.ok(trainingStatusRank('blocked') < trainingStatusRank('notRecorded'));
  assert.ok(trainingStatusRank('notRecorded') < trainingStatusRank('warn'));
  assert.ok(trainingStatusRank('warn') < trainingStatusRank('ok'));
  assert.ok(trainingStatusRank('ok') < trainingStatusRank('whatever'));
});

// ---- trainingCompliancePanel: the read-context → panel decision (all "unavailable" reasons in one place) ----

test('blank / missing config id → UNAVAILABLE, not zero', () => {
  const r = trainingCompliancePanel({ configured: false }, ID2NAME);
  assert.equal(r.available, false);
  assert.match(r.reason, /training_digest_id/);
});

test('a read failure (no access) → UNAVAILABLE, not zero, not a crash', () => {
  const r = trainingCompliancePanel({ configured: true, readError: true }, ID2NAME);
  assert.equal(r.available, false);
  assert.match(r.reason, /שגיאת קריאה/);
});

test('missing TrainingCompliance tab → UNAVAILABLE', () => {
  const r = trainingCompliancePanel({ configured: true, missingTab: true }, ID2NAME);
  assert.equal(r.available, false);
  assert.match(r.reason, /TrainingCompliance/);
});

test('configured + rows present → shaped summary (city-first names, worst-first guides)', () => {
  const r = trainingCompliancePanel(
    { configured: true, rows: toObjects(HEADERS, [['caesarea-rehab', 'מיה', 'warn', '2026-04-01', 'ok', '2026-04-01', 'warn', '']]) },
    ID2NAME);
  assert.equal(r.available, true);
  const h = r.houses.find((x) => x.id === 'caesarea-rehab');
  assert.equal(h.house, 'קיסריה ריהאב');
  assert.equal(h.guides[0].instructorDate, '01/04/2026');
});
