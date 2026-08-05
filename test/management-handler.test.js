// test/management-handler.test.js — end-to-end guard for the LIVE managementData handler + the new
// PR B readiness/compliance write handlers. Loads the REAL apps-script .gs files in a sandbox with
// stubbed Apps Script globals (Apps Script shares ONE global scope, so we concatenate them like the
// runtime does) and asserts on the real handlers — not a pure re-implementation.
//
// Guards: (1) the trimmed managementData payload shape; (2) safePanel_ isolation — one panel's failure
// degrades to its own state while the rest of the screen still loads (ok:true); (3) the canManage gate;
// (4) the new readiness checklists + compliance-delete writes (add/tick/delete, board allow-list, audit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CODE = readFileSync(join(root, 'apps-script/digest.gs'), 'utf8') + '\n' +
  readFileSync(join(root, 'apps-script/Code.gs'), 'utf8');

// Read-only sheet (getDataRange only).
function sheetOf(rows2d) { return { getDataRange: () => ({ getValues: () => rows2d.map((r) => r.slice()) }) }; }
function throwingSheet(msg) { return { getDataRange: () => { throw new Error(msg); } }; }

// Mutable sheet supporting the read + write ops the handlers use (getRange/setValue/appendRow/deleteRow).
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

function activeSheets(overrides) {
  const base = {
    Config: sheetOf([['key', 'value'], ['approval_threshold', '3000']]),
    Requests: sheetOf([['id', 'house', 'status', 'created_at']]),
    Houses: sheetOf([['name', 'status'], ['רמות השבים', 'open'], ['שדה אליעזר', 'pre-opening']]),
    Budgets: sheetOf([['house', 'period', 'amount', 'notes']]),
    MaintenancePlan: sheetOf([['id', 'house', 'task', 'frequency_months', 'last_done', 'active', 'notes']]),
    Compliance: sheetOf([['id', 'house', 'item', 'expires_at', 'reminder_days', 'doc_url', 'notes', 'active']]),
    OpeningChecklist: sheetOf([['id', 'house', 'item', 'done', 'date', 'by']]),
    EmergencyReadiness: sheetOf([['id', 'house', 'item', 'done', 'date', 'by']]),
  };
  return Object.assign(base, overrides || {});
}

const okCache = () => ({ getScriptCache: () => ({ get: () => null, put: () => {} }) });

function loadHandler({ sheets, cacheService } = {}) {
  const captured = { out: null, logs: [] };
  const sheetSet = sheets || activeSheets();
  const sandbox = {
    Logger: { log: (m) => captured.logs.push(String(m)) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => { captured.out = s; return { setMimeType: () => ({ _text: s }) }; } },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n) => sheetSet[n] || null }) },
    CacheService: cacheService ? cacheService() : okCache(),
    Utilities: { formatDate: () => '' },
    console,
  };
  const keys = Object.keys(sandbox);
  const ret = 'return { handleManagementData_, safePanel_, handleAddReadinessItem_, handleUpdateReadinessItem_, handleDeleteReadinessItem_, handleDeleteCompliance_ };';
  const factory = new Function(...keys, CODE + '\n;' + ret);
  return { api: factory(...keys.map((k) => sandbox[k])), captured, sheetSet };
}

const OLGA = { name: 'אולגה', role: 'ops_manager' };
function callManagement(opts, actor) {
  const { api, captured } = loadHandler(opts);
  api.handleManagementData_({}, actor || OLGA);
  return { result: JSON.parse(captured.out), logs: captured.logs };
}

// ---- payload shape (PR B: trimmed) ----

test('managementData returns ONLY the owned panels; removed panels are gone', () => {
  const { result } = callManagement();
  assert.equal(result.ok, true);
  const d = result.data;
  assert.ok(Array.isArray(d.requests) && Array.isArray(d.houses));
  assert.ok(Array.isArray(d.openingChecklist) && Array.isArray(d.emergencyReadiness));
  assert.ok('budget' in d && 'maintenance' in d && 'compliance' in d);
  // removed for good — no kitchen/coordinators/training/events/defect-closure/inspections in the payload
  for (const k of ['kitchen', 'coordinators', 'training', 'events', 'inspections', 'findings', 'inventoryCounts']) {
    assert.equal(k in d, false, `${k} must no longer be sent to the screen`);
  }
});

// ---- safePanel_ isolation ----

test('safePanel_ returns the producer value on success, and the fallback (logged) on throw', () => {
  const { api, captured } = loadHandler();
  assert.deepEqual(api.safePanel_('x', () => ({ ok: 1 }), null), { ok: 1 });
  assert.equal(api.safePanel_('compliance', () => { throw new Error('boom'); }, null), null);
  assert.ok(captured.logs.some((l) => /panel "compliance" failed/.test(l) && /boom/.test(l)));
});

test('one panel failing (Compliance read throws) → ok:true, compliance null, everything else loads', () => {
  const sheets = activeSheets({ Compliance: throwingSheet('Compliance read failed') });
  const { result, logs } = callManagement({ sheets });
  assert.equal(result.ok, true);
  assert.equal(result.data.compliance, null);
  assert.ok(Array.isArray(result.data.requests) && result.data.houses);
  assert.ok(logs.some((l) => /panel "compliance" failed/.test(l)));
});

test('a missing readiness sheet degrades that list to [] (not a whole-screen error)', () => {
  const sheets = activeSheets({ OpeningChecklist: null }); // setupSheet not yet re-run
  const { result } = callManagement({ sheets });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.openingChecklist, []);
});

test('canManage gate: a non-manager actor → ok:false forbidden, no data read', () => {
  const { result } = callManagement({}, { name: 'רועי', role: 'field_ops' });
  assert.equal(result.ok, false);
  assert.match(result.error, /[Ff]orbidden/);
});

// ---- readiness write handlers (add / tick / delete) ----

test('addReadinessItem: valid board+house+item appends a row; invalid board / non-manager refused', () => {
  const sheets = activeSheets({ OpeningChecklist: mutableSheet(['id', 'house', 'item', 'done', 'date', 'by'], []) });
  const { api } = loadHandler({ sheets });
  const ok = JSON.parse(api.handleAddReadinessItem_({ board: 'opening', house: 'שדה אליעזר', item: 'מים' }, OLGA)._text);
  assert.equal(ok.ok, true);
  assert.equal(sheets.OpeningChecklist._data.length, 2);          // header + 1 appended
  assert.equal(sheets.OpeningChecklist._data[1][1], 'שדה אליעזר'); // house col
  assert.equal(sheets.OpeningChecklist._data[1][3], 'FALSE');      // done defaults FALSE
  assert.equal(JSON.parse(api.handleAddReadinessItem_({ board: 'nope', house: 'h', item: 'i' }, OLGA)._text).ok, false);
  assert.match(JSON.parse(api.handleAddReadinessItem_({ board: 'opening', house: 'h', item: 'i' }, { role: 'field_ops' })._text).error, /[Ff]orbidden/);
});

test('updateReadinessItem: ticking stamps done TRUE + today + the actor; unticking clears them', () => {
  const sheets = activeSheets({ EmergencyReadiness: mutableSheet(['id', 'house', 'item', 'done', 'date', 'by'], [['E1', 'רמות השבים', 'גנרטור', 'FALSE', '', '']]) });
  const { api } = loadHandler({ sheets });
  JSON.parse(api.handleUpdateReadinessItem_({ board: 'emergency', id: 'E1', done: true }, OLGA)._text);
  const row = sheets.EmergencyReadiness._data[1];
  assert.equal(row[3], 'TRUE');
  assert.match(String(row[4]), /^\d{4}-\d{2}-\d{2}$/); // date stamped
  assert.equal(row[5], 'אולגה');                       // by = actor, never client
  JSON.parse(api.handleUpdateReadinessItem_({ board: 'emergency', id: 'E1', done: false }, OLGA)._text);
  assert.deepEqual(sheets.EmergencyReadiness._data[1].slice(3), ['FALSE', '', '']);
});

test('deleteReadinessItem removes the row; missing id → not found', () => {
  const sheets = activeSheets({ OpeningChecklist: mutableSheet(['id', 'house', 'item', 'done', 'date', 'by'], [['O1', 'שדה אליעזר', 'מים', 'TRUE', '2026-02-01', 'רועי']]) });
  const { api } = loadHandler({ sheets });
  assert.equal(JSON.parse(api.handleDeleteReadinessItem_({ board: 'opening', id: 'O1' }, OLGA)._text).ok, true);
  assert.equal(sheets.OpeningChecklist._data.length, 1); // back to header only
  assert.equal(JSON.parse(api.handleDeleteReadinessItem_({ board: 'opening', id: 'ghost' }, OLGA)._text).ok, false);
});

// ---- compliance delete (audit-logged) ----

test('deleteCompliance removes the entry AND writes an audit row; non-manager refused', () => {
  const audit = mutableSheet(['request_id', 'from_status', 'to_status', 'by', 'timestamp', 'note'], []);
  const sheets = activeSheets({
    Compliance: mutableSheet(['id', 'house', 'item', 'expires_at', 'reminder_days', 'doc_url', 'notes', 'active'],
      [['C1', 'רמות השבים', 'רישיון עסק', '2026-12-01', '', '', '', 'TRUE']]),
    AuditLog: audit,
  });
  const { api } = loadHandler({ sheets });
  assert.match(JSON.parse(api.handleDeleteCompliance_({ id: 'C1' }, { role: 'field_ops' })._text).error, /[Ff]orbidden/);
  assert.equal(sheets.Compliance._data.length, 2); // still there after the refused attempt
  const ok = JSON.parse(api.handleDeleteCompliance_({ id: 'C1' }, OLGA)._text);
  assert.equal(ok.ok, true);
  assert.equal(sheets.Compliance._data.length, 1);            // removed
  assert.equal(audit._data.length, 2);                        // header + 1 audit row
  assert.equal(audit._data[1][2], 'נמחק');                    // to_status
  assert.match(String(audit._data[1][5]), /רישיון עסק/);      // note carries the item name
});
