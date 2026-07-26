// test/inventory.test.js — locks the WEEKLY inventory-count logic (increments 25–26).
// Validation here mirrors handleSubmitInventory_ in apps-script/Code.gs (the server is the gate).
//
// Scope (increment 26): Logistics owns ONLY טואלטיקה and חומרי ניקוי. Food (מזון) is owned by
// ezone-kitchen; Logistics does not count it. The seeded מזון catalog rows are kept active=FALSE
// so increment-25 history still resolves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  currentMonth, isValidMonth, isValidQuantity, formatMonthDisplay,
  weekStart, currentWeekStart, isValidWeekStart, monthFromWeekStart, formatWeekDisplay,
  recentWeekStarts, validateInventorySubmission, groupCatalog, latestCountFor, latestByHouse,
} from '../src/inventory.js';
import {
  HEADERS, INVENTORY_CATEGORIES, INVENTORY_COUNTERS, INVENTORY_HOUSE_COORDINATORS,
  SEED_INVENTORY_ITEMS,
} from '../src/schema.js';

// ---- schema ----

test('inventory sheets exist; week_start is APPENDED at the end (order preserved, no source col)', () => {
  assert.deepEqual(HEADERS.InventoryItems, ['category', 'item_text', 'active']);
  assert.deepEqual(HEADERS.InventoryCounts, [
    'count_id', 'house', 'month', 'counted_by', 'counted_at',
    'category', 'item', 'quantity', 'notes',
    'week_start',
  ]);
  // The original nine columns keep their exact positions; week_start is last.
  assert.equal(HEADERS.InventoryCounts[HEADERS.InventoryCounts.length - 1], 'week_start');
  assert.ok(!HEADERS.InventoryCounts.includes('source'));
});

test('categories are ONLY טואלטיקה / חומרי ניקוי (food is owned by ezone-kitchen)', () => {
  assert.deepEqual(INVENTORY_CATEGORIES, ['טואלטיקה', 'חומרי ניקוי']);
  assert.ok(!INVENTORY_CATEGORIES.includes('מזון'));
});

test('counters are the coordinators + backstop', () => {
  assert.deepEqual(INVENTORY_COUNTERS, ['שירה', 'יעקב', 'אורן', 'אביב', 'צחי', 'רועי', 'רמי']);
  assert.ok(INVENTORY_COUNTERS.includes('רמי'));  // backstop
  assert.ok(INVENTORY_COUNTERS.includes('צחי'));  // backstop + שדה אליעזר coordinator
});

test('each open/pre-opening house maps to its coordinator', () => {
  assert.deepEqual(INVENTORY_HOUSE_COORDINATORS, {
    'קיסריה עפרוני': 'שירה', 'ריהאב': 'יעקב', 'רעננה': 'אורן',
    'רמות השבים': 'אביב', 'שדה אליעזר': 'צחי',
  });
  for (const who of Object.values(INVENTORY_HOUSE_COORDINATORS)) {
    assert.ok(INVENTORY_COUNTERS.includes(who), `${who} must be an accepted counter`);
  }
});

test('seed catalog: active items are Logistics-only; מזון rows kept but retired (active=FALSE)', () => {
  assert.ok(SEED_INVENTORY_ITEMS.length >= 20);
  const active = SEED_INVENTORY_ITEMS.filter((i) => i.active === 'TRUE');
  const foods = SEED_INVENTORY_ITEMS.filter((i) => i.category === 'מזון');
  // Every ACTIVE seed item is in a Logistics category.
  for (const it of active) {
    assert.ok(INVENTORY_CATEGORIES.includes(it.category), `active item wrong category: ${it.item_text}`);
  }
  // The מזון rows still exist (history resolves) but are ALL inactive.
  assert.ok(foods.length >= 10);
  assert.ok(foods.every((i) => i.active === 'FALSE'), 'all מזון seed rows must be active=FALSE');
  // נייר טואלט stays an active Logistics item.
  assert.ok(active.some((i) => i.item_text === 'נייר טואלט'));
});

// ---- month primitives (historical rows + derived month column) ----

test('currentMonth formats YYYY-MM (zero-padded)', () => {
  assert.equal(currentMonth(new Date('2026-07-16T10:00:00Z')), '2026-07');
  assert.equal(currentMonth(new Date('2026-01-05T10:00:00Z')), '2026-01');
});

test('isValidMonth accepts YYYY-MM only', () => {
  assert.equal(isValidMonth('2026-07'), true);
  assert.equal(isValidMonth('2026-13'), false);
  assert.equal(isValidMonth('2026-7'), false);
  assert.equal(isValidMonth('07-2026'), false);
  assert.equal(isValidMonth(''), false);
  assert.equal(isValidMonth(undefined), false);
});

test('formatMonthDisplay renders YYYY-MM as MM/YYYY (LTR-safe, month-first)', () => {
  assert.equal(formatMonthDisplay('2026-07'), '07/2026');
  assert.equal(formatMonthDisplay('2026-01'), '01/2026');
  assert.equal(formatMonthDisplay('2099-12'), '12/2099');
  assert.equal(formatMonthDisplay('2026-7'), '2026-7');
  assert.equal(formatMonthDisplay('July'), 'July');
  assert.equal(formatMonthDisplay(''), '');
  assert.equal(formatMonthDisplay(null), '');
  assert.equal(formatMonthDisplay(undefined), '');
});

// ---- week primitives (Sunday-based Israeli week) ----

test('weekStart returns the Sunday that begins the week (UTC)', () => {
  assert.equal(weekStart('2026-07-25'), '2026-07-19');           // Saturday → Sunday 07-19
  assert.equal(weekStart('2026-07-19'), '2026-07-19');           // a Sunday maps to itself
  assert.equal(weekStart('2026-07-22'), '2026-07-19');           // a Wednesday
  assert.equal(weekStart('2026-07-25T13:45:00Z'), '2026-07-19'); // full ISO timestamp
  assert.equal(weekStart('not-a-date'), '');
});

test('currentWeekStart is the Sunday of the week containing now', () => {
  assert.equal(currentWeekStart(new Date('2026-07-25T10:00:00Z')), '2026-07-19');
  assert.equal(currentWeekStart(new Date('2026-07-19T00:00:00Z')), '2026-07-19');
});

test('isValidWeekStart: well-formed YYYY-MM-DD that is ALSO a Sunday', () => {
  assert.equal(isValidWeekStart('2026-07-19'), true);   // Sunday
  assert.equal(isValidWeekStart('2026-07-20'), false);  // Monday — rejected
  assert.equal(isValidWeekStart('2026-07-25'), false);  // Saturday — rejected
  assert.equal(isValidWeekStart('2026-7-19'), false);   // not zero-padded
  assert.equal(isValidWeekStart('2026-07'), false);     // month, not a date
  assert.equal(isValidWeekStart(''), false);
  assert.equal(isValidWeekStart(undefined), false);
});

test('monthFromWeekStart derives the YYYY-MM of the Sunday', () => {
  assert.equal(monthFromWeekStart('2026-07-19'), '2026-07');
  assert.equal(monthFromWeekStart('2026-08-30'), '2026-08');
  assert.equal(monthFromWeekStart('2026-07-20'), '');  // not a Sunday
  assert.equal(monthFromWeekStart('nope'), '');
});

test('formatWeekDisplay renders YYYY-MM-DD as DD/MM/YYYY (LTR-safe)', () => {
  assert.equal(formatWeekDisplay('2026-07-19'), '19/07/2026');
  assert.equal(formatWeekDisplay('2026-01-04'), '04/01/2026');
  assert.equal(formatWeekDisplay('bad'), 'bad');
  assert.equal(formatWeekDisplay(''), '');
  assert.equal(formatWeekDisplay(null), '');
});

test('recentWeekStarts returns n Sundays, most-recent first, 7 days apart', () => {
  const weeks = recentWeekStarts(new Date('2026-07-25T00:00:00Z'), 4);
  assert.deepEqual(weeks, ['2026-07-19', '2026-07-12', '2026-07-05', '2026-06-28']);
  assert.deepEqual(recentWeekStarts(new Date('2026-07-25'), 0), []);
  assert.deepEqual(recentWeekStarts('bad', 4), []);
});

// ---- quantity primitive ----

test('isValidQuantity: finite number ≥ 0, string numerics OK, blanks rejected', () => {
  assert.equal(isValidQuantity(0), true);
  assert.equal(isValidQuantity('12'), true);
  assert.equal(isValidQuantity(3.5), true);
  assert.equal(isValidQuantity(-1), false);
  assert.equal(isValidQuantity('abc'), false);
  assert.equal(isValidQuantity(''), false);
  assert.equal(isValidQuantity(null), false);
});

// ---- submission validation (mirrored server-side) ----

const goodItem = { category: 'טואלטיקה', item: 'נייר טואלט', quantity: 12 };
const base = { house: 'רעננה', week_start: '2026-07-19', counted_by: 'אורן', items: [goodItem] };

test('a valid submission passes', () => {
  assert.equal(validateInventorySubmission(base), null);
});

test('missing house / non-Sunday week_start / unknown counter are rejected', () => {
  assert.match(validateInventorySubmission({ ...base, house: '' }), /house/);
  assert.match(validateInventorySubmission({ ...base, week_start: '2026-07-20' }), /Sunday/); // Monday
  assert.match(validateInventorySubmission({ ...base, week_start: '2026-07' }), /Sunday/);
  assert.match(validateInventorySubmission({ ...base, counted_by: 'אולגה' }), /counted_by/);
});

test('items: empty array, bad category, negative quantity are rejected', () => {
  assert.match(validateInventorySubmission({ ...base, items: [] }), /items/);
  assert.match(
    validateInventorySubmission({ ...base, items: [{ category: 'ריהוט', item: 'כיסא', quantity: 1 }] }),
    /category/);
  // מזון is no longer a Logistics category — a food item is rejected here.
  assert.match(
    validateInventorySubmission({ ...base, items: [{ category: 'מזון', item: 'אורז', quantity: 1 }] }),
    /category/);
  assert.match(
    validateInventorySubmission({ ...base, items: [{ ...goodItem, quantity: -3 }] }),
    /≥ 0/);
});

test('blank quantities are tolerated but at least ONE must be filled', () => {
  const blank = { category: 'חומרי ניקוי', item: 'ספוגים', quantity: '' };
  assert.equal(validateInventorySubmission({ ...base, items: [goodItem, blank] }), null);
  assert.match(validateInventorySubmission({ ...base, items: [blank] }), /No quantities/);
});

// ---- catalog grouping ----

test('groupCatalog: keeps category order, drops inactive, unknown- and retired-category rows', () => {
  const rows = [
    { category: 'חומרי ניקוי', item_text: 'אקונומיקה', active: 'TRUE' },
    { category: 'טואלטיקה', item_text: 'נייר טואלט', active: 'TRUE' },
    { category: 'טואלטיקה', item_text: 'ישן', active: 'FALSE' },       // inactive
    { category: 'ריהוט', item_text: 'כיסא', active: 'TRUE' },          // unknown category
    { category: 'מזון', item_text: 'אורז', active: 'FALSE' },          // retired category, inactive
  ];
  const g = groupCatalog(rows);
  assert.deepEqual(Object.keys(g), INVENTORY_CATEGORIES);
  assert.deepEqual(g['טואלטיקה'], ['נייר טואלט']);
  assert.deepEqual(g['חומרי ניקוי'], ['אקונומיקה']);
  assert.ok(!Object.prototype.hasOwnProperty.call(g, 'מזון'));
});

// ---- latest-count resolution (weekly; re-submission supersedes, history preserved) ----

const wk = '2026-07-19';
const countRows = [
  // first submission for רעננה this week
  { count_id: 'INV-1', house: 'רעננה', week_start: wk, counted_by: 'אורן', counted_at: '2026-07-20T08:00:00Z', category: 'חומרי ניקוי', item: 'אקונומיקה', quantity: 4 },
  { count_id: 'INV-1', house: 'רעננה', week_start: wk, counted_by: 'אורן', counted_at: '2026-07-20T08:00:00Z', category: 'טואלטיקה', item: 'נייר טואלט', quantity: 20 },
  // corrected re-submission SAME house+week — must win
  { count_id: 'INV-2', house: 'רעננה', week_start: wk, counted_by: 'אורן', counted_at: '2026-07-22T09:00:00Z', category: 'טואלטיקה', item: 'נייר טואלט', quantity: 24 },
  // another house, same week
  { count_id: 'INV-3', house: 'ריהאב', week_start: wk, counted_by: 'יעקב', counted_at: '2026-07-21T07:00:00Z', category: 'טואלטיקה', item: 'טישו', quantity: 6 },
  // same house, DIFFERENT week — must not leak in
  { count_id: 'INV-0', house: 'רעננה', week_start: '2026-07-12', counted_by: 'אורן', counted_at: '2026-07-13T08:00:00Z', category: 'טואלטיקה', item: 'נייר טואלט', quantity: 9 },
];

test('latestCountFor returns the newest count_id only, scoped to house+week', () => {
  const c = latestCountFor(countRows, 'רעננה', wk);
  assert.equal(c.count_id, 'INV-2');
  assert.equal(c.counted_by, 'אורן');
  assert.equal(c.items.length, 1);
  assert.equal(c.items[0].quantity, 24);
  assert.equal(latestCountFor(countRows, 'הפרדס', wk), null);
});

test('latestByHouse maps every house to its latest count or null', () => {
  const houses = [{ name: 'רעננה' }, { name: 'ריהאב' }, { name: 'הפרדס' }];
  const m = latestByHouse(countRows, houses, wk);
  assert.equal(m['רעננה'].count_id, 'INV-2');
  assert.equal(m['ריהאב'].count_id, 'INV-3');
  assert.equal(m['הפרדס'], null);
});
