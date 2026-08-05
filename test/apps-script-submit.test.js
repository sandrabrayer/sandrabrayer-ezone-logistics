// test/apps-script-submit.test.js — the PUBLIC create in the REAL Apps Script doPost (entry-flow redesign).
// Loads the actual apps-script .gs files in a sandbox and drives doPost directly, proving the ONE tokenless
// write (createRequestPublic) is proof-gated + strictly validated INDEPENDENTLY of the Node gateway, appends
// a well-formed request row, and that no OTHER action is reachable without a valid session token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import crypto from 'node:crypto';
import { submitProof } from '../src/auth.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Apps Script shares ONE global scope across all .gs files; concatenate them like the runtime does.
const CODE = readFileSync(join(root, 'apps-script/digest.gs'), 'utf8') + '\n' +
  readFileSync(join(root, 'apps-script/Code.gs'), 'utf8');

const SECRET = 'session-secret-for-tests';

// A sandbox "deployment". `appended` records rows written to Requests. Config carries the thresholds the
// create path derives from; the digest prop is UNSET so rebuildDigest() no-ops (nothing to write).
function deployment() {
  const appended = [];
  const rows = {
    Config: [['key', 'value'], ['approval_threshold', '3000'], ['sla_days', 'רגיל:7,דחוף:2,חירום:0']],
    Houses: [['name', 'status', 'cluster'], ['רמות השבים', 'open', 'sharon'], ['קיסריה עפרוני', 'open', 'caesarea']],
    Requests: [['id', 'created_at', 'created_by', 'house', 'category', 'description', 'location_in_house', 'urgency', 'estimated_cost', 'status', 'due_at']],
  };
  const sheet = (name) => ({
    getDataRange: () => ({ getValues: () => rows[name] }),
    getRange: () => ({ getValues: () => [rows[name][0]] }),
    getLastColumn: () => rows[name][0].length,
    getLastRow: () => rows[name].length,
    appendRow: (row) => { if (name === 'Requests') appended.push(row); rows[name].push(row); },
  });
  const sandbox = {
    Logger: { log: () => {} },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ setMimeType: () => s }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n) => (rows[n] ? sheet(n) : null) }), openById: () => { throw new Error('no digest'); } },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === 'SESSION_SECRET' ? SECRET : null) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Utilities: { computeHmacSha256Signature: (data, key) => {
      const h = crypto.createHmac('sha256', Buffer.from(key, 'utf8')).update(Buffer.from(data, 'utf8')).digest();
      return Array.from(h).map((b) => (b > 127 ? b - 256 : b));
    } },
    console,
  };
  const keys = Object.keys(sandbox);
  const factory = new Function(...keys, CODE + '\n;return { doPost };');
  return { api: factory(...keys.map((k) => sandbox[k])), appended, rows };
}

const post = (api, obj) => JSON.parse(api.doPost({ postData: { contents: JSON.stringify(obj) } }));
const PROOF = submitProof(SECRET);
const PAYLOAD = { created_by: 'שירה', house: 'קיסריה עפרוני', category: 'רכישה', urgency: 'רגיל', description: 'נייר', location_in_house: 'מחסן' };

test('createRequestPublic with the correct proof appends a well-formed request (no token)', () => {
  const dep = deployment();
  const j = post(dep.api, { action: 'createRequestPublic', payload: PAYLOAD, proof: PROOF });
  assert.equal(j.ok, true);
  assert.match(j.id, /^REQ-/);
  assert.equal(dep.appended.length, 1, 'exactly one row appended');
  const headers = dep.rows.Requests[0];
  const row = dep.appended[0];
  const get = (k) => row[headers.indexOf(k)];
  assert.equal(get('created_by'), 'שירה');
  assert.equal(get('house'), 'קיסריה עפרוני');
  assert.equal(get('category'), 'רכישה');
  assert.equal(get('status'), 'דרישה');
  assert.equal(get('estimated_cost'), '', 'a public submit never carries a cost');
});

test('createRequestPublic with a WRONG proof is Unauthorized (nothing appended)', () => {
  const dep = deployment();
  const j = post(dep.api, { action: 'createRequestPublic', payload: PAYLOAD, proof: 'deadbeef' });
  assert.equal(j.ok, false);
  assert.equal(j.error, 'Unauthorized');
  assert.equal(dep.appended.length, 0);
});

test('createRequestPublic with NO proof is Unauthorized', () => {
  const dep = deployment();
  const j = post(dep.api, { action: 'createRequestPublic', payload: PAYLOAD });
  assert.equal(j.ok, false);
  assert.equal(j.error, 'Unauthorized');
  assert.equal(dep.appended.length, 0);
});

test('createRequestPublic validates strictly: unknown house and bad category are rejected', () => {
  const dep = deployment();
  const unknownHouse = post(dep.api, { action: 'createRequestPublic', payload: { ...PAYLOAD, house: 'בית-מזויף' }, proof: PROOF });
  assert.equal(unknownHouse.ok, false);
  assert.equal(unknownHouse.error, 'Unknown house');
  const badCat = post(dep.api, { action: 'createRequestPublic', payload: { ...PAYLOAD, category: 'nope' }, proof: PROOF });
  assert.equal(badCat.ok, false);
  assert.equal(dep.appended.length, 0, 'no invalid row is ever appended');
});

test('the submit proof does NOT unlock any other action — a tokenless privileged write is still refused', () => {
  const dep = deployment();
  // Even presenting the (valid) submit proof, a different action must fall through to the token check.
  const j = post(dep.api, { action: 'approve', payload: { id: 'X' }, proof: PROOF });
  assert.equal(j.ok, false);
  assert.equal(j.error, 'Unauthorized', 'only createRequestPublic is tokenless; every other action needs a token');
});

test('the TRUSTED createRequest still requires a session token (no token → Unauthorized)', () => {
  const dep = deployment();
  const j = post(dep.api, { action: 'createRequest', payload: PAYLOAD });
  assert.equal(j.ok, false);
  assert.equal(j.error, 'Unauthorized');
  assert.equal(dep.appended.length, 0);
});
