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
  parseAllowedUnits, resolveItemUnit, unitForCount, computeQuantityBase, itemUnitMap, QUANTITY_CHOICES,
} from '../src/inventory.js';
import {
  HEADERS, INVENTORY_CATEGORIES, INVENTORY_COUNTERS, INVENTORY_HOUSE_COORDINATORS,
  SEED_INVENTORY_ITEMS, BASE_UNITS, SEED_USERS,
} from '../src/schema.js';

// ---- schema ----

test('inventory sheets exist; increment-33 columns are APPENDED at the end (order preserved)', () => {
  // base_unit / allowed_units / par_base appended to InventoryItems (first three keep positions).
  assert.deepEqual(HEADERS.InventoryItems, ['category', 'item_text', 'active', 'base_unit', 'allowed_units', 'par_base']);
  assert.deepEqual(HEADERS.InventoryItems.slice(0, 3), ['category', 'item_text', 'active']);
  // unit_label / unit_factor / quantity_base appended AFTER week_start (originals keep positions).
  assert.deepEqual(HEADERS.InventoryCounts, [
    'count_id', 'house', 'month', 'counted_by', 'counted_at',
    'category', 'item', 'quantity', 'notes',
    'week_start',
    'unit_label', 'unit_factor', 'quantity_base',
  ]);
  assert.equal(HEADERS.InventoryCounts[HEADERS.InventoryCounts.length - 1], 'quantity_base');
  // quantity keeps its meaning (what the counter typed) and its original position (index 7).
  assert.equal(HEADERS.InventoryCounts[7], 'quantity');
  assert.ok(!HEADERS.InventoryCounts.includes('source'));
});

test('an InventoryItems row lacking the three new columns still reads (unitless, no par)', () => {
  const legacy = { category: 'טואלטיקה', item_text: 'ישן', active: 'TRUE' };
  const d = resolveItemUnit(legacy);
  assert.equal(d.unitless, true);
  assert.deepEqual(d.units, []);
  assert.equal(d.par_base, null);
  // groupCatalog (which reads only item_text/active/category) is unaffected by the new columns.
  assert.deepEqual(groupCatalog([legacy]), { 'טואלטיקה': ['ישן'], 'חומרי ניקוי': [] });
});

test('categories are ONLY טואלטיקה / חומרי ניקוי (food is owned by ezone-kitchen)', () => {
  assert.deepEqual(INVENTORY_CATEGORIES, ['טואלטיקה', 'חומרי ניקוי']);
  assert.ok(!INVENTORY_CATEGORIES.includes('מזון'));
});

test('counters are the coordinators + backstop', () => {
  assert.deepEqual(INVENTORY_COUNTERS, ['שירה', 'יעקב', 'אורן', 'אביב', 'צחי', 'רועי', 'רמי']);
  assert.ok(INVENTORY_COUNTERS.includes('רמי'));  // maintenance-lead backstop
  assert.ok(INVENTORY_COUNTERS.includes('צחי'));  // maintenance-lead backstop (NOT a coordinator)
});

test('only the four houses with a seeded coordinator map to one (canonical names, HOUSE-IDS.md)', () => {
  // The two pre-opening houses (שדה אליעזר, רעננה הפרדס) have NO coordinator yet, so they are absent
  // from the map and render blank. צחי is a maintenance lead (role: maintenance) — never a coordinator.
  assert.deepEqual(INVENTORY_HOUSE_COORDINATORS, {
    'קיסריה עפרוני': 'שירה', 'קיסריה ריהאב': 'יעקב', 'רעננה אשר': 'אורן',
    'רמות השבים': 'אביב',
  });
  for (const who of Object.values(INVENTORY_HOUSE_COORDINATORS)) {
    assert.ok(INVENTORY_COUNTERS.includes(who), `${who} must be an accepted counter`);
  }
});

test('צחי is a maintenance lead, not a coordinator — absent from the roster map', () => {
  // Regression: the רכז/ת column wrongly showed צחי for שדה אליעזר. He is role:maintenance in SEED_USERS,
  // and no coordinator is seeded for that pre-opening house, so it must render blank.
  assert.ok(!Object.values(INVENTORY_HOUSE_COORDINATORS).includes('צחי'), 'צחי must not be a coordinator');
  assert.ok(!('שדה אליעזר' in INVENTORY_HOUSE_COORDINATORS), 'שדה אליעזר has no seeded coordinator yet');
  const tzachi = SEED_USERS.find((u) => u.name === 'צחי');
  assert.equal(tzachi.role, 'maintenance', 'צחי is a maintenance lead, confirming he is no coordinator');
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

test('increment-33 split: אבקת/ג׳ל כביסה retired; אבקת כביסה (kg) + ג׳ל כביסה (l) active', () => {
  const byName = Object.fromEntries(SEED_INVENTORY_ITEMS.map((i) => [i.item_text, i]));
  // The combined item is retired (same pattern as the food rows) — one item can't carry two units.
  assert.ok(byName['אבקת/ג׳ל כביסה']);
  assert.equal(byName['אבקת/ג׳ל כביסה'].active, 'FALSE');
  // Two separate active replacements, each with its own base unit.
  assert.equal(byName['אבקת כביסה'].active, 'TRUE');
  assert.equal(byName['אבקת כביסה'].base_unit, 'kg');
  assert.equal(byName['ג׳ל כביסה'].active, 'TRUE');
  assert.equal(byName['ג׳ל כביסה'].base_unit, 'l');
});

test('every ACTIVE seed item has a valid base_unit, a parseable unit menu, and a numeric par', () => {
  for (const it of SEED_INVENTORY_ITEMS.filter((i) => i.active === 'TRUE')) {
    assert.ok(BASE_UNITS.includes(it.base_unit), `bad base_unit for ${it.item_text}: ${it.base_unit}`);
    const units = parseAllowedUnits(it.allowed_units);
    assert.ok(units && units.length, `unparseable allowed_units for ${it.item_text}`);
    assert.equal(typeof it.par_base, 'number');
    assert.ok(it.par_base > 0);
  }
});

// ---- unit parsing + resolution (increment 33) ----

test('parseAllowedUnits parses pairs; first entry is the default', () => {
  const u = parseAllowedUnits('בקבוק 1ל:1|בקבוק 2ל:2|בקבוק 4ל:4');
  assert.deepEqual(u, [
    { label: 'בקבוק 1ל', factor: 1 }, { label: 'בקבוק 2ל', factor: 2 }, { label: 'בקבוק 4ל', factor: 4 },
  ]);
  assert.equal(u[0].label, 'בקבוק 1ל');       // first = default selection
  assert.equal(parseAllowedUnits('בקבוק 750מל:0.75')[0].factor, 0.75); // fractional factor OK
});

test('parseAllowedUnits rejects malformed specs (→ null, never a wrong guess)', () => {
  assert.equal(parseAllowedUnits(''), null);
  assert.equal(parseAllowedUnits('בקבוק'), null);          // no colon
  assert.equal(parseAllowedUnits('בקבוק:'), null);         // no factor
  assert.equal(parseAllowedUnits(':5'), null);             // no label
  assert.equal(parseAllowedUnits('בקבוק:0'), null);        // factor not > 0
  assert.equal(parseAllowedUnits('בקבוק:-2'), null);       // negative factor
  assert.equal(parseAllowedUnits('בקבוק:x'), null);        // factor NaN
  assert.equal(parseAllowedUnits('ok:1|bad'), null);       // one bad pair fails the whole spec
});

test('resolveItemUnit: a valid unit item resolves with default = first option', () => {
  const d = resolveItemUnit({ item_text: 'אקונומיקה', base_unit: 'l', allowed_units: 'בקבוק 1ל:1|גלון 4ל:4', par_base: '10' });
  assert.equal(d.unitless, false);
  assert.equal(d.base_unit, 'l');
  assert.equal(d.defaultUnit.label, 'בקבוק 1ל');
  assert.equal(d.par_base, 10);
});

test('resolveItemUnit: unknown base_unit / malformed units → unitless AND logged', () => {
  const logs = [];
  const log = (m) => logs.push(m);
  const bad = resolveItemUnit({ item_text: 'X', base_unit: 'gallon', allowed_units: 'בקבוק:1', par_base: '3' }, log);
  assert.equal(bad.unitless, true);
  assert.deepEqual(bad.units, []);
  const bad2 = resolveItemUnit({ item_text: 'Y', base_unit: 'l', allowed_units: 'בקבוק:0', par_base: '3' }, log);
  assert.equal(bad2.unitless, true);
  assert.equal(logs.length, 2, 'both bad rows must be logged, never silently defaulted');
  assert.ok(logs[0].includes('base_unit') && logs[1].includes('allowed_units'));
  // par is still read even when units are rejected — a shortage can still be evaluated on base qty.
  assert.equal(bad.par_base, 3);
});

test('resolveItemUnit: a legacy/blank row is unitless but NOT logged (expected, not an error)', () => {
  const logs = [];
  const d = resolveItemUnit({ item_text: 'ישן', active: 'TRUE' }, (m) => logs.push(m));
  assert.equal(d.unitless, true);
  assert.equal(d.par_base, null);
  assert.equal(logs.length, 0);
});

test('unitForCount picks the matching label; falls back to the DEFAULT, never a random factor', () => {
  const d = resolveItemUnit({ item_text: 'אקונומיקה', base_unit: 'l', allowed_units: 'בקבוק 1ל:1|גלון 4ל:4', par_base: 10 });
  assert.deepEqual(unitForCount(d, 'גלון 4ל'), { unit_label: 'גלון 4ל', unit_factor: 4 });
  assert.deepEqual(unitForCount(d, 'לא קיים'), { unit_label: 'בקבוק 1ל', unit_factor: 1 }); // default
  // A unitless item always counts in base units (factor 1, no label).
  assert.deepEqual(unitForCount(resolveItemUnit({ item_text: 'ישן' }), 'whatever'), { unit_label: '', unit_factor: 1 });
});

test('computeQuantityBase = quantity × unit_factor (factors 1, 4, 0.75)', () => {
  assert.equal(computeQuantityBase(5, 1), 5);
  assert.equal(computeQuantityBase(3, 4), 12);
  assert.equal(computeQuantityBase(2, 0.75), 1.5);
  assert.equal(computeQuantityBase('x', 4), null);   // non-numeric → null
});

test('counting 4 of the 4-litre unit for אקונומיקה stores 16 l', () => {
  const acetone = SEED_INVENTORY_ITEMS.find((i) => i.item_text === 'אקונומיקה');
  const desc = resolveItemUnit(acetone);
  assert.equal(desc.base_unit, 'l');
  // אקונומיקה's 4-litre option (per the seed) is "בקבוק 4ל", factor 4.
  const chosen = unitForCount(desc, 'בקבוק 4ל');
  assert.equal(chosen.unit_factor, 4);
  assert.equal(computeQuantityBase(4, chosen.unit_factor), 16);   // 4 × 4 l = 16 l
});

test('QUANTITY_CHOICES is the shared derived option list (same for every item)', () => {
  assert.deepEqual(QUANTITY_CHOICES, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15, 20, 24, 30, 50]);
});

test('itemUnitMap resolves the whole catalog by item_text', () => {
  const m = itemUnitMap(SEED_INVENTORY_ITEMS);
  assert.equal(m['אקונומיקה'].base_unit, 'l');
  assert.equal(m['אבקת כביסה'].base_unit, 'kg');
  assert.equal(m['אורז'].unitless, true);   // retired food row → unitless
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
const base = { house: 'רעננה אשר', week_start: '2026-07-19', counted_by: 'אורן', items: [goodItem] };

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
  // first submission for רעננה אשר this week
  { count_id: 'INV-1', house: 'רעננה אשר', week_start: wk, counted_by: 'אורן', counted_at: '2026-07-20T08:00:00Z', category: 'חומרי ניקוי', item: 'אקונומיקה', quantity: 4 },
  { count_id: 'INV-1', house: 'רעננה אשר', week_start: wk, counted_by: 'אורן', counted_at: '2026-07-20T08:00:00Z', category: 'טואלטיקה', item: 'נייר טואלט', quantity: 20 },
  // corrected re-submission SAME house+week — must win
  { count_id: 'INV-2', house: 'רעננה אשר', week_start: wk, counted_by: 'אורן', counted_at: '2026-07-22T09:00:00Z', category: 'טואלטיקה', item: 'נייר טואלט', quantity: 24 },
  // another house, same week
  { count_id: 'INV-3', house: 'קיסריה ריהאב', week_start: wk, counted_by: 'יעקב', counted_at: '2026-07-21T07:00:00Z', category: 'טואלטיקה', item: 'טישו', quantity: 6 },
  // same house, DIFFERENT week — must not leak in
  { count_id: 'INV-0', house: 'רעננה אשר', week_start: '2026-07-12', counted_by: 'אורן', counted_at: '2026-07-13T08:00:00Z', category: 'טואלטיקה', item: 'נייר טואלט', quantity: 9 },
];

test('latestCountFor returns the newest count_id only, scoped to house+week', () => {
  const c = latestCountFor(countRows, 'רעננה אשר', wk);
  assert.equal(c.count_id, 'INV-2');
  assert.equal(c.counted_by, 'אורן');
  assert.equal(c.items.length, 1);
  assert.equal(c.items[0].quantity, 24);
  assert.equal(latestCountFor(countRows, 'רעננה הפרדס', wk), null);
});

test('latestByHouse maps every house to its latest count or null', () => {
  const houses = [{ name: 'רעננה אשר' }, { name: 'קיסריה ריהאב' }, { name: 'רעננה הפרדס' }];
  const m = latestByHouse(countRows, houses, wk);
  assert.equal(m['רעננה אשר'].count_id, 'INV-2');
  assert.equal(m['קיסריה ריהאב'].count_id, 'INV-3');
  assert.equal(m['רעננה הפרדס'], null);
});
