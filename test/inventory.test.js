// test/inventory.test.js — locks the monthly inventory-count logic (increment 25).
// Validation here mirrors handleSubmitInventory_ in apps-script/Code.gs (server is the gate).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  currentMonth, isValidMonth, isValidQuantity, formatMonthDisplay,
  validateInventorySubmission, groupCatalog, latestCountFor, latestByHouse,
} from '../src/inventory.js';
import {
  HEADERS, INVENTORY_CATEGORIES, INVENTORY_COUNTERS, SEED_INVENTORY_ITEMS,
} from '../src/schema.js';

// ---- schema ----

test('inventory sheets exist with the locked columns', () => {
  assert.deepEqual(HEADERS.InventoryItems, ['category', 'item_text', 'active']);
  assert.deepEqual(HEADERS.InventoryCounts, [
    'count_id', 'house', 'month', 'counted_by', 'counted_at',
    'category', 'item', 'quantity', 'notes',
  ]);
});

test('categories are טואלטיקה / חומרי ניקוי / מזון; counters are the leads + רועי', () => {
  assert.deepEqual(INVENTORY_CATEGORIES, ['טואלטיקה', 'חומרי ניקוי', 'מזון']);
  assert.deepEqual(INVENTORY_COUNTERS, ['רמי', 'צחי', 'רועי']);
});

test('seed catalog: every item has a valid category and נייר טואלט is present', () => {
  assert.ok(SEED_INVENTORY_ITEMS.length >= 20);
  for (const it of SEED_INVENTORY_ITEMS) {
    assert.ok(INVENTORY_CATEGORIES.includes(it.category), `bad category on ${it.item_text}`);
    assert.equal(it.active, 'TRUE');
  }
  assert.ok(SEED_INVENTORY_ITEMS.some((i) => i.item_text === 'נייר טואלט'));
});

// ---- month / quantity primitives ----

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
  // The reported RTL bug: '2026-07' must show as 07/2026, not 2026-07.
  assert.equal(formatMonthDisplay('2026-07'), '07/2026');
  assert.equal(formatMonthDisplay('2026-01'), '01/2026');
  assert.equal(formatMonthDisplay('2099-12'), '12/2099');
  // Malformed input is returned unchanged rather than throwing.
  assert.equal(formatMonthDisplay('2026-7'), '2026-7');
  assert.equal(formatMonthDisplay('July'), 'July');
  assert.equal(formatMonthDisplay(''), '');
  assert.equal(formatMonthDisplay(null), '');
  assert.equal(formatMonthDisplay(undefined), '');
});

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
const base = { house: 'רעננה', month: '2026-07', counted_by: 'רמי', items: [goodItem] };

test('a valid submission passes', () => {
  assert.equal(validateInventorySubmission(base), null);
});

test('missing house / bad month / unknown counter are rejected', () => {
  assert.match(validateInventorySubmission({ ...base, house: '' }), /house/);
  assert.match(validateInventorySubmission({ ...base, month: 'July' }), /YYYY-MM/);
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

// ---- catalog grouping ----

test('groupCatalog: keeps category order, drops inactive and unknown-category rows', () => {
  const rows = [
    { category: 'מזון', item_text: 'אורז', active: 'TRUE' },
    { category: 'טואלטיקה', item_text: 'נייר טואלט', active: 'TRUE' },
    { category: 'טואלטיקה', item_text: 'ישן', active: 'FALSE' },     // hidden
    { category: 'ריהוט', item_text: 'כיסא', active: 'TRUE' },        // unknown category
  ];
  const g = groupCatalog(rows);
  assert.deepEqual(Object.keys(g), INVENTORY_CATEGORIES);
  assert.deepEqual(g['טואלטיקה'], ['נייר טואלט']);
  assert.deepEqual(g['מזון'], ['אורז']);
});

// ---- latest-count resolution (re-submission supersedes, history preserved) ----

const countRows = [
  // first submission for רעננה 2026-07
  { count_id: 'INV-1', house: 'רעננה', month: '2026-07', counted_by: 'רמי', counted_at: '2026-07-02T08:00:00Z', category: 'מזון', item: 'אורז', quantity: 4 },
  { count_id: 'INV-1', house: 'רעננה', month: '2026-07', counted_by: 'רמי', counted_at: '2026-07-02T08:00:00Z', category: 'טואלטיקה', item: 'נייר טואלט', quantity: 20 },
  // corrected re-submission SAME house+month — must win
  { count_id: 'INV-2', house: 'רעננה', month: '2026-07', counted_by: 'רמי', counted_at: '2026-07-05T09:00:00Z', category: 'טואלטיקה', item: 'נייר טואלט', quantity: 24 },
  // another house, same month
  { count_id: 'INV-3', house: 'ריהאב', month: '2026-07', counted_by: 'צחי', counted_at: '2026-07-03T07:00:00Z', category: 'מזון', item: 'פסטה', quantity: 6 },
  // same house, DIFFERENT month — must not leak in
  { count_id: 'INV-0', house: 'רעננה', month: '2026-06', counted_by: 'רמי', counted_at: '2026-06-28T08:00:00Z', category: 'מזון', item: 'אורז', quantity: 9 },
];

test('latestCountFor returns the newest count_id only, scoped to house+month', () => {
  const c = latestCountFor(countRows, 'רעננה', '2026-07');
  assert.equal(c.count_id, 'INV-2');
  assert.equal(c.counted_by, 'רמי');
  assert.equal(c.items.length, 1);
  assert.equal(c.items[0].quantity, 24);
  assert.equal(latestCountFor(countRows, 'הפרדס', '2026-07'), null);
});

test('latestByHouse maps every house to its latest count or null', () => {
  const houses = [{ name: 'רעננה' }, { name: 'ריהאב' }, { name: 'הפרדס' }];
  const m = latestByHouse(countRows, houses, '2026-07');
  assert.equal(m['רעננה'].count_id, 'INV-2');
  assert.equal(m['ריהאב'].count_id, 'INV-3');
  assert.equal(m['הפרדס'], null);
});
