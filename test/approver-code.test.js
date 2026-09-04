// test/approver-code.test.js — the APPROVER-CODE gate (PR 1, single login), at BOTH layers.
//
// Every session is the one app identity (ops_manager), so the role alone never approves: an approve /
// reject that needs a human approver must carry אולגה's approver code (APPROVER_CODE). This suite locks:
//
//   NODE (src/server.js handleAction → approverGate), real gateway + fake recording upstream:
//     - no code on a non-emergency request → 403 approver_code_required, nothing forwarded;
//     - a wrong code → 403 approver_code_invalid, nothing forwarded (never reaches Apps Script);
//     - the right code → forwarded with `approver_code` in the payload (Code.gs re-verifies it);
//     - an emergency (חירום) request needs no code (auto approval unchanged) and none is forwarded;
//     - a request Node cannot see is forwarded code-less (Code.gs decides, fail-closed there);
//     - the client `by` field is stripped from EVERY write — no user parameter is ever forwarded;
//     - defer / dispatch / close never need the code;
//     - startup refuses to boot without APPROVER_CODE; at runtime an unset code refuses every approval.
//
//   CODE.GS (apps-script/Code.gs handleApprove_ / handleReject_), the REAL .gs files in a sandbox:
//     - the same required / invalid / unset (fail-closed) refusals, with NO row change and NO audit row;
//     - a verified approval writes status מאושר, approved_by = אולגה, AuditLog by = אולגה;
//     - a verified rejection writes לא מאושר + rejected_at, AuditLog by = אולגה;
//     - emergency: no code, approved_by = the session actor, note 'אושר אוטומטית (חירום)' (unchanged);
//     - the ops_manager session approves a ≤threshold (field_ops-routed) request (canApprove, PR 1).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { signToken, verifyToken } from '../src/auth.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'k'.repeat(40);
const CODE = '2026';
const APPROVER = 'olga-77';

// ---------------------------------------------------------------------------------------------
// NODE layer
// ---------------------------------------------------------------------------------------------

const REQUESTS = [
  { id: 'R-NORMAL', house: 'רמות השבים', status: 'דרישה', urgency: 'רגיל', estimated_cost: 500 },
  { id: 'R-EMERG', house: 'רמות השבים', status: 'דרישה', urgency: 'חירום', estimated_cost: 9000 },
];
const forwarded = [];
const upstream = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'GET') {
    const action = u.searchParams.get('action');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, data: action === 'requests' ? REQUESTS : [] }));
  }
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch (e) { body = { _parseError: true }; }
    forwarded.push(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
});

let gateway, base, mod, token;

before(async () => {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  process.env.APPS_SCRIPT_EXEC_URL = `http://127.0.0.1:${upstream.address().port}/exec`;
  process.env.SESSION_SECRET = SECRET;
  process.env.SHARED_ACCESS_CODE = CODE;
  process.env.APPROVER_CODE = APPROVER;
  process.env.SESSION_DAYS = '7';
  mod = await import('../src/server.js');
  gateway = http.createServer(mod.requestHandler);
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${gateway.address().port}`;
  mod._loginAttempts.clear();
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: CODE }) });
  token = (await r.json()).token;
});

after(async () => {
  await new Promise((r) => gateway.close(r));
  await new Promise((r) => upstream.close(r));
});

beforeEach(() => { forwarded.length = 0; mod._resetNodeCache(); });

// Exactly how the dashboard writes: POST /api/action with the Bearer token and { action, payload }.
async function write(action, payload, tok) {
  const r = await fetch(`${base}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8', Authorization: `Bearer ${tok || token}` },
    body: JSON.stringify({ action, payload, token: '1' }),
  });
  let body = null;
  try { body = await r.json(); } catch (e) { body = null; }
  return { status: r.status, body };
}

test('approve/reject are the ONLY approver-coded actions', () => {
  assert.deepEqual([...mod._APPROVER_ACTIONS].sort(), ['approve', 'reject']);
});

test('no code on a normal request → 403 approver_code_required, nothing forwarded', async () => {
  for (const action of ['approve', 'reject']) {
    const { status, body } = await write(action, { id: 'R-NORMAL', reason: 'x' });
    assert.equal(status, 403, `${action} without a code is refused`);
    assert.equal(body.error, 'approver_code_required');
  }
  assert.equal(forwarded.length, 0, 'a refused write never reaches Apps Script');
});

test('a wrong code → 403 approver_code_invalid, nothing forwarded (never reaches Apps Script)', async () => {
  for (const bad of ['0000', APPROVER + ' ', 'OLGA-77', CODE]) {
    const { status, body } = await write('approve', { id: 'R-NORMAL', approver_code: bad });
    assert.equal(status, 403, `code=${JSON.stringify(bad)} must be refused`);
    assert.equal(body.error, 'approver_code_invalid');
  }
  assert.equal(forwarded.length, 0);
});

test('the right code → forwarded WITH approver_code (Code.gs re-verifies), actor = the session token', async () => {
  const { status } = await write('approve', { id: 'R-NORMAL', approver_code: APPROVER });
  assert.equal(status, 200);
  assert.equal(forwarded.length, 1);
  const sent = forwarded[0];
  assert.equal(sent.action, 'approve');
  assert.deepEqual(sent.payload, { id: 'R-NORMAL', approver_code: APPROVER }, 'the verified code is forwarded verbatim for the independent Code.gs check');
  const actor = verifyToken(SECRET, sent.token);
  assert.equal(actor.role, 'ops_manager');
  assert.equal(actor.name, 'רועי');
});

test('reject with the right code → forwarded with the reason and the code', async () => {
  const { status } = await write('reject', { id: 'R-NORMAL', reason: 'אין תקציב', approver_code: APPROVER });
  assert.equal(status, 200);
  assert.equal(forwarded[0].action, 'reject');
  assert.equal(forwarded[0].payload.reason, 'אין תקציב');
  assert.equal(forwarded[0].payload.approver_code, APPROVER);
});

test('an EMERGENCY request needs no code (auto approval unchanged) — forwarded without one', async () => {
  const { status } = await write('approve', { id: 'R-EMERG' });
  assert.equal(status, 200);
  assert.equal(forwarded.length, 1);
  assert.deepEqual(forwarded[0].payload, { id: 'R-EMERG' }, 'no approver_code key is invented');
});

test('a request Node cannot see is forwarded code-less — Code.gs (fail-closed) decides', async () => {
  const { status } = await write('approve', { id: 'R-UNKNOWN' });
  assert.equal(status, 200);
  assert.deepEqual(forwarded[0].payload, { id: 'R-UNKNOWN' });
});

test('the client `by` field is STRIPPED from every write — no user parameter is ever forwarded', async () => {
  await write('approve', { id: 'R-NORMAL', by: 'סנדרה', approver_code: APPROVER });
  await write('defer', { id: 'R-NORMAL', by: 'רועי', deferred_until: '2026-12-01' });
  await write('setStatus', { id: 'R-NORMAL', by: 'אולגה', to: 'סגור' });
  await write('assign', { id: 'R-NORMAL', by: 'x', assigned_to: 'רמי', assignment_type: 'internal' });
  assert.equal(forwarded.length, 4);
  for (const f of forwarded) assert.ok(!('by' in f.payload), `${f.action}: payload must carry no user field`);
});

test('defer / assign / setStatus / setBlocked never need the approver code', async () => {
  const ok = [
    ['defer', { id: 'R-NORMAL', deferred_until: '2026-12-01' }],
    ['assign', { id: 'R-NORMAL', assigned_to: 'רמי', assignment_type: 'internal' }],
    ['setStatus', { id: 'R-NORMAL', to: 'הושלם' }],
    ['setBlocked', { id: 'R-NORMAL', blocked: true, reason: 'x' }],
  ];
  for (const [action, payload] of ok) assert.equal((await write(action, payload)).status, 200, `${action} needs no code`);
  assert.equal(forwarded.length, ok.length);
});

test('a tier-B token is still refused approve/reject BEFORE the code gate (403, nothing forwarded)', async () => {
  const rami = signToken(SECRET, 7, { name: 'רמי', role: 'maintenance', scope: 'sharon' });
  assert.equal((await write('approve', { id: 'R-NORMAL', approver_code: APPROVER }, rami)).status, 403);
  assert.equal(forwarded.length, 0);
});

test('fail-closed startup: missing APPROVER_CODE → the server refuses to start (non-zero exit)', () => {
  const env = {
    PATH: process.env.PATH,
    APPS_SCRIPT_EXEC_URL: 'https://example.invalid/exec',
    SESSION_SECRET: 's'.repeat(40),
    SHARED_ACCESS_CODE: '2026',
    SESSION_DAYS: '7',
    // APPROVER_CODE intentionally omitted
  };
  const r = spawnSync(process.execPath, [join(root, 'src', 'server.js')], { env, encoding: 'utf8', timeout: 10000 });
  assert.notEqual(r.status, 0, 'server should exit non-zero without APPROVER_CODE');
  assert.match(`${r.stderr}`, /APPROVER_CODE is required/);
});

test('runtime fail-closed: with APPROVER_CODE unset, NO approval succeeds (any code → 403, nothing forwarded)', async () => {
  const saved = process.env.APPROVER_CODE;
  delete process.env.APPROVER_CODE;
  const iso = await import('../src/server.js?approver_unset=1'); // fresh module instance reads the unset value
  process.env.APPROVER_CODE = saved;
  const srv = http.createServer(iso.requestHandler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const b = `http://127.0.0.1:${srv.address().port}`;
    for (const code of ['', APPROVER, 'anything']) {
      const r = await fetch(`${b}/api/action`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'approve', payload: { id: 'R-NORMAL', approver_code: code } }),
      });
      assert.equal(r.status, 403, `unset APPROVER_CODE must refuse (tried ${JSON.stringify(code)})`);
    }
    assert.equal(forwarded.length, 0);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

// ---------------------------------------------------------------------------------------------
// CODE.GS layer — the real handlers in a sandbox (Apps Script shares ONE global scope, so the .gs files
// are concatenated exactly as the runtime sees them).
// ---------------------------------------------------------------------------------------------

const GS = readFileSync(join(root, 'apps-script/digest.gs'), 'utf8') + '\n' +
  readFileSync(join(root, 'apps-script/Code.gs'), 'utf8');

function mutableSheet(header, rows) {
  const data = [header.slice()].concat((rows || []).map((r) => r.slice()));
  return {
    _data: data,
    getDataRange: () => ({ getValues: () => data.map((r) => r.slice()) }),
    getLastColumn: () => header.length,
    getLastRow: () => data.length,
    getRange: (r, c, nr, nc) => ({
      getValues: () => {
        const out = [];
        for (let i = 0; i < (nr || 1); i++) { const row = []; for (let j = 0; j < (nc || 1); j++) row.push((data[r - 1 + i] || [])[c - 1 + j]); out.push(row); }
        return out;
      },
      setValue: (v) => { data[r - 1][c - 1] = v; },
    }),
    appendRow: (row) => { data.push(row.slice()); },
    deleteRow: (r) => { data.splice(r - 1, 1); },
  };
}

const REQ_HEADER = ['id', 'house', 'category', 'urgency', 'estimated_cost', 'status', 'approval_required', 'approved_by', 'approved_at', 'rejection_reason', 'rejected_at', 'deferred_until', 'due_at', 'created_at'];
function requestsSheet() {
  return mutableSheet(REQ_HEADER, [
    ['R-LOW', 'רמות השבים', 'תיקון', 'רגיל', 500, 'דרישה', false, '', '', '', '', '', '', '2026-08-01T08:00:00.000Z'],
    ['R-HIGH', 'רמות השבים', 'תיקון', 'רגיל', 9000, 'דרישה', true, '', '', '', '', '', '', '2026-08-01T08:00:00.000Z'],
    ['R-EMERG', 'רמות השבים', 'תיקון', 'חירום', 9000, 'דרישה', false, '', '', '', '', '', '', '2026-08-01T08:00:00.000Z'],
  ]);
}

// A sandbox deployment. `approverProp` = the APPROVER_CODE Script Property value (null = unset).
function deployment(approverProp) {
  const sheets = {
    Config: mutableSheet(['key', 'value'], [['approval_threshold', '3000']]),
    Houses: mutableSheet(['name', 'status', 'cluster'], [['רמות השבים', 'open', 'sharon']]),
    Requests: requestsSheet(),
    AuditLog: mutableSheet(['request_id', 'from_status', 'to_status', 'by', 'timestamp', 'note'], []),
  };
  const captured = { out: null, logs: [] };
  const props = { SESSION_SECRET: SECRET, APPROVER_CODE: approverProp };
  const sandbox = {
    Logger: { log: (m) => captured.logs.push(String(m)) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => { captured.out = s; return { setMimeType: () => ({ _text: s }) }; } },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n) => sheets[n] || null }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null) }) },
    Utilities: { formatDate: () => '' },
    console,
  };
  const keys = Object.keys(sandbox);
  const factory = new Function(...keys, GS + '\n;return { handleApprove_, handleReject_, getRequestById, approverCodeOk_, APPROVER_NAME_ };');
  const api = factory(...keys.map((k) => sandbox[k]));
  const call = (fn, payload, actor) => { api[fn](payload, actor); return JSON.parse(captured.out); };
  return { api, sheets, call, captured };
}
const SESSION = { name: 'רועי', role: 'ops_manager', scope: '' }; // the ONE identity every session carries
const rowOf = (dep, id) => dep.api.getRequestById(id);
const audit = (dep) => dep.sheets.AuditLog._data.slice(1);

test('Code.gs: approve without a code → approver_code_required; NO row change, NO audit row', () => {
  const dep = deployment(APPROVER);
  const out = dep.call('handleApprove_', { id: 'R-LOW' }, SESSION);
  assert.deepEqual(out, { ok: false, error: 'approver_code_required' });
  assert.equal(rowOf(dep, 'R-LOW').status, 'דרישה');
  assert.equal(audit(dep).length, 0);
});

test('Code.gs: a wrong code → approver_code_invalid; NO row change, NO audit row', () => {
  const dep = deployment(APPROVER);
  for (const bad of ['0000', 'OLGA-77', APPROVER + ' ', CODE]) {
    assert.deepEqual(dep.call('handleApprove_', { id: 'R-LOW', approver_code: bad }, SESSION), { ok: false, error: 'approver_code_invalid' }, `code=${JSON.stringify(bad)}`);
  }
  assert.equal(rowOf(dep, 'R-LOW').status, 'דרישה');
  assert.equal(audit(dep).length, 0);
});

test('Code.gs: FAIL-CLOSED — an unset APPROVER_CODE Script Property refuses every non-emergency approval', () => {
  for (const unset of [null, '', '   ']) {
    const dep = deployment(unset);
    assert.equal(dep.call('handleApprove_', { id: 'R-LOW', approver_code: APPROVER }, SESSION).ok, false);
    assert.equal(dep.call('handleApprove_', { id: 'R-LOW', approver_code: '' }, SESSION).ok, false);
    assert.equal(dep.api.approverCodeOk_({ approver_code: '' }), false, 'an empty expected AND supplied code never matches');
    assert.equal(rowOf(dep, 'R-LOW').status, 'דרישה');
  }
});

test('Code.gs: the right code approves — status מאושר, approved_by = אולגה, AuditLog by = אולגה', () => {
  const dep = deployment(APPROVER);
  assert.deepEqual(dep.call('handleApprove_', { id: 'R-HIGH', approver_code: APPROVER }, SESSION), { ok: true });
  const row = rowOf(dep, 'R-HIGH');
  assert.equal(row.status, 'מאושר');
  assert.equal(row.approved_by, 'אולגה');
  assert.ok(row.approved_at, 'approved_at stamped');
  const [entry] = audit(dep);
  assert.equal(entry[0], 'R-HIGH');
  assert.equal(entry[2], 'מאושר');
  assert.equal(entry[3], 'אולגה', 'the AuditLog records the approver, not the session name');
  assert.equal(dep.api.APPROVER_NAME_, 'אולגה');
});

test('Code.gs: the ops_manager session approves a ≤threshold (field_ops-routed) request with the code (canApprove, PR 1)', () => {
  const dep = deployment(APPROVER);
  assert.deepEqual(dep.call('handleApprove_', { id: 'R-LOW', approver_code: APPROVER }, SESSION), { ok: true });
  assert.equal(rowOf(dep, 'R-LOW').status, 'מאושר');
  assert.equal(rowOf(dep, 'R-LOW').approved_by, 'אולגה');
});

test('Code.gs: reject with the right code → לא מאושר + rejected_at + reason, AuditLog by = אולגה; without → refused', () => {
  const dep = deployment(APPROVER);
  assert.deepEqual(dep.call('handleReject_', { id: 'R-LOW', reason: 'לא נדרש' }, SESSION), { ok: false, error: 'approver_code_required' });
  assert.equal(rowOf(dep, 'R-LOW').status, 'דרישה');
  assert.deepEqual(dep.call('handleReject_', { id: 'R-LOW', reason: 'לא נדרש', approver_code: APPROVER }, SESSION), { ok: true });
  const row = rowOf(dep, 'R-LOW');
  assert.equal(row.status, 'לא מאושר');
  assert.equal(row.rejection_reason, 'לא נדרש');
  assert.ok(row.rejected_at);
  const [entry] = audit(dep);
  assert.equal(entry[2], 'לא מאושר');
  assert.equal(entry[3], 'אולגה');
  assert.equal(entry[5], 'לא נדרש');
});

test('Code.gs: EMERGENCY is unchanged — no code needed, approved_by = the session actor, auto note', () => {
  const dep = deployment(null); // even with the property unset: the auto path never consults it
  assert.deepEqual(dep.call('handleApprove_', { id: 'R-EMERG' }, SESSION), { ok: true });
  const row = rowOf(dep, 'R-EMERG');
  assert.equal(row.status, 'מאושר');
  assert.equal(row.approved_by, 'רועי');
  const [entry] = audit(dep);
  assert.equal(entry[3], 'רועי');
  assert.equal(entry[5], 'אושר אוטומטית (חירום)');
});

test('Code.gs: a tier-B actor is refused BEFORE the code gate (role rule unchanged)', () => {
  const dep = deployment(APPROVER);
  const out = dep.call('handleApprove_', { id: 'R-LOW', approver_code: APPROVER }, { name: 'רמי', role: 'maintenance', scope: 'sharon' });
  assert.equal(out.ok, false);
  assert.match(out.error, /Forbidden/);
  assert.equal(audit(dep).length, 0);
});
