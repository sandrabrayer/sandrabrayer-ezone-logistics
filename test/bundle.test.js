// test/bundle.test.js — the Apps Script `bundle` doGet action (perf round-2): reads many sheets in ONE
// execution. Loads the real .gs in a sandbox and asserts the returned shape, that houses/config go
// through the reference cache, that unknown sheets are skipped, and that 'users' is NEVER bundleable
// (it carries pin_hash + needs the roster proof — must stay on the dedicated usersForRead_ path).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CODE = readFileSync(join(root, 'apps-script/digest.gs'), 'utf8') + '\n' +
  readFileSync(join(root, 'apps-script/Code.gs'), 'utf8');

function load() {
  const reads = {};
  const rows = {
    Config: [['key', 'value'], ['approval_threshold', '3000']],
    Houses: [['name', 'status', 'cluster'], ['רמות השבים', 'open', 'sharon']],
    Users: [['name', 'role', 'house', 'active', 'pin_hash'], ['אולגה', 'ops_manager', '', 'TRUE', 'SECRET_HASH']],
    Requests: [['id', 'house', 'status'], ['r1', 'רמות השבים', 'דרישה']],
    InspectionFindings: [['id', 'inspection_id'], ['f1', 'i1']],
  };
  const sheet = (n) => ({
    getDataRange: () => ({ getValues: () => { reads[n] = (reads[n] || 0) + 1; return rows[n]; } }),
    getRange: () => ({ getValues: () => [rows[n][0]] }), getLastColumn: () => rows[n][0].length, getLastRow: () => rows[n].length,
  });
  const store = {};
  const sandbox = {
    Logger: { log: () => {} },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => { sandbox.__o = s; return { setMimeType: () => s }; } },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n) => (rows[n] ? sheet(n) : null) }) },
    CacheService: { getScriptCache: () => ({ get: (k) => (k in store ? store[k] : null), put: (k, v) => { store[k] = v; }, remove: (k) => { delete store[k]; } }) },
    console,
  };
  const keys = Object.keys(sandbox).filter((k) => k !== '__o');
  const factory = new Function(...keys, CODE + '\n;return { doGet };');
  return { api: factory(...keys.map((k) => sandbox[k])), reads };
}

const call = (api, sheets) => JSON.parse(api.doGet({ parameter: { action: 'bundle', sheets } }));

test('bundle returns each requested read-sheet in one response (houses, requests, config, findings)', () => {
  const { api } = load();
  const j = call(api, 'houses,requests,config,findings');
  assert.equal(j.ok, true);
  assert.deepEqual(Object.keys(j.data).sort(), ['config', 'findings', 'houses', 'requests']);
  assert.equal(j.data.houses[0].name, 'רמות השבים');
  assert.equal(j.data.requests[0].id, 'r1');
  assert.equal(j.data.config.approval_threshold, 3000); // config is a key→value map
  assert.equal(j.data.findings[0].id, 'f1');
});

test('bundle NEVER returns users, even when asked (pin_hash must not leak via the generic multi-read)', () => {
  const { api } = load();
  const j = call(api, 'users,houses');
  assert.equal(j.ok, true);
  assert.ok(!('users' in j.data), 'users is not a bundleable sheet');
  assert.ok('houses' in j.data);
});

test('bundle skips unknown/duplicate sheet names', () => {
  const { api } = load();
  const j = call(api, 'houses,bogus,houses, ,requests');
  assert.deepEqual(Object.keys(j.data).sort(), ['houses', 'requests']);
});

test('bundle reads each requested sheet exactly once in the single execution', () => {
  const { api, reads } = load();
  call(api, 'houses,requests,findings');
  assert.equal(reads.Houses, 1);
  assert.equal(reads.Requests, 1);
  assert.equal(reads.InspectionFindings, 1);
});
