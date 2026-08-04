// test/pagedata.test.js — the aggregated per-page read (perf round-2) + the Node micro-cache. A mock
// Apps Script upstream lets us COUNT Node→upstream round-trips (the ~1-3s-each cost) and assert the
// role gate + scoping match the individual reads exactly, that stable reads are cached, and that users
// and requests are NEVER cached.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { signToken } from '../src/auth.js';

// --- Mock Apps Script upstream (records every hit) ---
const HOUSES = [{ name: 'רמות השבים', cluster: 'sharon', technician: 'רמי' }, { name: 'קיסריה עפרוני', cluster: 'caesarea', technician: 'צחי' }];
const REQUESTS = [{ id: 'r1', house: 'רמות השבים', status: 'דרישה' }, { id: 'r2', house: 'קיסריה עפרוני', status: 'דרישה' }];
const CONFIG = { approval_threshold: 3000, event_types: 'בטיחות|אחר' };
const SHEET = { houses: HOUSES, requests: REQUESTS, config: CONFIG, findings: [], inspections: [], inventoryItems: [], inventoryCounts: [], checklist: [], technicians: [], events: [] };
let hits = [];
const upstream = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const action = u.searchParams.get('action');
  hits.push({ action, sheets: u.searchParams.get('sheets') });
  let data;
  if (action === 'bundle') {
    data = {};
    for (const s of (u.searchParams.get('sheets') || '').split(',')) if (s in SHEET) data[s] = SHEET[s];
  } else if (action in SHEET) { data = SHEET[action]; } else { data = null; }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data == null ? { ok: false } : { ok: true, data }));
});

let app, base, resetNodeCache;
const SECRET = 'k'.repeat(32);
before(async () => {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  process.env.APPS_SCRIPT_EXEC_URL = `http://127.0.0.1:${upstream.address().port}/exec`;
  process.env.APP_PIN = '123456'; process.env.SESSION_SECRET = SECRET; process.env.SESSION_DAYS = '7';
  const mod = await import('../src/server.js');
  resetNodeCache = mod._resetNodeCache;
  app = createServer(mod.requestHandler);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.address().port}`;
});
after(async () => { await new Promise((r) => app.close(r)); await new Promise((r) => upstream.close(r)); });
beforeEach(() => { hits = []; resetNodeCache(); });

const tok = (role) => signToken(SECRET, 7, { name: role, role, scope: role === 'coordinator' ? 'רמות השבים' : '' });
const pageData = (page, role, hdr) => fetch(`${base}/api/data?action=pageData&page=${page}`, { headers: hdr === null ? {} : { Authorization: `Bearer ${tok(role)}` } });
const read = (action, role) => fetch(`${base}/api/data?action=${action}`, { headers: { Authorization: `Bearer ${tok(role)}` } });
const countAction = (a) => hits.filter((h) => h.action === a).length;

// ---- auth + shape ----

test('pageData without a token → 401', async () => {
  assert.equal((await pageData('dashboard', 'ceo', null)).status, 401);
});

test('pageData unknown page → 400', async () => {
  assert.equal((await pageData('nope', 'ceo')).status, 400);
});

test('manager dashboard pageData → 200 with all sheets, in ONE upstream bundle round-trip', async () => {
  const r = await pageData('dashboard', 'ceo');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(Object.keys(j.data).sort(), ['config', 'findings', 'houses', 'inspections', 'requests']);
  assert.equal(j.data.config.approval_threshold, 3000);
  assert.equal(countAction('bundle'), 1, 'exactly ONE upstream round-trip for the whole page');
  assert.equal(countAction('requests'), 0, 'no separate per-action calls');
});

// ---- ROUND-TRIP MEASUREMENT (the whole point) ----

test('MEASURE: a dashboard load is 1 upstream round-trip (was 5 individual reads)', async () => {
  await pageData('dashboard', 'ceo');
  const roundTrips = hits.length;
  assert.equal(roundTrips, 1, `dashboard: ${roundTrips} upstream round-trip(s) via pageData (individual reads were 5)`);
});

test('MEASURE: warm cache — houses/config served from Node memory, bundle shrinks; tab switch reuses them', async () => {
  await pageData('dashboard', 'ceo');                 // cold: bundle all 5
  const coldSheets = hits.find((h) => h.action === 'bundle').sheets.split(',').sort();
  assert.deepEqual(coldSheets, ['config', 'findings', 'houses', 'inspections', 'requests']);
  hits = [];
  await pageData('dashboard', 'ceo');                 // warm: houses+config from Node cache
  const warm = hits.find((h) => h.action === 'bundle');
  assert.ok(!warm.sheets.split(',').includes('houses'), 'houses served from Node cache (not re-fetched)');
  assert.ok(!warm.sheets.split(',').includes('config'), 'config served from Node cache');
  hits = [];
  await pageData('inventory', 'ceo');                 // tab switch: houses already cached
  const inv = hits.find((h) => h.action === 'bundle');
  assert.ok(!inv.sheets.split(',').includes('houses'), 'tab switch reuses cached houses — no Apps Script hop for it');
  assert.deepEqual(inv.sheets.split(',').sort(), ['inventoryCounts', 'inventoryItems']);
});

// ---- role gate (identical to the individual reads) ----

for (const role of ['coordinator', 'maintenance']) {
  test(`tier-B (${role}) is 403 on manager-only pages (dashboard/workorders/reports/inventory/inspection), no upstream call`, async () => {
    for (const page of ['dashboard', 'workorders', 'reports', 'inventory', 'inspection']) {
      const r = await pageData(page, role);
      assert.equal(r.status, 403, `${role} × ${page} must be 403`);
    }
    assert.equal(hits.length, 0, 'a refused pageData never calls upstream');
  });
}

test('coordinator CAN aggregate a page it may open (events: config+houses) — gate passes', async () => {
  const r = await pageData('events', 'coordinator');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(Object.keys(j.data).sort(), ['config', 'houses']);
});

test('managers get every page; requests are unscoped for them (both houses present)', async () => {
  const j = await (await pageData('dashboard', 'ceo')).json();
  assert.equal(j.data.requests.length, 2);
});

// ---- scoping parity: the individual requests read still scopes tier B ----

test('the individual requests read still scopes a coordinator to their own house', async () => {
  const j = await (await read('requests', 'coordinator')).json();
  assert.deepEqual(j.data.map((r) => r.id), ['r1'], 'coordinator sees only their house');
});

// ---- Node cache NEVER serves users or requests ----

test('Node cache NEVER caches users: two roster reads both hit upstream', async () => {
  await read('users', 'ceo');
  await read('users', 'ceo');
  assert.equal(countAction('users'), 2, 'users is read live every time — never cached');
});

test('Node cache NEVER caches requests: two reads both hit upstream', async () => {
  await read('requests', 'ceo');
  await read('requests', 'ceo');
  assert.equal(countAction('requests'), 2, 'requests read live every time — never cached');
});

// ---- stable-read caching + invalidation ----

test('houses is cached: second read served from Node memory (0 extra upstream hits)', async () => {
  await read('houses', 'ceo');
  assert.equal(countAction('houses'), 1);
  await read('houses', 'ceo');
  assert.equal(countAction('houses'), 1, 'second houses read served from the Node micro-cache');
});

test('config + technicians are cached the same way; users/requests are not', async () => {
  await read('config', 'ceo'); await read('config', 'ceo');
  await read('technicians', 'ceo'); await read('technicians', 'ceo');
  assert.equal(countAction('config'), 1, 'config cached');
  assert.equal(countAction('technicians'), 1, 'technicians cached');
});

test('cache invalidation: _resetNodeCache() forces the next stable read to re-fetch', async () => {
  await read('houses', 'ceo');
  assert.equal(countAction('houses'), 1);
  resetNodeCache();
  await read('houses', 'ceo');
  assert.equal(countAction('houses'), 2, 'after reset the next read hits upstream again');
});
