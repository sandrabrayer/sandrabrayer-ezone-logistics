// test/chain-b-v3.test.js — PR 2 (אולגה approves everything; סנדרה removed) at the LIVE Apps Script layer.
//
// The pure routing rules are locked in approval.test.js / roles.test.js. This suite runs the REAL .gs
// files in a sandbox and locks what production actually does:
//
//   Code.gs handlers (concatenated like the runtime: one shared global scope)
//     - handleApprove_: field_ops is refused on a SMALL request (the ≤threshold tier is gone) — no row
//       change, no audit row; ops_manager + the approver code approves it; a stale ceo token is refused.
//     - routing reads NO Config value: with `approval_threshold` absent from Config entirely, approving
//       still works (approval_threshold is a legacy key nothing consults).
//     - a DEFERRED request wakes up and is re-decided by the same two rules: ops_manager (with the code)
//       approves it; field_ops cannot.
//     - createRequest stamps approval_required = TRUE for every non-emergency request, FALSE for חירום.
//     - the inspector allow-list no longer accepts sandra / סנדרה.
//   setup.gs
//     - SEED_USERS / SEED_CONFIG no longer carry סנדרה / ceo_ceiling.
//     - deactivateUsers_ flips an EXISTING סנדרה row to active=FALSE, never deletes it, is idempotent,
//       and leaves every other row alone.
//     - setUserPin() is retired: it throws and writes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CODE_GS = readFileSync(join(root, 'apps-script/digest.gs'), 'utf8') + '\n' +
  readFileSync(join(root, 'apps-script/Code.gs'), 'utf8');
const SETUP_GS = readFileSync(join(root, 'apps-script/setup.gs'), 'utf8');

const SECRET = 's'.repeat(40);
const APPROVER = 'olga-77';

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
      setValues: (vals) => { for (let i = 0; i < vals.length; i++) data[r - 1 + i] = vals[i].slice(); },
    }),
    appendRow: (row) => { data.push(row.slice()); },
    deleteRow: (r) => { data.splice(r - 1, 1); },
  };
}

const REQ_HEADER = ['id', 'house', 'category', 'urgency', 'estimated_cost', 'status', 'approval_required', 'approved_by', 'approved_at', 'rejection_reason', 'rejected_at', 'deferred_until', 'due_at', 'created_at', 'created_by', 'description', 'location_in_house'];
const row = (id, cost, status, urgency, extra) => {
  const r = [id, 'רמות השבים', 'תיקון', urgency || 'רגיל', cost, status || 'דרישה', '', '', '', '', '', '', '', '2026-08-01T08:00:00.000Z', 'שירה', 'x', ''];
  if (extra) for (const [k, v] of Object.entries(extra)) r[REQ_HEADER.indexOf(k)] = v;
  return r;
};

// A sandbox deployment of Code.gs. `configRows` lets a test drop approval_threshold entirely.
function deployCode({ configRows, approverProp } = {}) {
  const sheets = {
    Config: mutableSheet(['key', 'value'], configRows || [['approval_threshold', '3000'], ['sla_days', 'חירום:1|דחוף:3|רגיל:14']]),
    Houses: mutableSheet(['name', 'status', 'cluster'], [['רמות השבים', 'open', 'sharon']]),
    Requests: mutableSheet(REQ_HEADER, [
      row('R-SMALL', 500),
      row('R-BIG', 9000),
      row('R-DEFERRED', 700, 'נדחה לתאריך', 'רגיל', { deferred_until: '2026-08-20' }),
    ]),
    AuditLog: mutableSheet(['request_id', 'from_status', 'to_status', 'by', 'timestamp', 'note'], []),
  };
  const captured = { out: null, logs: [] };
  const props = { SESSION_SECRET: SECRET, APPROVER_CODE: approverProp === undefined ? APPROVER : approverProp };
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
  const factory = new Function(...keys, CODE_GS + '\n;return { handleApprove_, handleReject_, handleCreateRequest_, getRequestById, requiredApproverFor_, INSPECTION_USERS_, ROLE, ROLES };');
  const api = factory(...keys.map((k) => sandbox[k]));
  const call = (fn, payload, actor) => { api[fn](payload, actor); return JSON.parse(captured.out); };
  return { api, sheets, call, captured };
}
const OLGA = { name: 'רועי', role: 'ops_manager', scope: '' }; // the single-login session (approver = the code)
const ROY = { name: 'רועי', role: 'field_ops', scope: '' };
const CEO = { name: 'סנדרה', role: 'ceo', scope: '' };
const audit = (dep) => dep.sheets.AuditLog._data.slice(1);

// ---- Code.gs: routing + the live approve handler ----

test('Code.gs: field_ops is REFUSED on a small request (the ≤threshold tier is gone) — no row change, no audit row', () => {
  const dep = deployCode();
  const out = dep.call('handleApprove_', { id: 'R-SMALL', approver_code: APPROVER }, ROY);
  assert.equal(out.ok, false);
  assert.match(out.error, /Forbidden/);
  assert.equal(dep.api.getRequestById('R-SMALL').status, 'דרישה');
  assert.equal(audit(dep).length, 0);
});

test('Code.gs: ops_manager + the approver code approves a small AND a big request; approved_by = אולגה', () => {
  const dep = deployCode();
  for (const id of ['R-SMALL', 'R-BIG']) {
    assert.deepEqual(dep.call('handleApprove_', { id, approver_code: APPROVER }, OLGA), { ok: true }, id);
    const r = dep.api.getRequestById(id);
    assert.equal(r.status, 'מאושר');
    assert.equal(r.approved_by, 'אולגה');
  }
  assert.equal(audit(dep).length, 2);
  for (const a of audit(dep)) assert.equal(a[3], 'אולגה');
});

test('Code.gs: a stale ceo token approves NOTHING (role removed) — refused before the code gate', () => {
  const dep = deployCode();
  for (const id of ['R-SMALL', 'R-BIG', 'R-DEFERRED']) {
    const out = dep.call('handleApprove_', { id, approver_code: APPROVER }, CEO);
    assert.equal(out.ok, false, id);
    assert.match(out.error, /Forbidden/);
  }
  assert.equal(audit(dep).length, 0);
  assert.equal('CEO' in dep.api.ROLE, false, 'no ROLE.CEO in Code.gs');
  assert.equal(dep.api.ROLES.includes('ceo'), false);
});

test('Code.gs: routing reads NO Config value — with approval_threshold ABSENT, every request still routes to ops_manager', () => {
  const dep = deployCode({ configRows: [['sla_days', 'חירום:1|דחוף:3|רגיל:14']] }); // no approval_threshold row at all
  assert.equal(dep.api.requiredApproverFor_({ estimated_cost: 500, urgency: 'רגיל' }), 'ops_manager');
  assert.equal(dep.api.requiredApproverFor_({ estimated_cost: 9000, urgency: 'רגיל' }), 'ops_manager');
  assert.equal(dep.api.requiredApproverFor_({ estimated_cost: '', urgency: 'רגיל' }), 'ops_manager');
  assert.equal(dep.api.requiredApproverFor_({ estimated_cost: 9000, urgency: 'חירום' }), 'auto');
  assert.deepEqual(dep.call('handleApprove_', { id: 'R-SMALL', approver_code: APPROVER }, OLGA), { ok: true }, 'approval works without the legacy key');
});

test('Code.gs: a DEFERRED request wakes up and is re-decided by the same two rules — ops_manager (with the code) approves, field_ops cannot', () => {
  const dep = deployCode();
  assert.equal(dep.api.requiredApproverFor_(dep.api.getRequestById('R-DEFERRED')), 'ops_manager', 'wake-up routes to ops_manager');
  assert.equal(dep.call('handleApprove_', { id: 'R-DEFERRED', approver_code: APPROVER }, ROY).ok, false, 'field_ops cannot approve a woken deferral');
  assert.equal(dep.call('handleApprove_', { id: 'R-DEFERRED' }, OLGA).ok, false, 'no code → refused (approver_code_required)');
  assert.deepEqual(dep.call('handleApprove_', { id: 'R-DEFERRED', approver_code: APPROVER }, OLGA), { ok: true });
  const r = dep.api.getRequestById('R-DEFERRED');
  assert.equal(r.status, 'מאושר');
  assert.equal(r.approved_by, 'אולגה');
  assert.ok(r.due_at, 'the SLA clock restarts from the deferral date on wake-up (due_at derived)');
  const [entry] = audit(dep);
  assert.equal(entry[1], 'נדחה לתאריך');
  assert.equal(entry[2], 'מאושר');
  assert.equal(entry[3], 'אולגה');
});

test('Code.gs: createRequest stamps approval_required TRUE for every non-emergency request, FALSE for חירום', () => {
  const dep = deployCode();
  const base = { house: 'רמות השבים', category: 'תיקון', description: 'x' };
  const ids = [];
  for (const [cost, urgency] of [[500, 'רגיל'], [9000, 'רגיל'], ['', 'דחוף']]) {
    const out = dep.call('handleCreateRequest_', { ...base, estimated_cost: cost, urgency }, OLGA);
    assert.equal(out.ok, true, `create cost=${cost}`);
    ids.push(out.id);
    assert.equal(dep.api.getRequestById(out.id).approval_required, true, `cost=${cost} urgency=${urgency} → needs אולגה`);
  }
  const em = dep.call('handleCreateRequest_', { ...base, estimated_cost: 9000, urgency: 'חירום' }, OLGA);
  assert.equal(dep.api.getRequestById(em.id).approval_required, false, 'emergency → auto');
});

test('Code.gs: the inspector allow-list no longer accepts sandra / סנדרה', () => {
  const dep = deployCode();
  assert.deepEqual(dep.api.INSPECTION_USERS_, ['רועי', 'אולגה', 'אורן']);
});

// ---- setup.gs: seeds + the retirement step ----

function loadSetup(usersSheet) {
  const captured = { logs: [] };
  const sandbox = {
    Logger: { log: (m) => captured.logs.push(String(m)) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n) => (n === 'Users' ? usersSheet : null) }) },
    console,
  };
  const keys = Object.keys(sandbox);
  const factory = new Function(...keys, SETUP_GS + '\n;return { SEED_USERS, SEED_CONFIG, RETIRED_USERS, deactivateUsers_, setUserPin };');
  return { api: factory(...keys.map((k) => sandbox[k])), captured };
}
const USERS_HEADER = ['name', 'role', 'house', 'active', 'pin_hash'];
function liveUsersSheet() {
  return mutableSheet(USERS_HEADER, [
    ['רועי', 'field_ops', '', 'TRUE', ''],
    ['אולגה', 'ops_manager', '', 'TRUE', ''],
    ['סנדרה', 'ceo', '', 'TRUE', 'pbkdf2$sha256$1$aa$bb'],
    ['רמי', 'maintenance', 'sharon', 'TRUE', ''],
  ]);
}

test('setup.gs: SEED_USERS no longer seeds סנדרה / ceo; SEED_CONFIG no longer seeds ceo_ceiling; approval_threshold kept as legacy', () => {
  const { api } = loadSetup(liveUsersSheet());
  assert.equal(api.SEED_USERS.some((u) => u[0] === 'סנדרה' || u[1] === 'ceo'), false);
  assert.deepEqual(api.RETIRED_USERS, ['סנדרה']);
  const keys = api.SEED_CONFIG.map((c) => c[0]);
  assert.equal(keys.includes('ceo_ceiling'), false);
  assert.ok(keys.includes('approval_threshold'), 'legacy key stays so an existing sheet keeps its row');
});

test('setup.gs: deactivateUsers_ sets the EXISTING סנדרה row to active=FALSE, never deletes it, keeps pin_hash and every other row', () => {
  const sheet = liveUsersSheet();
  const { api, captured } = loadSetup(sheet);
  api.deactivateUsers_(sheet, api.RETIRED_USERS);
  const rows = sheet._data.slice(1);
  assert.equal(rows.length, 4, 'no row deleted');
  const sandra = rows.find((r) => r[0] === 'סנדרה');
  assert.equal(sandra[3], 'FALSE');
  assert.equal(sandra[4], 'pbkdf2$sha256$1$aa$bb', 'the legacy pin_hash cell is left untouched (append-only)');
  for (const name of ['רועי', 'אולגה', 'רמי']) assert.equal(rows.find((r) => r[0] === name)[3], 'TRUE', `${name} untouched`);
  assert.ok(captured.logs.some((l) => /סנדרה.*active=FALSE/.test(l)));
});

test('setup.gs: deactivateUsers_ is idempotent (second run writes nothing) and tolerates a missing row / empty sheet', () => {
  const sheet = liveUsersSheet();
  const { api, captured } = loadSetup(sheet);
  api.deactivateUsers_(sheet, ['סנדרה']);
  const before = captured.logs.length;
  api.deactivateUsers_(sheet, ['סנדרה']);
  assert.equal(captured.logs.length, before, 'already FALSE → no write, no log');
  const noSandra = mutableSheet(USERS_HEADER, [['רועי', 'field_ops', '', 'TRUE', '']]);
  api.deactivateUsers_(noSandra, ['סנדרה']);
  assert.deepEqual(noSandra._data.slice(1), [['רועי', 'field_ops', '', 'TRUE', '']], 'no matching row → nothing happens');
  api.deactivateUsers_(mutableSheet(USERS_HEADER, []), ['סנדרה']); // header-only sheet → returns early
});

test('setup.gs: setUserPin() is RETIRED — it throws and writes nothing to the sheet', () => {
  const sheet = liveUsersSheet();
  const { api } = loadSetup(sheet);
  const snapshot = JSON.stringify(sheet._data);
  assert.throws(() => api.setUserPin('אולגה', 'new-password'), /retired/);
  assert.equal(JSON.stringify(sheet._data), snapshot, 'no cell changed');
  assert.ok(!SETUP_GS.includes('function hashPin_') && !SETUP_GS.includes('function pbkdf2Sha256_'), 'the PBKDF2 writer is gone from setup.gs');
});
