// test/dashboard-field-ops.test.js — regression guard for BUG 1: Roy (field_ops) must be able to FULLY
// operate the dashboard. Two production 403s ("Forbidden: role not authorized for this action", the
// Code.gs forbidden_() banner) were fixed:
//   1. approve/reject of a request OVER the approval_threshold — it routes to ops_manager by amount, and
//      canApprove used to require an EXACT role match, so field_ops was refused. Now any manager tier
//      (field_ops/ops_manager/ceo) may approve/reject ANY request; whoApproves()/approval_required is
//      retained for budget/reporting only, not as the approver gate.
//   2. deleteRequest — the dashboard shows מחיקה to Roy, but the handler gated isManagement_ (exec-only).
//      It now gates isManagerRole (field_ops included); the /management-only deletes stay isManagement_.
//
// Layer 1 (below) runs the REAL Code.gs handlers in a sandbox (like management-handler.test.js) so the
// actual gate — not a re-implementation — is exercised. Layer 2 asserts the pure authority predicates for
// EVERY dashboard write action, so a re-tightening of any load-path gate fails loudly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { whoApproves, APPROVER } from '../src/approval.js';
import { ROLE, canApprove, canDefer, canDispatch, canBlock, isManagerRole } from '../src/roles.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Concatenate the .gs files exactly like the Apps Script runtime (one shared global scope). Append a
// no-op rebuildDigest AFTER the sources so the last function declaration wins — the write handlers call
// rebuildDigest() on success, and re-running the whole digest is irrelevant to (and out of scope for) a
// gate regression. This keeps the sheet mock to just the sheets the gates + writes touch.
const CODE = readFileSync(join(root, 'apps-script/digest.gs'), 'utf8') + '\n' +
  readFileSync(join(root, 'apps-script/Code.gs'), 'utf8') + '\nfunction rebuildDigest(){}\n';

function sheetOf(rows2d) { return { getDataRange: () => ({ getValues: () => rows2d.map((r) => r.slice()) }) }; }

// Mutable sheet supporting the read + write ops the request handlers use (getRange/setValue/appendRow/deleteRow).
function mutableSheet(header, rows) {
  const data = [header.slice()].concat((rows || []).map((r) => r.slice()));
  return {
    _data: data,
    getDataRange: () => ({ getValues: () => data.map((r) => r.slice()) }),
    getLastColumn: () => header.length,
    getLastRow: () => data.length,
    getRange: (r, c) => ({ setValue: (v) => { data[r - 1][c - 1] = v; } }),
    appendRow: (row) => { data.push(row.slice()); },
    deleteRow: (r) => { data.splice(r - 1, 1); },
  };
}

const REQ_HEADER = ['id', 'house', 'status', 'urgency', 'estimated_cost', 'created_at'];
// One NORMAL request well OVER the ₪3000 threshold (routes to ops_manager by amount) in the initial
// 'דרישה' status, so approve/reject/delete are all legal transitions for it.
const OVER = ['REQ-OVER', 'רמות השבים', 'דרישה', 'רגיל', '9000', '2026-08-01'];

function sandboxApi(reqRows) {
  const captured = { out: null, logs: [] };
  const sheets = {
    Config: sheetOf([['key', 'value'], ['approval_threshold', '3000']]),
    Requests: mutableSheet(REQ_HEADER, reqRows),
    AuditLog: mutableSheet(['request_id', 'from', 'to', 'by', 'at', 'note'], []),
  };
  const sandbox = {
    Logger: { log: (m) => captured.logs.push(String(m)) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => { captured.out = s; return { setMimeType: () => ({ _text: s }) }; } },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n) => sheets[n] || null }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {} }) },
    Utilities: { formatDate: () => '' },
    console,
  };
  const keys = Object.keys(sandbox);
  const ret = 'return { handleApprove_, handleReject_, handleDeleteRequest_ };';
  const factory = new Function(...keys, CODE + '\n;' + ret);
  return { api: factory(...keys.map((k) => sandbox[k])), captured, sheets };
}

const ROY = { name: 'רועי', role: 'field_ops' };
const RAMI = { name: 'רמי', role: 'maintenance' };
const SHIRA = { name: 'שירה', role: 'coordinator' };

// ---- Layer 1: the REAL Code.gs handlers, exercising the actual gate ----

test('field_ops APPROVES an over-threshold request (the exact production 403) → ok:true', () => {
  const { api } = sandboxApi([OVER.slice()]);
  const out = JSON.parse(api.handleApprove_({ id: 'REQ-OVER', by: 'רועי' }, ROY)._text);
  assert.equal(out.ok, true, 'Roy must be able to approve a >₪3000 request from the dashboard');
  assert.ok(!out.error, `no forbidden error (got ${out.error || 'none'})`);
});

test('field_ops REJECTS an over-threshold request → ok:true', () => {
  const { api } = sandboxApi([OVER.slice()]);
  const out = JSON.parse(api.handleReject_({ id: 'REQ-OVER', by: 'רועי', reason: 'לא נדרש' }, ROY)._text);
  assert.equal(out.ok, true);
  assert.ok(!out.error);
});

test('field_ops DELETES a request (the מחיקה button) → ok:true and the row is removed', () => {
  const { api, sheets } = sandboxApi([OVER.slice()]);
  const out = JSON.parse(api.handleDeleteRequest_({ id: 'REQ-OVER', by: 'רועי' }, ROY)._text);
  assert.equal(out.ok, true);
  assert.equal(sheets.Requests._data.length, 1, 'only the header row remains after the delete');
});

test('the loosening is bounded: tier B (coordinator / maintenance) is STILL refused approve AND delete', () => {
  for (const actor of [RAMI, SHIRA]) {
    const { api } = sandboxApi([OVER.slice()]);
    assert.equal(JSON.parse(api.handleApprove_({ id: 'REQ-OVER', by: actor.name }, actor)._text).ok, false, `${actor.role} must not approve`);
    assert.equal(JSON.parse(api.handleDeleteRequest_({ id: 'REQ-OVER', by: actor.name }, actor)._text).ok, false, `${actor.role} must not delete`);
  }
});

// ---- Layer 2: EVERY dashboard load-path write action succeeds for field_ops (authority predicates) ----
// These compose the exact predicates the handlers run, mirroring enforcement.test.js. If any dashboard
// action is re-gated to exclude field_ops, one of these fails.

const T = 3000;
function mayApprove(role, cost, urgency) {
  const required = whoApproves(cost, urgency, T);
  return required === APPROVER.AUTO ? canDispatch(role) : canApprove(role, required);
}

test('field_ops passes the authority gate for EVERY dashboard action, at every amount tier', () => {
  const R = ROLE.FIELD_OPS;
  // approve / reject — below, at, above threshold, and emergency (auto)
  assert.equal(mayApprove(R, 500, 'רגיל'), true);   // field_ops tier
  assert.equal(mayApprove(R, 3000, 'רגיל'), true);  // at threshold (field_ops tier)
  assert.equal(mayApprove(R, 9000, 'רגיל'), true);  // ops_manager tier — the bug
  assert.equal(mayApprove(R, 9000, 'חירום'), true); // emergency auto (dispatch)
  assert.equal(canDefer(R), true);                  // defer
  assert.equal(canDispatch(R), true);               // assign / markExternal / setStatus / setExecution / assignBatch
  assert.equal(canBlock(R), true);                  // setBlocked
  assert.equal(isManagerRole(R), true);             // deleteRequest (new gate) — and confirmFinding/editRequest are open to any authenticated actor
});
