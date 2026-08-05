// test/management-handler.test.js — end-to-end guard for the LIVE managementData handler + the new
// deleteCompliance write, loading the real apps-script .gs files in a sandbox with stubbed Apps Script
// globals. Locks: (1) safePanel_ isolation (one panel failing never blanks the screen); (2) the PR B
// payload shape (owned-data keys + budget/maintenance/compliance; NO kitchen/training/events); (3) the
// two Logistics-owned readiness checklists degrade to [] when their sheet is absent (setup not re-run);
// (4) handleDeleteCompliance_ deletes by id, audit-logs, and is canManage-gated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Apps Script shares ONE global scope across all .gs files; concatenate them like the runtime does.
const CODE = readFileSync(join(root, 'apps-script/digest.gs'), 'utf8') + '\n' +
  readFileSync(join(root, 'apps-script/Code.gs'), 'utf8');

// A read-only sheet mock (getDataRange only).
function sheetOf(rows2d) {
  return { getDataRange: () => ({ getValues: () => rows2d }) };
}
// A sheet whose read throws — used to force a specific panel producer to blow up.
function throwingSheet(msg) {
  return { getDataRange: () => { throw new Error(msg); } };
}
// A mutable sheet supporting getDataRange + deleteRow + appendRow (for the delete + audit path).
function mutableSheet(rows2d) {
  const data = rows2d.map((r) => r.slice());
  const deletedRows = [];
  return {
    getDataRange: () => ({ getValues: () => data }),
    deleteRow: (n) => { deletedRows.push(n); data.splice(n - 1, 1); },
    appendRow: (row) => { data.push(row.slice()); },
    _data: data,
    _deletedRows: deletedRows,
  };
}

const COMPLIANCE_HEADERS = ['id', 'house', 'item', 'expires_at', 'reminder_days', 'doc_url', 'notes', 'active'];
const AUDIT_HEADERS = ['request_id', 'from_status', 'to_status', 'by', 'timestamp', 'note'];

// Build the ACTIVE (Logistics) spreadsheet's sheet set. `overrides` swaps in throwing/edge/mutable sheets.
function activeSheets(overrides) {
  const base = {
    Config: sheetOf([['key', 'value'], ['approval_threshold', '3000']]),
    Requests: sheetOf([['id', 'house', 'status', 'created_at']]),
    Houses: sheetOf([['name', 'status'], ['רמות השבים', 'open']]),
    Budgets: sheetOf([['house', 'period', 'amount', 'notes']]),
    MaintenancePlan: sheetOf([['id', 'house', 'task', 'frequency_months', 'last_done', 'active', 'notes']]),
    Compliance: sheetOf([COMPLIANCE_HEADERS]),
    OpeningChecklist: sheetOf([['house', 'item', 'done', 'date', 'by'], ['רעננה הפרדס', 'חשמל', 'FALSE', '', '']]),
    EmergencyReadiness: sheetOf([['house', 'item', 'done', 'date', 'by'], ['רמות השבים', 'גנרטור', 'TRUE', '2026-01-01', 'רמי']]),
  };
  return Object.assign(base, overrides || {});
}

// Load the real handler in a sandbox and return the requested functions plus a capture.
function loadHandler({ sheets } = {}) {
  const captured = { out: null, logs: [] };
  const resolved = sheets || activeSheets();
  const sandbox = {
    Logger: { log: (m) => captured.logs.push(String(m)) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ setMimeType: () => ({ _text: s }) }) },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({ getSheetByName: (n) => resolved[n] || null }),
      openById: () => { throw new Error('no access'); },
    },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {} }) },
    console,
  };
  sandbox.ContentService.createTextOutput = (s) => { captured.out = s; return { setMimeType: () => ({ _text: s }) }; };
  const keys = Object.keys(sandbox);
  const factory = new Function(...keys,
    CODE + '\n;return { handleManagementData_: handleManagementData_, handleDeleteCompliance_: handleDeleteCompliance_, safePanel_: safePanel_ };');
  const api = factory(...keys.map((k) => sandbox[k]));
  return { api, captured, sheets: resolved };
}

function callManagement(opts, actor) {
  const { api, captured } = loadHandler(opts);
  api.handleManagementData_({}, actor || { name: 'אולגה', role: 'ops_manager' });
  return { result: JSON.parse(captured.out), logs: captured.logs };
}

// ---- safePanel_ primitive ----

test('safePanel_ returns the producer value on success, and the fallback (logged) on throw', () => {
  const { api, captured } = loadHandler();
  assert.deepEqual(api.safePanel_('x', () => ({ houses: [] }), null), { houses: [] });
  assert.equal(api.safePanel_('compliance', () => { throw new Error('boom'); }, null), null);
  assert.ok(captured.logs.some((l) => /panel "compliance" failed/.test(l) && /boom/.test(l)));
});

// ---- PR B payload shape ----

test('PR B: managementData returns the owned-data keys + budget/maintenance/compliance, and NO removed panels', () => {
  const { result } = callManagement();
  assert.equal(result.ok, true);
  const keys = Object.keys(result.data).sort();
  assert.deepEqual(keys, ['budget', 'compliance', 'emergencyReadiness', 'houses', 'maintenance', 'openingChecklist', 'requests'].sort());
  for (const gone of ['kitchen', 'coordinators', 'training', 'events', 'findings', 'inspections', 'inventoryCounts', 'inventoryItems']) {
    assert.ok(!(gone in result.data), `${gone} must be gone from the payload`);
  }
  assert.ok(Array.isArray(result.data.openingChecklist));
  assert.equal(result.data.openingChecklist.length, 1);
  assert.equal(result.data.emergencyReadiness[0].item, 'גנרטור');
});

test('a single panel failing (compliance sheet throws) → ok:true, compliance null, everything else intact', () => {
  const sheets = activeSheets({ Compliance: throwingSheet('Compliance read failed') });
  const { result, logs } = callManagement({ sheets });
  assert.equal(result.ok, true);
  assert.equal(result.data.compliance, null);         // degraded to the html "לא זמין" fallback
  assert.ok(Array.isArray(result.data.requests));
  assert.ok(logs.some((l) => /panel "compliance" failed/.test(l)));
});

test('missing readiness sheets (setup not re-run) degrade to [] — never a crash', () => {
  const sheets = activeSheets();
  delete sheets.OpeningChecklist; delete sheets.EmergencyReadiness; // simulate pre-setupSheet() deploy
  const { result } = callManagement({ sheets });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.openingChecklist, []);
  assert.deepEqual(result.data.emergencyReadiness, []);
});

test('canManage gate still holds: a non-manager actor → ok:false forbidden, no data read', () => {
  const { result } = callManagement({}, { name: 'רועי', role: 'field_ops' });
  assert.equal(result.ok, false);
  assert.match(result.error, /[Ff]orbidden/);
});

// ---- deleteCompliance ----

function compliantSheets() {
  const Compliance = mutableSheet([
    COMPLIANCE_HEADERS,
    ['C1', 'caesarea-ofroni', 'רישיון עסק', '2026-09-01', '', '', '', 'TRUE'],
    ['C2', 'all', 'ביטוח', '2026-10-01', '', '', '', 'TRUE'],
  ]);
  const AuditLog = mutableSheet([AUDIT_HEADERS]);
  return { sheets: activeSheets({ Compliance, AuditLog }), Compliance, AuditLog };
}

test('deleteCompliance: ops_manager deletes the row by id and writes an audit entry', () => {
  const { sheets, Compliance, AuditLog } = compliantSheets();
  const { api, captured } = loadHandler({ sheets });
  api.handleDeleteCompliance_({ id: 'C1' }, { name: 'אולגה', role: 'ops_manager' });
  const res = JSON.parse(captured.out);
  assert.equal(res.ok, true);
  assert.equal(res.id, 'C1');
  assert.equal(Compliance._deletedRows.length, 1);
  assert.ok(!Compliance._data.some((r) => r[0] === 'C1'), 'C1 row removed');
  assert.ok(Compliance._data.some((r) => r[0] === 'C2'), 'C2 untouched');
  const audit = AuditLog._data[AuditLog._data.length - 1];
  assert.equal(audit[0], 'C1');           // request_id column carries the compliance id
  assert.equal(audit[2], 'נמחק');          // to_status
  assert.equal(audit[3], 'אולגה');         // by = actor
});

test('deleteCompliance: an unknown id is reported, not treated as success, and deletes nothing', () => {
  const { sheets, Compliance } = compliantSheets();
  const { api, captured } = loadHandler({ sheets });
  api.handleDeleteCompliance_({ id: 'NOPE' }, { name: 'אולגה', role: 'ops_manager' });
  const res = JSON.parse(captured.out);
  assert.equal(res.ok, false);
  assert.match(res.error, /not found/i);
  assert.equal(Compliance._deletedRows.length, 0);
});

test('deleteCompliance: field_ops and tier B are refused (canManage), no row deleted', () => {
  for (const role of ['field_ops', 'coordinator', 'maintenance']) {
    const { sheets, Compliance } = compliantSheets();
    const { api, captured } = loadHandler({ sheets });
    api.handleDeleteCompliance_({ id: 'C1' }, { name: 'x', role });
    const res = JSON.parse(captured.out);
    assert.equal(res.ok, false, `${role} must be forbidden`);
    assert.match(res.error, /[Ff]orbidden/);
    assert.equal(Compliance._deletedRows.length, 0);
  }
});

test('deleteCompliance: a missing id → error, nothing deleted', () => {
  const { sheets, Compliance } = compliantSheets();
  const { api, captured } = loadHandler({ sheets });
  api.handleDeleteCompliance_({}, { name: 'אולגה', role: 'ops_manager' });
  const res = JSON.parse(captured.out);
  assert.equal(res.ok, false);
  assert.equal(Compliance._deletedRows.length, 0);
});
