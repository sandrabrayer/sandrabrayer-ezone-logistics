// test/inventory.test.js — locks the WEEKLY inventory-count logic (increments 25–26).
// Validation here mirrors handleSubmitInventory_ / handleSubmitKitchenCount_ in apps-script/Code.gs
// (the server is the real gate).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  currentMonth, isValidMonth, isValidQuantity, formatMonthDisplay,
  weekStart, currentWeekStart, isValidWeekStart, monthFromWeekStart, formatWeekDisplay,
  recentWeekStarts, resolveSource, KITCHEN_CATEGORY,
  validateInventorySubmission, validateKitchenCount, foodItemSet, kitchenRows,
  groupCatalog, latestCountFor, latestByHouse, weeklyPrefill,
} from '../src/inventory.js';
import {
  HEADERS, INVENTORY_CATEGORIES, INVENTORY_COUNTERS, INVENTORY_HOUSE_COORDINATORS,
  INVENTORY_SOURCES, SEED_INVENTORY_ITEMS,
} from '../src/schema.js';

// ---- schema ----

test('inventory sheets exist; week_start + source are APPENDED at the end (order preserved)', () => {
  assert.deepEqual(HEADERS.InventoryItems, ['category', 'item_text', 'active']);
  assert.deepEqual(HEADERS.InventoryCounts, [
    'count_id', 'house', 'month', 'counted_by', 'counted_at',
    'category', 'item', 'quantity', 'notes',
    'week_start', 'source',
  ]);
  // The original nine columns keep their exact positions; the two new ones are last.
  assert.equal(HEADERS.InventoryCounts[HEADERS.InventoryCounts.length - 2], 'week_start');
  assert.equal(HEADERS.InventoryCounts[HEADERS.InventoryCounts.length - 1], 'source');
});

test('categories are unchanged; counters are the coordinators + backstop', () => {
  assert.deepEqual(INVENTORY_CATEGORIES, ['טואלטיקה', 'חומרי ניקוי', 'מזון']);
  assert.deepEqual(INVENTORY_COUNTERS, ['שירה', 'יעקב', 'אורן', 'אביב', 'צחי', 'רועי', 'רמי']);
  // רמי and צחי stay accepted as a backstop.
  assert.ok(INVENTORY_COUNTERS.includes('רמי'));
  assert.ok(INVENTORY_COUNTERS.includes('צחי'));
});

test('each open/pre-opening house maps to its coordinator', () => {
  assert.deepEqual(INVENTORY_HOUSE_COORDINATORS, {
    'קיסריה עפרוני': 'שירה', 'ריהאב': 'יעקב', 'רעננה': 'אורן',
    'רמות השבים': 'אביב', 'שדה אליעזר': 'צחי',
  });
  // Every mapped coordinator is an accepted counter.
  for (const who of Object.values(INVENTORY_HOUSE_COORDINATORS)) {
    assert.ok(INVENTORY_COUNTERS.includes(who), `${who} must be an accepted counter`);
  }
});

test('source vocabulary is coordinator / kitchen', () => {
  assert.equal(INVENTORY_SOURCES.COORDINATOR, 'coordinator');
  assert.equal(INVENTORY_SOURCES.KITCHEN, 'kitchen');
  assert.equal(KITCHEN_CATEGORY, 'מזון');
});

test('seed catalog: every item has a valid category and נייר טואלט is present', () => {
  assert.ok(SEED_INVENTORY_ITEMS.length >= 20);
  for (const it of SEED_INVENTORY_ITEMS) {
    assert.ok(INVENTORY_CATEGORIES.includes(it.category), `bad category on ${it.item_text}`);
    assert.equal(it.active, 'TRUE');
  }
  assert.ok(SEED_INVENTORY_ITEMS.some((i) => i.item_text === 'נייר טואלט'));
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
  // 2026-07-25 is a Saturday → week began Sunday 2026-07-19.
  assert.equal(weekStart('2026-07-25'), '2026-07-19');
  assert.equal(weekStart('2026-07-19'), '2026-07-19'); // a Sunday maps to itself
  assert.equal(weekStart('2026-07-22'), '2026-07-19'); // a Wednesday
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
  assert.equal(monthFromWeekStart('2026-08-30'), '2026-08'); // a Sunday in August
  assert.equal(monthFromWeekStart('2026-07-20'), '');        // not a Sunday
  assert.equal(monthFromWeekStart('nope'), '');
});

test('formatWeekDisplay renders YYYY-MM-DD as DD/MM/YYYY (LTR-safe)', () => {
  assert.equal(formatWeekDisplay('2026-07-19'), '19/07/2026');
  assert.equal(formatWeekDisplay('2026-01-04'), '04/01/2026');
  assert.equal(formatWeekDisplay('bad'), 'bad');   // returned unchanged, never throws
  assert.equal(formatWeekDisplay(''), '');
  assert.equal(formatWeekDisplay(null), '');
});

test('recentWeekStarts returns n Sundays, most-recent first, 7 days apart', () => {
  const weeks = recentWeekStarts(new Date('2026-07-25T00:00:00Z'), 4);
  assert.deepEqual(weeks, ['2026-07-19', '2026-07-12', '2026-07-05', '2026-06-28']);
  assert.deepEqual(recentWeekStarts(new Date('2026-07-25'), 0), []);
  assert.deepEqual(recentWeekStarts('bad', 4), []);
});

// ---- source resolution (backfill: blank = coordinator) ----

test('resolveSource: blank/absent reads as coordinator; kitchen stays kitchen', () => {
  assert.equal(resolveSource({ source: 'coordinator' }), 'coordinator');
  assert.equal(resolveSource({ source: 'kitchen' }), 'kitchen');
  assert.equal(resolveSource({ source: '' }), 'coordinator');   // backfill rule
  assert.equal(resolveSource({ source: '  ' }), 'coordinator');
  assert.equal(resolveSource({}), 'coordinator');
  assert.equal(resolveSource(null), 'coordinator');
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

// ---- coordinator submission validation (mirrored server-side) ----

const goodItem = { category: 'טואלטיקה', item: 'נייר טואלט', quantity: 12 };
const base = { house: 'רעננה', week_start: '2026-07-19', counted_by: 'אורן', items: [goodItem] };

test('a valid coordinator submission passes', () => {
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
  assert.match(
    validateInventorySubmission({ ...base, items: [{ ...goodItem, quantity: -3 }] }),
    /≥ 0/);
});

test('blank quantities are tolerated but at least ONE must be filled', () => {
  const blank = { category: 'מזון', item: 'אורז', quantity: '' };
  assert.equal(validateInventorySubmission({ ...base, items: [goodItem, blank] }), null);
  assert.match(validateInventorySubmission({ ...base, items: [blank] }), /No quantities/);
});

// ---- kitchen ingest validation (מזון-only, catalog-gated) ----

const CATALOG = [
  { category: 'מזון', item_text: 'אורז', active: 'TRUE' },
  { category: 'מזון', item_text: 'פסטה', active: 'TRUE' },
  { category: 'מזון', item_text: 'ישן', active: 'FALSE' },          // hidden — not allowed
  { category: 'טואלטיקה', item_text: 'נייר טואלט', active: 'TRUE' }, // not מזון — not allowed
];
const HOUSES = [{ name: 'רעננה' }, { name: 'ריהאב' }];
const kBase = {
  house: 'רעננה', weekStart: '2026-07-19', countedBy: 'טבח ראשי',
  items: [{ item: 'אורז', quantity: 3, notes: 'חסר' }],
};

test('foodItemSet: only ACTIVE מזון items', () => {
  const set = foodItemSet(CATALOG);
  assert.ok(set.has('אורז'));
  assert.ok(set.has('פסטה'));
  assert.ok(!set.has('ישן'));           // inactive
  assert.ok(!set.has('נייר טואלט'));    // wrong category
});

test('a valid kitchen submission passes', () => {
  assert.equal(validateKitchenCount(kBase, CATALOG, HOUSES), null);
});

test('kitchen: unknown house / non-Sunday week / missing or long countedBy rejected', () => {
  assert.match(validateKitchenCount({ ...kBase, house: 'לא קיים' }, CATALOG, HOUSES), /Unknown house/);
  assert.match(validateKitchenCount({ ...kBase, weekStart: '2026-07-20' }, CATALOG, HOUSES), /Sunday/);
  assert.match(validateKitchenCount({ ...kBase, countedBy: '' }, CATALOG, HOUSES), /countedBy/);
  assert.match(validateKitchenCount({ ...kBase, countedBy: 'x'.repeat(61) }, CATALOG, HOUSES), /60/);
});

test('kitchen is LOCKED to מזון — any other category is rejected (payload or item level)', () => {
  assert.match(
    validateKitchenCount({ ...kBase, category: 'טואלטיקה' }, CATALOG, HOUSES), /only write מזון/);
  assert.match(
    validateKitchenCount({ ...kBase, items: [{ item: 'אורז', category: 'חומרי ניקוי', quantity: 1 }] }, CATALOG, HOUSES),
    /only write מזון/);
});

test('kitchen: unknown item rejected (not silently created); notes capped at 200', () => {
  assert.match(
    validateKitchenCount({ ...kBase, items: [{ item: 'קוויאר', quantity: 1 }] }, CATALOG, HOUSES),
    /Unknown item/);
  // A מזון item that is NOT in the active catalog is also unknown.
  assert.match(
    validateKitchenCount({ ...kBase, items: [{ item: 'ישן', quantity: 1 }] }, CATALOG, HOUSES),
    /Unknown item/);
  assert.match(
    validateKitchenCount({ ...kBase, items: [{ item: 'אורז', quantity: 1, notes: 'n'.repeat(201) }] }, CATALOG, HOUSES),
    /200/);
});

test('kitchen: negative quantity rejected; at least one filled required', () => {
  assert.match(
    validateKitchenCount({ ...kBase, items: [{ item: 'אורז', quantity: -1 }] }, CATALOG, HOUSES), /≥ 0/);
  assert.match(
    validateKitchenCount({ ...kBase, items: [{ item: 'אורז', quantity: '' }] }, CATALOG, HOUSES),
    /No quantities/);
});

test('kitchenRows forces category=מזון, coerces numbers, trims notes, skips blanks', () => {
  const rows = kitchenRows({ items: [
    { item: 'אורז', quantity: '3', notes: 'חסר', category: 'מזון' },
    { item: 'פסטה', quantity: '' },              // blank → skipped
    { item: 'קפה', quantity: 5, notes: 'x'.repeat(250) },
  ] });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { category: 'מזון', item: 'אורז', quantity: 3, notes: 'חסר' });
  assert.equal(rows[1].category, 'מזון');
  assert.equal(rows[1].quantity, 5);
  assert.equal(rows[1].notes.length, 200);       // capped
});

// ---- catalog grouping ----

test('groupCatalog: keeps category order, drops inactive and unknown-category rows', () => {
  const rows = [
    { category: 'מזון', item_text: 'אורז', active: 'TRUE' },
    { category: 'טואלטיקה', item_text: 'נייר טואלט', active: 'TRUE' },
    { category: 'טואלטיקה', item_text: 'ישן', active: 'FALSE' },
    { category: 'ריהוט', item_text: 'כיסא', active: 'TRUE' },
  ];
  const g = groupCatalog(rows);
  assert.deepEqual(Object.keys(g), INVENTORY_CATEGORIES);
  assert.deepEqual(g['טואלטיקה'], ['נייר טואלט']);
  assert.deepEqual(g['מזון'], ['אורז']);
});

// ---- latest-count resolution (weekly + source-aware) ----

const wk = '2026-07-19';
const countRows = [
  // coordinator's first submission for רעננה this week
  { count_id: 'INV-1', house: 'רעננה', week_start: wk, source: 'coordinator', counted_by: 'אורן', counted_at: '2026-07-20T08:00:00Z', category: 'מזון', item: 'אורז', quantity: 4 },
  { count_id: 'INV-1', house: 'רעננה', week_start: wk, source: 'coordinator', counted_by: 'אורן', counted_at: '2026-07-20T08:00:00Z', category: 'טואלטיקה', item: 'נייר טואלט', quantity: 20 },
  // corrected coordinator re-submission SAME house+week — must win
  { count_id: 'INV-2', house: 'רעננה', week_start: wk, source: 'coordinator', counted_by: 'אורן', counted_at: '2026-07-22T09:00:00Z', category: 'טואלטיקה', item: 'נייר טואלט', quantity: 24 },
  // a KITCHEN count for the same house+week (source stays separate)
  { count_id: 'INV-K', house: 'רעננה', week_start: wk, source: 'kitchen', counted_by: 'טבח', counted_at: '2026-07-19T06:00:00Z', category: 'מזון', item: 'אורז', quantity: 0, notes: 'נגמר' },
  // another house — kitchen only (blank source would be coordinator, so mark explicitly)
  { count_id: 'INV-3', house: 'ריהאב', week_start: wk, source: 'kitchen', counted_by: 'טבח', counted_at: '2026-07-19T07:00:00Z', category: 'מזון', item: 'פסטה', quantity: 6 },
  // a HISTORICAL row with blank source (backfill = coordinator), different week
  { count_id: 'INV-0', house: 'רעננה', week_start: '2026-07-12', source: '', counted_by: 'אורן', counted_at: '2026-07-13T08:00:00Z', category: 'מזון', item: 'אורז', quantity: 9 },
];

test('latestCountFor (no source) returns newest count_id, scoped to house+week', () => {
  const c = latestCountFor(countRows, 'רעננה', wk);
  assert.equal(c.count_id, 'INV-2');           // newest counted_at overall
  assert.equal(c.items[0].quantity, 24);
  assert.equal(latestCountFor(countRows, 'הפרדס', wk), null);
});

test('latestCountFor scoped to coordinator ignores the kitchen row', () => {
  const c = latestCountFor(countRows, 'רעננה', wk, 'coordinator');
  assert.equal(c.count_id, 'INV-2');
  assert.equal(c.source, 'coordinator');
});

test('latestCountFor scoped to kitchen returns the kitchen row only', () => {
  const c = latestCountFor(countRows, 'רעננה', wk, 'kitchen');
  assert.equal(c.count_id, 'INV-K');
  assert.equal(c.items[0].quantity, 0);
});

test('blank source resolves to coordinator for scoped queries (backfill)', () => {
  const c = latestCountFor(countRows, 'רעננה', '2026-07-12', 'coordinator');
  assert.equal(c.count_id, 'INV-0');
  assert.equal(c.source, 'coordinator');
});

test('latestByHouse maps each house to its latest coordinator count or null', () => {
  const houses = [{ name: 'רעננה' }, { name: 'ריהאב' }, { name: 'הפרדס' }];
  const m = latestByHouse(countRows, houses, wk, 'coordinator');
  assert.equal(m['רעננה'].count_id, 'INV-2');
  assert.equal(m['ריהאב'], null);   // ריהאב only has a kitchen count this week
  assert.equal(m['הפרדס'], null);
});

// ---- coordinator prefill from kitchen ----

test('weeklyPrefill seeds מזון from the kitchen when no coordinator count exists', () => {
  const kitchenOnly = countRows.filter((r) => r.house === 'ריהאב');
  const pre = weeklyPrefill(kitchenOnly, 'ריהאב', wk);
  assert.equal(pre.coordinator, null);
  assert.ok(pre.kitchen);
  assert.deepEqual(pre.byItem['פסטה'], { quantity: 6, notes: '', source: 'kitchen' });
});

test('weeklyPrefill: a coordinator count OVERRIDES the kitchen seed for the same item', () => {
  const pre = weeklyPrefill(countRows, 'רעננה', wk);
  // אורז exists in the kitchen count (qty 0) but the coordinator never re-counted אורז in INV-2,
  // so the winning coordinator count (INV-2) only holds נייר טואלט. The kitchen seed for אורז stays.
  assert.equal(pre.byItem['נייר טואלט'].source, 'coordinator');
  assert.equal(pre.byItem['נייר טואלט'].quantity, 24);
  assert.equal(pre.byItem['אורז'].source, 'kitchen');
  assert.equal(pre.byItem['אורז'].quantity, 0);
});
