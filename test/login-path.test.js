// test/login-path.test.js — the LIVE login path end-to-end: Node auth primitives (src/auth.js) driving
// the REAL Code.gs doGet('users') roster read, across the Node⇄Apps-Script boundary. Not just pure
// functions: it loads the actual apps-script .gs files in a sandbox and runs the exact roster-verify
// logic from server.js handleLogin against them.
//
// Regression guard for the #59 fallout: getUsers() had been routed through the cross-request reference
// cache, so a valid login was verified against a STALE roster (e.g. a just-set pin_hash) and rejected —
// "שם או קוד שגויים" for correct credentials. Users must be read LIVE. These tests fail if Users is ever
// cached cross-request again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import crypto from 'node:crypto';
import { hashPin, verifyPin, checkPin, rosterProof } from '../src/auth.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CODE = readFileSync(join(root, 'apps-script/digest.gs'), 'utf8') + '\n' +
  readFileSync(join(root, 'apps-script/Code.gs'), 'utf8');

const SECRET = 'session-secret-for-tests';
const APP_PIN = 'shared-tier-b-pin';

// A sandbox "deployment" sharing a CacheService `store` (so a second request sees whatever the first
// cached). `usersRows` is the mutable Users sheet so a test can change a pin_hash between requests.
function deployment(store, usersRows) {
  const rows = {
    Config: [['key', 'value'], ['approval_threshold', '3000']],
    Houses: [['name', 'status', 'cluster'], ['רמות השבים', 'open', 'sharon']],
    Users: usersRows,
  };
  const sheet = (name) => ({
    getDataRange: () => ({ getValues: () => rows[name] }),
    getRange: () => ({ getValues: () => [rows[name][0]] }),
    getLastColumn: () => rows[name][0].length, getLastRow: () => rows[name].length,
  });
  const sandbox = {
    Logger: { log: () => {} },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ setMimeType: () => s }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n) => (rows[n] ? sheet(n) : null) }) },
    CacheService: { getScriptCache: () => ({
      get: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      put: (k, v) => { store[k] = v; }, remove: (k) => { delete store[k]; },
    }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === 'SESSION_SECRET' ? SECRET : null) }) },
    Utilities: { computeHmacSha256Signature: (data, key) => {
      const h = crypto.createHmac('sha256', Buffer.from(key, 'utf8')).update(Buffer.from(data, 'utf8')).digest();
      return Array.from(h).map((b) => (b > 127 ? b - 256 : b)); // Apps Script returns signed bytes
    } },
    console,
  };
  const keys = Object.keys(sandbox);
  const factory = new Function(...keys, CODE + '\n;return { doGet };');
  return { api: factory(...keys.map((k) => sandbox[k])), rows };
}

// The EXACT roster-verify logic from server.js handleLogin (lines 320-345), run against Code.gs doGet.
function login(dep, name, pw) {
  const raw = dep.api.doGet({ parameter: { action: 'users', auth: rosterProof(SECRET) } });
  const j = JSON.parse(raw);
  const users = (j && j.data) || null;
  if (!users) return { ok: false, reason: 'roster-unavailable' };
  const isActive = (u) => u.active === true || String(u.active).toUpperCase() === 'TRUE';
  const user = users.find((u) => String(u.name) === String(name) && isActive(u));
  let ok = false;
  if (user) {
    const pinHash = String(user.pin_hash || '');
    if (pinHash) ok = verifyPin(pw, pinHash);
    else if (user.role === 'coordinator' || user.role === 'maintenance') ok = checkPin(pw, APP_PIN);
  }
  return { ok, foundUser: !!user };
}

function usersSheet(olgaHash) {
  return [['name', 'role', 'house', 'active', 'pin_hash'],
    ['אולגה', 'ops_manager', '', true, olgaHash],
    ['רועי', 'field_ops', '', true, ''],
    ['מזכירה', 'coordinator', 'רמות השבים', true, '']];
}

test('valid login succeeds through the FULL path (Node verifyPin + real Code.gs doGet roster)', () => {
  const dep = deployment({}, usersSheet(hashPin('correct horse', 100000)));
  assert.deepEqual(login(dep, 'אולגה', 'correct horse'), { ok: true, foundUser: true });
});

test('invalid password STILL fails (generic reject), valid user', () => {
  const dep = deployment({}, usersSheet(hashPin('correct horse', 100000)));
  assert.deepEqual(login(dep, 'אולגה', 'wrong'), { ok: false, foundUser: true });
});

test('tier-B shared PIN path still works for a coordinator with no personal hash', () => {
  const dep = deployment({}, usersSheet(hashPin('x', 100000)));
  assert.equal(login(dep, 'מזכירה', APP_PIN).ok, true);
  assert.equal(login(dep, 'מזכירה', 'nope').ok, false);
});

test('REGRESSION: a pin_hash set AFTER an earlier roster read is seen on the NEXT login (roster read live, not stale-cached)', () => {
  const store = {};                       // shared script cache across the two requests
  const usersRows = usersSheet('');       // olga has NO hash yet — an earlier read populates any cache
  const first = deployment(store, usersRows);
  assert.equal(login(first, 'אולגה', 'set-later').ok, false, 'no hash yet → login fails (expected)');

  // Admin sets אולגה\'s password (sheet row mutated). A cross-request cache of Users would keep serving
  // the OLD empty-hash roster; a live read sees the new hash immediately.
  usersRows[1][4] = hashPin('set-later', 100000);
  const second = deployment(store, usersRows);
  assert.equal(login(second, 'אולגה', 'set-later').ok, true, 'live roster read → new pin_hash visible, login succeeds');
});

test('security: a PUBLIC roster read (no proof) still strips pin_hash', () => {
  const dep = deployment({}, usersSheet(hashPin('correct horse', 100000)));
  const raw = dep.api.doGet({ parameter: { action: 'users' } }); // no auth
  const olga = JSON.parse(raw).data.find((u) => u.name === 'אולגה');
  assert.equal('pin_hash' in olga, false, 'pin_hash must never be returned to an unauthenticated caller');
});

test('security: pin_hash is NEVER written into the shared CacheService (no refsheet:Users entry)', () => {
  const store = {};
  const dep = deployment(store, usersSheet(hashPin('correct horse', 100000)));
  dep.api.doGet({ parameter: { action: 'users', auth: rosterProof(SECRET) } });
  assert.equal(Object.prototype.hasOwnProperty.call(store, 'refsheet:Users'), false,
    'the Users roster (with pin_hash) must not sit in the shared script cache');
});
