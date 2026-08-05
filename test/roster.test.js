// test/roster.test.js — the shared users-read path at the HTTP layer (entry-flow bug fixes). Drives the
// REAL requestHandler against a mock Apps Script roster and proves:
//   • the roster endpoint (/api/data?action=users) returns ALL active users, normalized (trimmed) and
//     pin_hash-free, with inactive users excluded — the single source both the dashboard filter and the
//     injected login dropdown consume (fixes the "shows only one name / partial roster" symptoms);
//   • login succeeds for every seeded user that HAS a code (tier A personal password; tier B shared PIN);
//   • a name with a trailing space in the sheet STILL logs in (the root-cause fix: trim-tolerant match —
//     previously rejected with "שם או קוד שגויים");
//   • login fails closed on a wrong code, and a user with no login path (ceo, no pin_hash) is denied.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { signToken, rosterProof, hashPin } from '../src/auth.js';

const SECRET = 'k'.repeat(32);
const APP_PIN = '123456';
const ROY_PW = 'roy-personal-pw';
const OLGA_PW = 'olga-personal-pw';

// Full seeded roster (9 active) + one inactive user to prove active-filtering. רועי/אולגה carry a personal
// pin_hash (tier A); tier B (maintenance + coordinators) have none and use the shared APP_PIN; סנדרה (ceo)
// has none and no tier-B role, so she has NO login path (correctly). 'צחי' is stored WITH a trailing space
// to exercise the trim-tolerant login match.
const ROSTER = [
  { name: 'רועי', role: 'field_ops', house: '', active: 'TRUE', pin_hash: hashPin(ROY_PW, 100000) },
  { name: 'אולגה', role: 'ops_manager', house: '', active: 'TRUE', pin_hash: hashPin(OLGA_PW, 100000) },
  { name: 'סנדרה', role: 'ceo', house: '', active: 'TRUE', pin_hash: '' },
  { name: 'רמי', role: 'maintenance', house: 'sharon', active: 'TRUE', pin_hash: '' },
  { name: 'צחי ', role: 'maintenance', house: 'caesarea,north', active: 'TRUE', pin_hash: '' }, // trailing space (sheet typo)
  { name: 'שירה', role: 'coordinator', house: 'קיסריה עפרוני', active: 'TRUE', pin_hash: '' },
  { name: 'יעקב', role: 'coordinator', house: 'קיסריה ריהאב', active: 'TRUE', pin_hash: '' },
  { name: 'אורן', role: 'coordinator', house: 'רעננה אשר', active: 'TRUE', pin_hash: '' },
  { name: 'אביב', role: 'coordinator', house: 'רמות השבים', active: 'TRUE', pin_hash: '' },
  { name: 'ישן', role: 'coordinator', house: 'רעננה אשר', active: 'FALSE', pin_hash: '' }, // inactive → excluded
];

const upstream = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'GET' && u.searchParams.get('action') === 'users') {
    // Mirror Code.gs usersForRead_: pin_hash returned ONLY to the server-to-server roster proof.
    const withHash = u.searchParams.get('auth') === rosterProof(SECRET);
    const data = ROSTER.map((r) => (withHash ? r : (({ pin_hash, ...rest }) => rest)(r)));
    return res.end(JSON.stringify({ ok: true, data }));
  }
  res.end(JSON.stringify({ ok: false }));
});

let app, base, resetLogin;
before(async () => {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  process.env.APPS_SCRIPT_EXEC_URL = `http://127.0.0.1:${upstream.address().port}/exec`;
  process.env.APP_PIN = APP_PIN; process.env.SESSION_SECRET = SECRET; process.env.SESSION_DAYS = '7';
  const mod = await import('../src/server.js');
  resetLogin = () => mod._loginAttempts.clear();
  app = createServer(mod.requestHandler);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.address().port}`;
});
after(async () => { await new Promise((r) => app.close(r)); await new Promise((r) => upstream.close(r)); });
beforeEach(() => resetLogin());

const login = (name, pin) => fetch(`${base}/api/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, pin }),
});

test('roster endpoint returns ALL active users, trimmed, pin_hash-free (inactive excluded)', async () => {
  const token = signToken(SECRET, 7, { name: 'אולגה', role: 'ops_manager', scope: '' });
  const res = await fetch(`${base}/api/data?action=users`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  const names = j.data.map((u) => u.name);
  assert.deepEqual(names.sort(), ['אביב', 'אולגה', 'אורן', 'יעקב', 'סנדרה', 'רועי', 'רמי', 'שירה', 'צחי'].sort(),
    'all 9 active users, trimmed; the inactive user is excluded');
  assert.ok(!names.includes('ישן'), 'inactive user must not appear');
  assert.ok(j.data.every((u) => !('pin_hash' in u)), 'pin_hash is never exposed to the browser');
  assert.ok(j.data.some((u) => u.name === 'צחי'), 'a trailing-space sheet name is trimmed in the roster');
});

test('the roster is manager-only (a coordinator token gets 403)', async () => {
  const token = signToken(SECRET, 7, { name: 'שירה', role: 'coordinator', scope: 'קיסריה עפרוני' });
  const res = await fetch(`${base}/api/data?action=users`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 403);
});

test('login succeeds for every seeded user that has a code (tier A password + tier B shared PIN)', async () => {
  const cases = [
    ['רועי', ROY_PW], ['אולגה', OLGA_PW],           // tier A — personal password
    ['רמי', APP_PIN], ['צחי', APP_PIN],             // tier B maintenance (צחי stored with a trailing space)
    ['שירה', APP_PIN], ['יעקב', APP_PIN], ['אורן', APP_PIN], ['אביב', APP_PIN], // tier B coordinators
  ];
  for (const [name, pin] of cases) {
    resetLogin();
    const res = await login(name, pin);
    assert.equal(res.status, 200, `${name} must log in with the correct code`);
    const j = await res.json();
    assert.ok(j.ok && j.token, `${name} must receive a session token`);
  }
});

test('login is trim-tolerant: the correct code logs in even though the sheet name has a trailing space', async () => {
  // 'צחי' is stored as 'צחי ' in the sheet; logging in as 'צחי' used to fail with "שם או קוד שגויים".
  const res = await login('צחי', APP_PIN);
  assert.equal(res.status, 200);
});

test('login fails closed on a wrong code (generic 401, no token)', async () => {
  const bad = await login('שירה', 'nope-wrong');
  assert.equal(bad.status, 401);
  const badA = await login('רועי', 'not-roys-password');
  assert.equal(badA.status, 401);
});

test('a user with no login path (ceo, no pin_hash) is denied even with the shared PIN', async () => {
  const res = await login('סנדרה', APP_PIN);
  assert.equal(res.status, 401, 'ceo has no tier-B role and no personal hash → no login path');
});

test('an unknown name is denied (fail closed)', async () => {
  const res = await login('מישהו-לא-קיים', APP_PIN);
  assert.equal(res.status, 401);
});
