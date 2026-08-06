// test/setup-seeds.test.js — the hub-redesign template seeds are FIXED and IDEMPOTENT. Loads the real
// apps-script/setup.gs in a sandbox (it is pure top-level var + function declarations — no Apps Script call
// happens until setupSheet() runs) and asserts the seed builders + the seed-if-empty idempotency guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CODE = readFileSync(join(root, 'apps-script/setup.gs'), 'utf8');

function loadSetup() {
  const ret = 'return { buildOpeningChecklistSeed_, buildEmergencyReadinessSeed_, seedIfEmpty_, OPENING_TEMPLATE, PREVENTIVE_DAILY_TEMPLATE, DEFAULT_EMERGENCY_ITEMS, SEED_HOUSES };';
  return new Function('console', CODE + '\n;' + ret)(console);
}

// A fake sheet recording appended rows; getLastRow reflects header (1) + appended.
function fakeSheet(startRows) {
  const rows = startRows || 1; // 1 = header only (empty)
  const state = { last: rows, appended: null };
  return {
    getLastRow: () => state.last,
    getRange: (r, c, nr) => ({ setValues: (vals) => { state.appended = vals; state.last = 1 + vals.length; } }),
    _state: state,
  };
}

test('buildOpeningChecklistSeed_: fixed template, ONLY for pre-opening houses, done=FALSE', () => {
  const s = loadSetup();
  const rows = s.buildOpeningChecklistSeed_();
  const preOpening = s.SEED_HOUSES.filter((h) => h[3] === 'pre-opening').map((h) => h[0]);
  assert.ok(preOpening.length >= 1);
  // one row per (pre-opening house × template item)
  assert.equal(rows.length, preOpening.length * s.OPENING_TEMPLATE.length);
  // every row: [id, house, item, 'FALSE', '', '']; houses are exactly the pre-opening set
  const houses = [...new Set(rows.map((r) => r[1]))].sort();
  assert.deepEqual(houses, preOpening.slice().sort());
  rows.forEach((r) => { assert.equal(r[3], 'FALSE'); assert.ok(s.OPENING_TEMPLATE.indexOf(r[2]) !== -1); });
  // includes the required template items
  ['ריהוט', 'מכשירי חשמל', 'מסמכי רישוי', 'מפתחות'].forEach((it) => assert.ok(s.OPENING_TEMPLATE.indexOf(it) !== -1, it));
});

test('PREVENTIVE_DAILY_TEMPLATE is the fixed short daily list', () => {
  const s = loadSetup();
  ['בדיקת דוד/גז', 'סבב מפגעים', 'תאורה', 'מים'].forEach((it) => assert.ok(s.PREVENTIVE_DAILY_TEMPLATE.indexOf(it) !== -1, it));
});

test('seedIfEmpty_ is IDEMPOTENT: seeds an empty sheet, but never touches one that already has data', () => {
  const s = loadSetup();
  const seed = s.buildOpeningChecklistSeed_();
  const empty = fakeSheet(1);           // header only → should seed
  s.seedIfEmpty_(empty, seed);
  assert.equal(empty._state.appended.length, seed.length, 'seeded the empty sheet');

  const populated = fakeSheet(5);       // already has data → must be left alone
  s.seedIfEmpty_(populated, seed);
  assert.equal(populated._state.appended, null, 're-run never re-seeds a populated sheet');
});
