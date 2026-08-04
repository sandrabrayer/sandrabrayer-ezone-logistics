// test/reference-cache.test.js — the perf reference-data cache (Config / Houses / Users).
//
// These sheets are stable and were re-read many times per request (Config ~4x, Houses ~4x on
// /management) and on nearly every page load. readReference_ adds a per-execution memo + a short-TTL
// CacheService layer. The CRITICAL correctness property is write → next read fresh: a write invalidates
// the cache so stale reference data is never served. This fixtures the real apps-script .gs files in a
// sandbox (Apps Script shares one global scope) and instruments getValues() to COUNT full-sheet reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CODE = readFileSync(join(root, 'apps-script/digest.gs'), 'utf8') + '\n' +
  readFileSync(join(root, 'apps-script/Code.gs'), 'utf8');

// A sandbox "deployment". `store` (the CacheService backing map) can be SHARED between two loads to
// simulate two separate requests hitting the same script cache. `rows` is mutable so a test can change
// the underlying sheet and prove staleness/invalidation.
function makeDeployment(store) {
  const reads = {};
  const rows = {
    Config: [['key', 'value'], ['approval_threshold', '3000'], ['sla_days', 'x']],
    Houses: [['name', 'status', 'cluster'], ['רמות השבים', 'open', 'sharon']],
    Users: [['name', 'role', 'house', 'active', 'pin_hash'], ['אולגה', 'ops_manager', '', 'TRUE', '']],
    Requests: [['id', 'house', 'status', 'created_at'], ['r1', 'רמות השבים', 'דרישה', '2026-07-01']],
  };
  function sheet(name) {
    return {
      getDataRange: () => ({ getValues: () => { reads[name] = (reads[name] || 0) + 1; return rows[name]; } }),
      getRange: () => ({ getValues: () => [rows[name][0]] }),
      getLastColumn: () => rows[name][0].length,
      getLastRow: () => rows[name].length,
    };
  }
  const sandbox = {
    Logger: { log: () => {} },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => { sandbox.__out = s; return { setMimeType: () => ({ _text: s }) }; } },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n) => (rows[n] ? sheet(n) : null) }) },
    CacheService: { getScriptCache: () => ({
      get: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      put: (k, v) => { store[k] = v; },
      remove: (k) => { delete store[k]; },
    }) },
    console,
  };
  const keys = Object.keys(sandbox).filter((k) => k !== '__out');
  const factory = new Function(...keys, CODE +
    '\n;return { readReference_, invalidateReference_, getHouses, getUsers, getConfig, getAllConfig, getRequests };');
  const api = factory(...keys.map((k) => sandbox[k]));
  return { api, reads, rows, store };
}

test('per-execution memo: repeated reference reads in ONE request hit the sheet only once', () => {
  const d = makeDeployment({});
  d.api.getHouses();
  d.api.getHouses();
  d.api.getConfig('approval_threshold');
  d.api.getConfig('sla_days'); // getAllConfig again — must NOT re-read Config
  assert.equal(d.reads.Houses, 1, 'Houses read once despite two getHouses()');
  assert.equal(d.reads.Config, 1, 'Config read once despite two getConfig()');
});

test('cross-request CacheService: a second request served the reference sheet from cache (0 reads)', () => {
  const store = {}; // shared script cache
  const first = makeDeployment(store);
  first.api.getHouses();
  assert.equal(first.reads.Houses, 1);
  // A brand-new execution (fresh memo) sharing the same script cache:
  const second = makeDeployment(store);
  const houses = second.api.getHouses();
  assert.equal(second.reads.Houses, undefined, 'second request hit CacheService, no sheet read');
  assert.equal(houses[0].name, 'רמות השבים');
});

test('WRITE → NEXT READ FRESH: invalidateReference_ drops memo + cache so stale data is never served', () => {
  const store = {};
  const d = makeDeployment(store);
  assert.equal(d.api.getHouses()[0].status, 'open');
  assert.equal(d.reads.Houses, 1);

  // Underlying sheet changes, but without invalidation the cache still serves the OLD value...
  d.rows.Houses = [['name', 'status', 'cluster'], ['רמות השבים', 'pre-opening', 'sharon']];
  assert.equal(d.api.getHouses()[0].status, 'open', 'still cached (memo/CacheService) — proves caching');
  assert.equal(d.reads.Houses, 1, 'no re-read while cached');

  // ...invalidation (what every writer of a reference sheet calls) drops BOTH the per-execution memo AND
  // the shared CacheService entry — proven directly on the backing store.
  d.api.invalidateReference_('Houses');
  assert.equal(Object.prototype.hasOwnProperty.call(store, 'refsheet:Houses'), false, 'CacheService entry evicted');

  // The next read therefore hits the sheet and returns the FRESH value.
  assert.equal(d.api.getHouses()[0].status, 'pre-opening', 'fresh value after invalidation');
  assert.equal(d.reads.Houses, 2, 're-read the sheet exactly once after invalidation');
});

test('invalidation is per-sheet: invalidating Houses does not evict Config', () => {
  const store = {};
  const d = makeDeployment(store);
  d.api.getConfig('approval_threshold');
  d.api.getHouses();
  d.api.invalidateReference_('Houses');
  const d2 = makeDeployment(store);
  d2.api.getConfig('approval_threshold'); // Config still cached
  d2.api.getHouses();                      // Houses evicted → fresh read
  assert.equal(d2.reads.Config, undefined, 'Config survived the Houses invalidation');
  assert.equal(d2.reads.Houses, 1, 'Houses was re-read');
});

test('Users is NOT reference-cached — the auth roster always reads live (login must never see a stale hash)', () => {
  const store = {};
  const first = makeDeployment(store);
  first.api.getUsers();
  assert.equal(first.reads.Users, 1);
  const second = makeDeployment(store); // fresh execution, shared script cache
  second.api.getUsers();
  assert.equal(second.reads.Users, 1, 'Users re-read every request — never served from the reference cache');
  assert.equal(Object.prototype.hasOwnProperty.call(store, 'refsheet:Users'), false, 'Users never written to the shared cache');
});

test('Requests is NOT reference-cached — it always reads live (write-freshness preserved)', () => {
  const store = {};
  const first = makeDeployment(store);
  first.api.getRequests();
  const second = makeDeployment(store);
  second.api.getRequests();
  assert.equal(second.reads.Requests, 1, 'Requests re-read every request — never served from the ref cache');
});
