// test/digest-consume.test.js — pure shaping of the READ-ONLY kitchen digest (FoodShortages).
// Mirrored verbatim in apps-script/Code.gs (MIRROR:digestconsume). Locks the DIGEST-CONTRACT.md
// discipline: read by header NAME (order-independent), omit houses not in the canonical id map, and
// render "unavailable" (never 0) on a missing header / unreadable source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeFoodShortages, foodShortagesPanel } from '../src/digest-consume.js';

// Canonical house id → city-first Hebrew display name (HOUSE-IDS.md).
const ID2NAME = {
  'ramot-hashavim': 'רמות השבים', 'raanana-asher': 'רעננה אשר', 'pardes': 'רעננה הפרדס',
  'caesarea-ofroni': 'קיסריה עפרוני', 'caesarea-rehab': 'קיסריה ריהאב', 'sde-eliezer': 'שדה אליעזר',
};

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
  const a = toObjects(['house', 'item'], [['caesarea-ofroni', 'אורז'], ['caesarea-ofroni', 'שמן'], ['pardes', 'קמח']]);
  const b = toObjects(['item', 'house'], [['אורז', 'caesarea-ofroni'], ['שמן', 'caesarea-ofroni'], ['קמח', 'pardes']]);
  const ra = summarizeFoodShortages(a, ID2NAME);
  const rb = summarizeFoodShortages(b, ID2NAME);
  assert.deepEqual(ra, rb);
  assert.equal(ra.available, true);
  // Sorted by (city-first) house name; counts + items grouped per house.
  const ofroni = ra.houses.find((h) => h.id === 'caesarea-ofroni');
  assert.equal(ofroni.house, 'קיסריה עפרוני');   // city-first display
  assert.equal(ofroni.count, 2);
  assert.deepEqual(ofroni.items, ['אורז', 'שמן']);
});

test('house-column and item-column ALIASES are accepted (house_id / product)', () => {
  const rows = toObjects(['product', 'house_id'], [['סוכר', 'sde-eliezer']]);
  const r = summarizeFoodShortages(rows, ID2NAME);
  assert.equal(r.available, true);
  assert.equal(r.houses[0].house, 'שדה אליעזר');
  assert.deepEqual(r.houses[0].items, ['סוכר']);
});

test('a house id NOT in the canonical map is OMITTED, never guessed', () => {
  const rows = toObjects(['house', 'item'], [['caesarea-ofroni', 'אורז'], ['some-unknown-house', 'קמח'], ['', 'מלח']]);
  const r = summarizeFoodShortages(rows, ID2NAME);
  assert.equal(r.houses.length, 1);
  assert.equal(r.houses[0].id, 'caesarea-ofroni');
  assert.ok(!r.houses.some((h) => h.id === 'some-unknown-house'));
});

test('empty tab → available with NO houses (not an error, not a fabricated 0)', () => {
  const r = summarizeFoodShortages([], ID2NAME);
  assert.equal(r.available, true);
  assert.deepEqual(r.houses, []);
});

test('missing the house/item header entirely → UNAVAILABLE (never 0)', () => {
  const r = summarizeFoodShortages(toObjects(['foo', 'bar'], [['x', 'y']]), ID2NAME);
  assert.equal(r.available, false);
  assert.ok(r.reason);
  assert.ok(!('houses' in r) || r.houses === undefined); // no fabricated shape
});

// ---- foodShortagesPanel: the read-context → panel decision (all "unavailable" reasons in one place) ----

test('blank / missing config id → UNAVAILABLE, not zero', () => {
  const r = foodShortagesPanel({ configured: false }, ID2NAME);
  assert.equal(r.available, false);
  assert.match(r.reason, /kitchen_digest_id/);
});

test('a read failure (no access) → UNAVAILABLE, not zero, not a crash', () => {
  const r = foodShortagesPanel({ configured: true, readError: true }, ID2NAME);
  assert.equal(r.available, false);
  assert.match(r.reason, /שגיאת קריאה/);
});

test('missing FoodShortages tab → UNAVAILABLE', () => {
  const r = foodShortagesPanel({ configured: true, missingTab: true }, ID2NAME);
  assert.equal(r.available, false);
  assert.match(r.reason, /FoodShortages/);
});

test('configured + rows present → shaped summary (city-first names)', () => {
  const r = foodShortagesPanel(
    { configured: true, rows: toObjects(['house', 'item'], [['caesarea-rehab', 'תה']]) }, ID2NAME);
  assert.equal(r.available, true);
  assert.equal(r.houses[0].house, 'קיסריה ריהאב');
});
