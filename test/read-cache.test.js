// test/read-cache.test.js — the Node READ CACHE (perf round-4, the ezone-outpatient server.js pattern).
//
// Drives the REAL gateway against a FAKE Apps Script upstream whose behaviour can be switched per test
// (ok / slow / http-500 / connection-drop) and which RECORDS every hit, and locks:
//   - X-Cache: MISS on the first read, HIT within the TTL, STALE when the upstream fails inside the 10-min
//     fallback window; beyond the window an upstream failure is a 502 again;
//   - the 60 s read TTL vs the 120 s stable TTL (houses/config/technicians), aged with a test hook;
//   - ?fresh=1 bypasses the cache (and repopulates it);
//   - IN-FLIGHT DEDUPE: N concurrent misses for one action → ONE upstream call;
//   - INVALIDATION on EVERY write action (approve, reject, defer, assign, block, close, create, edit, delete,
//     management writes …): the next dynamic read refetches, while houses/config/technicians stay cached;
//   - parameterised reads (house / month / week_start) get their own cache keys;
//   - `users` is NEVER cached (no X-Cache header, every read live);
//   - the /management POST is cached PER PERIOD (HIT / MISS / STALE, fresh bypass, cleared by writes);
//   - pageData: X-Cache HIT on a repeat load, the workorders readiness tabs ride in the ONE bundle call,
//     a sheet an older Apps Script omits from the bundle is fetched individually (never rendered empty),
//     and a down upstream serves STALE page data instead of a 502;
//   - the '/' landing no longer fires a houses probe before forwarding to /dashboard.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { signToken } from '../src/auth.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'k'.repeat(40);
const APPROVER = 'olga-77';

const HOUSES = [{ name: 'רמות השבים', cluster: 'sharon' }, { name: 'קיסריה עפרוני', cluster: 'caesarea' }];
const REQUESTS = [{ id: 'R1', house: 'רמות השבים', status: 'דרישה', urgency: 'רגיל' }, { id: 'R2', house: 'קיסריה עפרוני', status: 'דרישה', urgency: 'רגיל' }];
const SHEET = {
  houses: HOUSES, config: { approval_threshold: 3000 }, technicians: [{ name: 'רמי' }],
  requests: REQUESTS, findings: [{ id: 'F1' }], inspections: [], inventoryItems: [], inventoryCounts: [], checklist: [], events: [],
  openingChecklist: [{ id: 'O1', house: 'שדה אליעזר', item: 'x', done: 'FALSE' }],
  emergencyReadiness: [{ id: 'E1', house: 'רמות השבים', item: 'y', done: 'TRUE' }],
  preventiveDaily: [{ house: 'רמות השבים', date: '2026-09-04', item: 'מים', done: 'TRUE' }, { house: 'קיסריה עפרוני', date: '2026-09-04', item: 'מים', done: 'TRUE' }],
  trainings: [], users: [{ name: 'רועי', role: 'field_ops', active: 'TRUE' }],
};
// The mutable "sheet version": bumped by tests to prove a refetch actually returned NEW data.
let version = 1;
let mode = 'ok';          // 'ok' | 'slow' | 'http500' | 'drop' | 'noBundle' | 'oldBundle'
let slowMs = 150;
let hits = [];
const upstream = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const respond = () => {
    if (mode === 'drop') return req.socket.destroy();
    if (mode === 'http500') { res.writeHead(500, { 'Content-Type': 'text/html' }); return res.end('<html>Apps Script error</html>'); }
    if (req.method === 'POST') {
      let raw = ''; req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body = {}; try { body = JSON.parse(raw || '{}'); } catch (e) { body = {}; }
        hits.push({ method: 'POST', action: body.action, period: body.payload && body.payload.period });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (body.action === 'managementData') return res.end(JSON.stringify({ ok: true, data: { period: (body.payload && body.payload.period) || '2026-09', version } }));
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    const action = u.searchParams.get('action');
    hits.push({ method: 'GET', action, sheets: u.searchParams.get('sheets'), house: u.searchParams.get('house') });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (action === 'bundle') {
      if (mode === 'noBundle') return res.end(JSON.stringify({ ok: false, error: 'Unknown or missing action' }));
      const data = {};
      for (const s of (u.searchParams.get('sheets') || '').split(',')) {
        if (mode === 'oldBundle' && ['openingChecklist', 'emergencyReadiness', 'preventiveDaily', 'trainings'].includes(s)) continue; // older deploy: unknown sheet silently skipped
        if (s in SHEET) data[s] = s === 'requests' ? REQUESTS.map((r) => ({ ...r, version })) : SHEET[s];
      }
      return res.end(JSON.stringify({ ok: true, data }));
    }
    if (action in SHEET) {
      const d = action === 'requests' ? REQUESTS.map((r) => ({ ...r, version })) : (action === 'findings' ? [{ id: 'F1', version }] : SHEET[action]);
      return res.end(JSON.stringify({ ok: true, data: d }));
    }
    res.end(JSON.stringify({ ok: false, error: 'Unknown or missing action' }));
  };
  if (mode === 'slow') setTimeout(respond, slowMs); else respond();
});

let gateway, base, mod;
before(async () => {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  process.env.APPS_SCRIPT_EXEC_URL = `http://127.0.0.1:${upstream.address().port}/exec`;
  process.env.SESSION_SECRET = SECRET;
  process.env.SHARED_ACCESS_CODE = '2026';
  process.env.APPROVER_CODE = APPROVER;
  process.env.SESSION_DAYS = '7';
  mod = await import('../src/server.js');
  gateway = http.createServer(mod.requestHandler);
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${gateway.address().port}`;
});
after(async () => { await new Promise((r) => gateway.close(r)); await new Promise((r) => upstream.close(r)); });
beforeEach(() => { hits = []; mode = 'ok'; version = 1; mod._resetNodeCache(); });

const tok = (role, scope) => signToken(SECRET, 7, { name: 'x', role, scope: scope || '' });
const OLGA = tok('ops_manager');
async function read(action, extra, role) {
  const r = await fetch(`${base}/api/data?action=${action}${extra || ''}`, { headers: { Authorization: `Bearer ${role || OLGA}` } });
  let body = null; try { body = await r.json(); } catch (e) { body = null; }
  return { status: r.status, xcache: r.headers.get('x-cache'), body };
}
async function pageData(page, extra, role) {
  const r = await fetch(`${base}/api/data?action=pageData&page=${page}${extra || ''}`, { headers: { Authorization: `Bearer ${role || OLGA}` } });
  let body = null; try { body = await r.json(); } catch (e) { body = null; }
  return { status: r.status, xcache: r.headers.get('x-cache'), body };
}
async function write(action, payload, extra) {
  const r = await fetch(`${base}/api/action${extra || ''}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OLGA}` },
    body: JSON.stringify({ action, payload: payload || {} }),
  });
  let body = null; try { body = await r.json(); } catch (e) { body = null; }
  return { status: r.status, xcache: r.headers.get('x-cache'), body };
}
const count = (action) => hits.filter((h) => h.action === action).length;

// ---- HIT / MISS / STALE ----

test('X-Cache: MISS on the first read, HIT on the second (0 extra upstream calls)', async () => {
  const a = await read('findings');
  assert.equal(a.status, 200); assert.equal(a.xcache, 'MISS');
  const b = await read('findings');
  assert.equal(b.status, 200); assert.equal(b.xcache, 'HIT');
  assert.deepEqual(b.body.data, a.body.data);
  assert.equal(count('findings'), 1, 'one upstream call for two reads');
});

test('every read action except users is cached — incl. the hub-tab / inventory / checklist sheets', async () => {
  for (const a of ['requests', 'findings', 'inspections', 'inventoryItems', 'inventoryCounts', 'checklist', 'events', 'openingChecklist', 'emergencyReadiness', 'preventiveDaily', 'trainings', 'houses', 'config', 'technicians']) {
    assert.equal((await read(a)).xcache, 'MISS', `${a} first read`);
    assert.equal((await read(a)).xcache, 'HIT', `${a} second read`);
    assert.equal(count(a), 1, `${a}: exactly one upstream call`);
  }
});

test('users is NEVER cached: every read is live and carries no X-Cache header', async () => {
  const a = await read('users'); const b = await read('users');
  assert.equal(a.xcache, null); assert.equal(b.xcache, null);
  assert.equal(count('users'), 2);
});

test('STALE: upstream failure inside the 10-min window serves the last good copy with X-Cache: STALE (never a 502)', async () => {
  const first = await read('requests');
  assert.equal(first.xcache, 'MISS');
  mod._cacheBackdate(61 * 1000); // past the 60 s TTL → next read must refetch
  for (const failure of ['http500', 'drop']) {
    mode = failure;
    const r = await read('requests');
    assert.equal(r.status, 200, `${failure}: served instead of 502`);
    assert.equal(r.xcache, 'STALE', `${failure}: flagged STALE`);
    assert.deepEqual(r.body.data, first.body.data, 'the last good copy is what is served');
  }
  mode = 'ok';
  const back = await read('requests');
  assert.equal(back.xcache, 'MISS', 'upstream healthy again → a fresh fetch (and the cache repopulates)');
  assert.equal((await read('requests')).xcache, 'HIT');
});

test('beyond the 10-min stale window an upstream failure is a 502 again (stale data does not live forever)', async () => {
  await read('requests');
  mod._cacheBackdate(11 * 60 * 1000);
  mode = 'http500';
  const r = await read('requests');
  assert.equal(r.status, 502);
  assert.equal(r.body.error, 'upstream_error');
});

test('an upstream failure with NO cached copy is a 502 (nothing to fall back to)', async () => {
  mode = 'drop';
  assert.equal((await read('inspections')).status, 502);
});

// ---- TTLs ----

test('TTL: a dynamic read expires after 60 s (MISS again) while a stable read (houses) is still a HIT until 120 s', async () => {
  await read('requests'); await read('houses');
  mod._cacheBackdate(61 * 1000);
  assert.equal((await read('requests')).xcache, 'MISS', 'requests: 60 s TTL elapsed');
  assert.equal((await read('houses')).xcache, 'HIT', 'houses: 120 s TTL not yet elapsed');
  mod._cacheBackdate(60 * 1000); // houses entry is now ~121 s old
  assert.equal((await read('houses')).xcache, 'MISS', 'houses: 120 s TTL elapsed');
});

// ---- ?fresh=1 ----

test('?fresh=1 bypasses the cache (an upstream call is made) and repopulates it', async () => {
  await read('findings');
  version = 2;
  const cached = await read('findings');
  assert.equal(cached.xcache, 'HIT'); assert.equal(cached.body.data[0].version, 1, 'a plain read still serves v1');
  const fresh = await read('findings', '&fresh=1');
  assert.equal(fresh.xcache, 'MISS'); assert.equal(fresh.body.data[0].version, 2, 'fresh=1 fetched v2');
  assert.equal(count('findings'), 2);
  const again = await read('findings');
  assert.equal(again.xcache, 'HIT'); assert.equal(again.body.data[0].version, 2, 'the fresh result repopulated the cache');
  assert.ok(!hits.some((h) => h.action === 'findings' && String(h.house) === '1'), 'fresh is never forwarded upstream as a param');
});

// ---- in-flight dedupe ----

test('IN-FLIGHT DEDUPE: 6 concurrent misses for one action → ONE upstream call; all callers get the data', async () => {
  mode = 'slow';
  const results = await Promise.all([1, 2, 3, 4, 5, 6].map(() => read('inspections')));
  assert.equal(count('inspections'), 1, 'concurrent misses shared one upstream fetch');
  for (const r of results) { assert.equal(r.status, 200); assert.ok(Array.isArray(r.body.data)); }
  mode = 'ok';
  assert.equal((await read('inspections')).xcache, 'HIT', 'and the shared result populated the cache');
});

test('IN-FLIGHT DEDUPE is per key: different actions / params in flight do not collapse into each other', async () => {
  mode = 'slow';
  await Promise.all([read('requests'), read('findings'), read('requests', '&house=x')]);
  assert.equal(count('requests'), 2, 'requests and requests?house=x are different keys');
  assert.equal(count('findings'), 1);
});

// ---- parameterised reads ----

test('parameterised reads get their own cache keys (house / month / week_start)', async () => {
  const a = await read('inventoryCounts', '&house=רמות השבים&month=2026-09');
  const b = await read('inventoryCounts', '&house=קיסריה עפרוני&month=2026-09');
  const c = await read('inventoryCounts', '&house=רמות השבים&month=2026-09');
  assert.equal(a.xcache, 'MISS'); assert.equal(b.xcache, 'MISS'); assert.equal(c.xcache, 'HIT');
  assert.equal(count('inventoryCounts'), 2);
});

// ---- invalidation on EVERY write ----

const WRITES = [
  ['approve', { id: 'R1', approver_code: APPROVER }],
  ['reject', { id: 'R1', reason: 'x', approver_code: APPROVER }],
  ['defer', { id: 'R1', deferred_until: '2026-12-01' }],
  ['assign', { id: 'R1', assigned_to: 'רמי', assignment_type: 'internal' }],
  ['markExternal', { id: 'R1', trade: 'חשמלאי' }],
  ['assignBatch', { ids: ['R1'], trade: 'חשמלאי' }],
  ['setBlocked', { id: 'R1', blocked: true, reason: 'x' }],
  ['setStatus', { id: 'R1', to: 'סגור' }],
  ['setExecution', { id: 'R1', execution: 'בוצע' }],
  ['createRequest', { house: 'רמות השבים', category: 'תיקון', urgency: 'רגיל', description: 'x' }],
  ['editRequest', { id: 'R1', description: 'y' }],
  ['deleteRequest', { id: 'R1' }],
  ['createInspection', { house: 'רמות השבים' }],
  ['addFinding', { inspection_id: 'I1' }],
  ['confirmFinding', { finding_id: 'F1' }],
  ['submitInventory', { house: 'רמות השבים' }],
  ['addReadinessItem', { board: 'emergency', house: 'רמות השבים', item: 'x' }],
  ['updateReadinessItem', { board: 'emergency', id: 'E1', done: true }],
  ['deleteReadinessItem', { board: 'emergency', id: 'E1' }],
  ['updatePreventiveItem', { house: 'רמות השבים', item: 'מים', done: true }],
  ['deleteTraining', { id: 'T1' }],
  ['deleteCompliance', { id: 'C1' }],
];
for (const [action, payload] of WRITES) {
  test(`INVALIDATION: a ${action} write clears the dynamic cache (next read refetches) but keeps houses/config/technicians`, async () => {
    await read('findings'); await read('openingChecklist'); await read('houses'); await read('config'); await read('technicians');
    assert.equal((await read('findings')).xcache, 'HIT');
    version = 2;
    const w = await write(action, payload);
    assert.equal(w.status, 200, `${action} forwarded`);
    const f = await read('findings');
    assert.equal(f.xcache, 'MISS', `${action}: findings refetched after the write`);
    assert.equal(f.body.data[0].version, 2, `${action}: the refetch returned the NEW data`);
    assert.equal((await read('openingChecklist')).xcache, 'MISS', `${action}: readiness refetched too`);
    assert.equal((await read('houses')).xcache, 'HIT', `${action}: houses stays cached (120 s)`);
    assert.equal((await read('config')).xcache, 'HIT', `${action}: config stays cached`);
    assert.equal((await read('technicians')).xcache, 'HIT', `${action}: technicians stays cached`);
  });
}

test('a REFUSED write (403 at the gate) does not touch the cache', async () => {
  await read('findings');
  const r = await write('approve', { id: 'R1', approver_code: 'wrong' });
  assert.equal(r.status, 403);
  assert.equal((await read('findings')).xcache, 'HIT');
});

// ---- /management POST cache (per period) ----

async function mgmt(period, extra, body) {
  const r = await fetch(`${base}/api/action${extra || ''}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OLGA}` },
    body: JSON.stringify(Object.assign({ action: 'managementData', payload: period ? { period } : {} }, body || {})),
  });
  let b = null; try { b = await r.json(); } catch (e) { b = null; }
  return { status: r.status, xcache: r.headers.get('x-cache'), body: b };
}
const mgmtHits = () => hits.filter((h) => h.action === 'managementData').length;

test('managementData: MISS then HIT (0 extra upstream POSTs); a different period is its own MISS', async () => {
  const a = await mgmt('');
  assert.equal(a.status, 200); assert.equal(a.xcache, 'MISS'); assert.equal(a.body.ok, true);
  const b = await mgmt('');
  assert.equal(b.xcache, 'HIT'); assert.deepEqual(b.body, a.body);
  assert.equal(mgmtHits(), 1);
  const c = await mgmt('2026-07');
  assert.equal(c.xcache, 'MISS'); assert.equal(c.body.data.period, '2026-07');
  assert.equal((await mgmt('2026-07')).xcache, 'HIT');
  assert.equal(mgmtHits(), 2);
});

test('managementData: ?fresh=1 (URL) and body.fresh both bypass the cache and repopulate it', async () => {
  await mgmt('');
  version = 2;
  assert.equal((await mgmt('')).body.data.version, 1, 'cached v1');
  const viaUrl = await mgmt('', '?fresh=1');
  assert.equal(viaUrl.xcache, 'MISS'); assert.equal(viaUrl.body.data.version, 2);
  version = 3;
  const viaBody = await mgmt('', '', { fresh: 1 });
  assert.equal(viaBody.xcache, 'MISS'); assert.equal(viaBody.body.data.version, 3);
  assert.equal((await mgmt('')).body.data.version, 3, 'repopulated');
});

test('managementData: a write clears the per-period cache (every period)', async () => {
  await mgmt(''); await mgmt('2026-07');
  assert.equal((await mgmt('')).xcache, 'HIT');
  await write('updateReadinessItem', { board: 'emergency', id: 'E1', done: true });
  assert.equal((await mgmt('')).xcache, 'MISS');
  assert.equal((await mgmt('2026-07')).xcache, 'MISS');
});

test('managementData: upstream failure inside the window → STALE copy; beyond it → 502; TTL 60 s', async () => {
  const a = await mgmt('');
  mod._cacheBackdate(61 * 1000);
  mode = 'http500';
  const s = await mgmt('');
  assert.equal(s.status, 200); assert.equal(s.xcache, 'STALE'); assert.deepEqual(s.body, a.body);
  mod._cacheBackdate(11 * 60 * 1000);
  assert.equal((await mgmt('')).status, 502);
});

test('managementData: concurrent opens share ONE upstream POST (dedupe)', async () => {
  mode = 'slow';
  await Promise.all([mgmt(''), mgmt(''), mgmt('')]);
  assert.equal(mgmtHits(), 1);
});

test('managementData stays role-gated: field_ops → 403 with no upstream call and nothing cached', async () => {
  const r = await fetch(`${base}/api/action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok('field_ops')}` },
    body: JSON.stringify({ action: 'managementData', payload: {} }),
  });
  assert.equal(r.status, 403);
  assert.equal(mgmtHits(), 0);
});

// ---- pageData ----

test('pageData: MISS (one bundle call) then HIT (zero calls); STALE when upstream is down inside the window', async () => {
  const a = await pageData('dashboard');
  assert.equal(a.xcache, 'MISS'); assert.equal(hits.length, 1);
  const b = await pageData('dashboard');
  assert.equal(b.xcache, 'HIT'); assert.equal(hits.length, 1);
  mod._cacheBackdate(61 * 1000);
  mode = 'drop';
  const s = await pageData('dashboard');
  assert.equal(s.status, 200); assert.equal(s.xcache, 'STALE');
  assert.deepEqual(s.body.data.requests, a.body.data.requests);
  mode = 'ok';
});

test('pageData ?fresh=1 refetches the whole page in one bundle call', async () => {
  await pageData('dashboard');
  const f = await pageData('dashboard', '&fresh=1');
  assert.equal(f.xcache, 'MISS');
  assert.equal(hits.filter((h) => h.action === 'bundle').length, 2);
});

test('WORKORDERS (manager): the readiness tabs ride in the ONE bundle call — no extra reads', async () => {
  const r = await pageData('workorders');
  assert.equal(r.status, 200);
  assert.equal(hits.length, 1, 'exactly one upstream call for the whole page');
  assert.deepEqual(hits[0].sheets.split(',').sort(), ['emergencyReadiness', 'findings', 'houses', 'inspections', 'openingChecklist', 'requests']);
  assert.deepEqual(r.body.data.openingChecklist, SHEET.openingChecklist);
  assert.deepEqual(r.body.data.emergencyReadiness, SHEET.emergencyReadiness);
  assert.ok(!('preventiveDaily' in r.body.data), 'a manager page does not carry the maintenance-only tab');
  assert.deepEqual(mod._pageActionsFor('workorders', 'ops_manager').slice(-2), ['openingChecklist', 'emergencyReadiness']);
  assert.deepEqual(mod._pageActionsFor('workorders', 'maintenance').slice(-1), ['preventiveDaily']);
  assert.equal(mod._pageActionsFor('workorders', 'coordinator').length, 4, 'no extras for a role without them');
  assert.deepEqual(mod._pageActionsFor('dashboard', 'ops_manager'), mod._PAGE_ACTIONS.dashboard, 'other pages unchanged');
});

test('DEPLOY WINDOW: an older bundle that omits the readiness sheets → they are fetched individually, never rendered empty', async () => {
  mode = 'oldBundle';
  const r = await pageData('workorders');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.openingChecklist, SHEET.openingChecklist, 'fetched individually');
  assert.deepEqual(r.body.data.emergencyReadiness, SHEET.emergencyReadiness);
  assert.ok(hits.some((h) => h.action === 'openingChecklist') && hits.some((h) => h.action === 'emergencyReadiness'));
  assert.ok(!r.body.degraded, 'not flagged degraded — bundle itself worked');
});

test('DEPLOY WINDOW: no bundle at all → individual reads, flagged degraded, and the page is still cached afterwards', async () => {
  mode = 'noBundle';
  const r = await pageData('dashboard');
  assert.equal(r.status, 200); assert.equal(r.body.degraded, true);
  mode = 'ok';
  assert.equal((await pageData('dashboard')).xcache, 'HIT');
});

// ---- landing ----

test("the '/' landing has NO data probe: it forwards via the shim's ensureAuth hook, and the shim exposes it", async () => {
  const index = readFileSync(join(root, 'src/index.html'), 'utf8');
  assert.ok(!/action=houses/.test(index), 'no houses probe on the landing page');
  assert.ok(/__ezoneEnsureAuth/.test(index), 'the landing uses the auth hook');
  const html = await (await fetch(`${base}/`)).text();
  assert.ok(/window\.__ezoneEnsureAuth=ensureAuth/.test(html), 'the served shim exposes ensureAuth');
  assert.equal(hits.length, 0, 'serving the landing makes no upstream call');
});
