// test/house-ids.test.js — canonical house display names (increment 33). HOUSE-IDS.md is the single
// source: every app shows EXACTLY these strings, never a local variant or a reordered form. This
// guard fails loudly if an old form ("רעננה", "קיסריה עפרוני", bare "הפרדס", "קיסריה ריהאב") sneaks
// back into a seed or a code-path map.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SEED_HOUSES, SEED_USERS, INVENTORY_HOUSE_COORDINATORS } from '../src/schema.js';
import { HOUSE_IDS, DIGEST_HOUSE_IDS, houseId } from '../src/digest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// The only correct display names, from HOUSE-IDS.md. Both Caesarea houses are CITY FIRST.
const CANONICAL = ['רמות השבים', 'רעננה אשר', 'רעננה הפרדס', 'קיסריה עפרוני', 'קיסריה ריהאב', 'שדה אליעזר'];
// Forms that must never appear as a house value again (the exact bugs this guard prevents). The
// city-last Caesarea orderings ("עפרוני קיסריה" / "ריהאב קיסריה") are the ones now being corrected;
// "קיסריה עפרוני" / "קיסריה ריהאב" are CANONICAL and must NOT be banned.
const OLD_FORMS = ['רעננה', 'עפרוני קיסריה', 'הפרדס', 'ריהאב קיסריה'];

test('HOUSE-IDS.md exists at the repo root and lists all six canonical display names', () => {
  const md = readFileSync(join(root, 'HOUSE-IDS.md'), 'utf8');
  for (const name of CANONICAL) assert.ok(md.includes(name), `HOUSE-IDS.md missing ${name}`);
  assert.ok(md.includes('שדה אליעזר'));
});

test('seeded Houses display names match HOUSE-IDS.md exactly (including שדה אליעזר)', () => {
  assert.deepEqual([...SEED_HOUSES.map((h) => h.name)].sort(), [...CANONICAL].sort());
  assert.ok(SEED_HOUSES.some((h) => h.name === 'שדה אליעזר'));
});

test('no seed or code-path map emits an old house form', () => {
  const houseValues = [
    ...SEED_HOUSES.map((h) => h.name),
    ...SEED_USERS.map((u) => u.house).filter(Boolean),
    ...Object.keys(HOUSE_IDS),
    ...Object.keys(INVENTORY_HOUSE_COORDINATORS),
  ];
  for (const v of houseValues) {
    assert.ok(!OLD_FORMS.includes(v), `old house form leaked into a seed/map: "${v}"`);
  }
  // Every house VALUE that names a house is one of the canonical six (clusters like "sharon" for
  // maintenance leads are not house names and are excluded above via the canonical membership check).
  for (const h of SEED_HOUSES) assert.ok(CANONICAL.includes(h.name));
  for (const k of Object.keys(HOUSE_IDS)) assert.ok(CANONICAL.includes(k));
  for (const k of Object.keys(INVENTORY_HOUSE_COORDINATORS)) assert.ok(CANONICAL.includes(k));
});

test('digest maps all six canonical names to distinct ids; old forms map to null', () => {
  assert.equal(DIGEST_HOUSE_IDS.length, 6);
  const ids = CANONICAL.map(houseId);
  assert.ok(ids.every(Boolean), 'every canonical name must map');
  assert.equal(new Set(ids).size, 6, 'six distinct ids');
  for (const old of OLD_FORMS) assert.equal(houseId(old), null, `old form ${old} must not map`);
});

// ---- increment 35: רעננה הפרדס uses the shared `pardes` id (matches HOUSE-IDS.md + ezone-kitchen) ----

test('רעננה הפרדס maps to exactly `pardes` (not the old raanana-hapardes)', () => {
  assert.equal(houseId('רעננה הפרדס'), 'pardes');
  assert.ok(DIGEST_HOUSE_IDS.includes('pardes'));
  assert.ok(!DIGEST_HOUSE_IDS.includes('raanana-hapardes'));
});

test('the old id `raanana-hapardes` appears NOWHERE in production digest sources', () => {
  for (const f of ['src/digest.js', 'apps-script/digest.gs']) {
    const src = readFileSync(join(root, f), 'utf8');
    assert.ok(!src.includes('raanana-hapardes'), `${f} still references raanana-hapardes`);
    assert.ok(src.includes('pardes'), `${f} must use the pardes id`);
  }
});
