// test/digest-trigger.test.js — the DEFERRED digest rebuild (perf round-4), on the REAL .gs files.
//
// Writes used to rebuild both digest tabs synchronously (open the digest spreadsheet, read Requests +
// AuditLog + InventoryCounts, rewrite two tabs) before answering — seconds per approve / reject / close.
// Now a write ENQUEUES the rebuild via a one-off time trigger and returns at once. This locks:
//   - scheduleDigestRebuild(): creates ONE one-off trigger (~1 min, handler rebuildDigestFromTrigger);
//     a second call while one is pending creates nothing (deduped); unprovisioned digest → nothing;
//     a ScriptApp failure is logged, never thrown (the write still succeeds);
//   - a write handler (handleApprove_) no longer opens the digest spreadsheet in the request — it only
//     enqueues; the response is immediate;
//   - rebuildDigestFromTrigger(): deletes the pending one-off trigger(s) FIRST, then rebuilds both tabs
//     under the script lock; after it ran, the next write can enqueue again (no lost update);
//   - rebuildDigestNow(): the manual editor entry rebuilds synchronously;
//   - the 15-minute installDigestTrigger backstop is untouched and leaves the one-off triggers alone;
//   - every write-path handler calls scheduleDigestRebuild(), never rebuildDigest() (static guard).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIGEST_GS = readFileSync(join(root, 'apps-script/digest.gs'), 'utf8');
const CODE_GS = readFileSync(join(root, 'apps-script/Code.gs'), 'utf8');
const GS = DIGEST_GS + '\n' + CODE_GS;
const SECRET = 's'.repeat(40);
const APPROVER = 'olga-77';

function mutableSheet(header, rows) {
  const data = [header.slice()].concat((rows || []).map((r) => r.slice()));
  const range = (r, c, nr, nc) => ({
    getValues: () => { const out = []; for (let i = 0; i < (nr || 1); i++) { const row = []; for (let j = 0; j < (nc || 1); j++) row.push((data[r - 1 + i] || [])[c - 1 + j]); out.push(row); } return out; },
    setValue: (v) => { data[r - 1][c - 1] = v; },
    setValues: (vals) => { for (let i = 0; i < vals.length; i++) data[r - 1 + i] = vals[i].slice(); return range(r, c, nr, nc); },
    setFontWeight: () => range(r, c, nr, nc),
    clearContent: () => { for (let i = 0; i < (nr || 1); i++) if (data[r - 1 + i]) data[r - 1 + i] = data[r - 1 + i].map(() => ''); },
  });
  return {
    _data: data,
    getDataRange: () => ({ getValues: () => data.map((r) => r.slice()) }),
    getLastColumn: () => Math.max(header.length, ...data.map((r) => r.length)),
    getLastRow: () => data.length,
    getRange: range,
    appendRow: (row) => { data.push(row.slice()); },
    deleteRow: (r) => { data.splice(r - 1, 1); },
    setFrozenRows: () => {},
    getName: () => 'x',
  };
}
const REQ_HEADER = ['id', 'house', 'category', 'urgency', 'estimated_cost', 'status', 'approval_required', 'approved_by', 'approved_at', 'rejection_reason', 'rejected_at', 'deferred_until', 'due_at', 'created_at', 'created_by', 'description', 'location_in_house', 'completed_at', 'assigned_to', 'blocked'];

// A sandbox deployment. `digestId` null = digest not provisioned. `scriptAppThrows` makes trigger creation fail.
function deploy({ digestId = 'DIGEST-1', scriptAppThrows = false } = {}) {
  const sheets = {
    Config: mutableSheet(['key', 'value'], [['archive_after_days', '7']]),
    Houses: mutableSheet(['name', 'status', 'cluster'], [['רמות השבים', 'open', 'sharon']]),
    Requests: mutableSheet(REQ_HEADER, [['R1', 'רמות השבים', 'תיקון', 'רגיל', 500, 'דרישה', '', '', '', '', '', '', '', '2026-08-01T08:00:00.000Z', 'שירה', 'x', '', '', '', '']]),
    AuditLog: mutableSheet(['request_id', 'from_status', 'to_status', 'by', 'timestamp', 'note'], []),
    InventoryItems: mutableSheet(['id', 'name'], []),
    InventoryCounts: mutableSheet(['id', 'house', 'week_start'], []),
  };
  const digestTabs = {};
  const digestSs = {
    getSheetByName: (n) => digestTabs[n] || null,
    insertSheet: (n) => { digestTabs[n] = mutableSheet([], []); return digestTabs[n]; },
    getSheets: () => Object.values(digestTabs),
  };
  const state = { triggers: [], created: [], deleted: [], openById: 0, logs: [], locks: 0 };
  const makeTrigger = (fn) => ({ getHandlerFunction: () => fn, _id: `t${state.created.length + 1}` });
  const props = { DIGEST_SHEET_ID: digestId, SESSION_SECRET: SECRET, APPROVER_CODE: APPROVER };
  const captured = { out: null };
  const sandbox = {
    Logger: { log: (m) => state.logs.push(String(m)) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => { captured.out = s; return { setMimeType: () => ({ _text: s }) }; } },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({ getSheetByName: (n) => sheets[n] || null }),
      openById: (id) => { state.openById++; if (id !== digestId) throw new Error('no such spreadsheet'); return digestSs; },
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null) }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => { state.locks++; return true; }, releaseLock: () => {} }) },
    ScriptApp: {
      getProjectTriggers: () => state.triggers.slice(),
      deleteTrigger: (t) => { state.deleted.push(t.getHandlerFunction()); state.triggers = state.triggers.filter((x) => x !== t); },
      newTrigger: (fn) => ({ timeBased: () => ({
        after: (ms) => ({ create: () => { if (scriptAppThrows) throw new Error('quota'); const t = makeTrigger(fn); state.triggers.push(t); state.created.push({ fn, ms }); return t; } }),
        everyMinutes: (m) => ({ create: () => { const t = makeTrigger(fn); state.triggers.push(t); state.created.push({ fn, everyMinutes: m }); return t; } }),
      }) }),
    },
    Utilities: { formatDate: (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d)) },
    Session: { getScriptTimeZone: () => 'Asia/Jerusalem' },
    console,
  };
  const keys = Object.keys(sandbox);
  const factory = new Function(...keys, GS + '\n;return { scheduleDigestRebuild, rebuildDigestFromTrigger, rebuildDigestNow, rebuildDigest, installDigestTrigger, handleApprove_, handleSetStatus_, getRequestById, DIGEST_TRIGGER_FN_ };');
  const api = factory(...keys.map((k) => sandbox[k]));
  const call = (fn, payload, actor) => { api[fn](payload, actor); return JSON.parse(captured.out); };
  return { api, state, sheets, digestTabs, call };
}
const OLGA = { name: 'רועי', role: 'ops_manager', scope: '' };

test('scheduleDigestRebuild creates ONE one-off trigger (~1 min) for rebuildDigestFromTrigger', () => {
  const { api, state } = deploy();
  assert.equal(api.scheduleDigestRebuild(), true);
  assert.equal(state.created.length, 1);
  assert.equal(state.created[0].fn, 'rebuildDigestFromTrigger');
  assert.equal(state.created[0].ms, 60 * 1000);
  assert.equal(api.DIGEST_TRIGGER_FN_, 'rebuildDigestFromTrigger');
  assert.equal(state.openById, 0, 'scheduling never opens the digest spreadsheet');
});

test('DEDUPE: while a one-off trigger is pending, further writes create nothing (one pending max)', () => {
  const { api, state } = deploy();
  api.scheduleDigestRebuild();
  assert.equal(api.scheduleDigestRebuild(), false);
  assert.equal(api.scheduleDigestRebuild(), false);
  assert.equal(state.created.length, 1);
  assert.equal(state.triggers.length, 1);
});

test('an unprovisioned digest (no DIGEST_SHEET_ID) schedules nothing', () => {
  const { api, state } = deploy({ digestId: null });
  assert.equal(api.scheduleDigestRebuild(), false);
  assert.equal(state.created.length, 0);
});

test('a ScriptApp failure (quota) is logged, never thrown — the write is not broken', () => {
  const { api, state } = deploy({ scriptAppThrows: true });
  assert.doesNotThrow(() => api.scheduleDigestRebuild());
  assert.ok(state.logs.some((l) => /scheduleDigestRebuild failed: quota/.test(l)));
});

test('a WRITE (approve) returns immediately: it enqueues the rebuild and never opens the digest spreadsheet', () => {
  const { api, state, call } = deploy();
  const out = call('handleApprove_', { id: 'R1', approver_code: APPROVER }, OLGA);
  assert.deepEqual(out, { ok: true });
  assert.equal(api.getRequestById('R1').status, 'מאושר', 'the row was written');
  assert.equal(state.openById, 0, 'NO digest spreadsheet open in the request (was: every write)');
  assert.equal(state.created.length, 1, 'one one-off rebuild trigger enqueued');
  // a second write in the same minute enqueues nothing more
  call('handleSetStatus_', { id: 'R1', to: 'בביצוע' }, OLGA);
  assert.equal(state.created.length, 1, 'burst of writes → one pending trigger');
});

test('rebuildDigestFromTrigger deletes the pending trigger(s) FIRST, then rebuilds both tabs under the lock', () => {
  const { api, state, digestTabs } = deploy();
  api.scheduleDigestRebuild();
  api.rebuildDigestFromTrigger();
  assert.deepEqual(state.deleted, ['rebuildDigestFromTrigger'], 'the one-off trigger removed itself');
  assert.equal(state.triggers.length, 0);
  assert.equal(state.openById, 1, 'the digest spreadsheet was opened once, by the rebuild');
  assert.ok(state.locks >= 1, 'the rebuild ran under the script lock');
  assert.ok(digestTabs.OpenTickets && digestTabs.WeeklyCounts, 'both digest tabs were (re)written');
  // NO LOST UPDATE: a write landing after the trigger fired can enqueue a fresh one
  assert.equal(api.scheduleDigestRebuild(), true);
  assert.equal(state.triggers.length, 1);
});

test('rebuildDigestNow (manual, editor) rebuilds synchronously and touches no trigger', () => {
  const { api, state, digestTabs } = deploy();
  api.rebuildDigestNow();
  assert.equal(state.openById, 1);
  assert.equal(state.created.length, 0);
  assert.ok(digestTabs.OpenTickets, 'rebuilt');
});

test('the 15-minute backstop (installDigestTrigger) is untouched and leaves a pending one-off trigger alone', () => {
  const { api, state } = deploy();
  api.scheduleDigestRebuild();
  api.installDigestTrigger();
  assert.ok(state.created.some((c) => c.fn === 'rebuildDigest' && c.everyMinutes === 15), '15-min backstop installed');
  assert.ok(state.triggers.some((t) => t.getHandlerFunction() === 'rebuildDigestFromTrigger'), 'the pending one-off trigger survives');
});

test('STATIC GUARD: every write-path handler enqueues (scheduleDigestRebuild) — the only inline rebuild left is the background maintenance scan', () => {
  const inline = [...CODE_GS.matchAll(/\brebuildDigest\(\);/g)].length;
  assert.equal(inline, 1, 'one inline rebuild: runMaintenanceScan (a time trigger, nobody waiting)');
  const scan = CODE_GS.slice(CODE_GS.indexOf('function runMaintenanceScan('), CODE_GS.indexOf('function installMaintenanceTrigger('));
  assert.match(scan, /rebuildDigest\(\);/, 'and it is inside runMaintenanceScan');
  const scheduled = [...CODE_GS.matchAll(/scheduleDigestRebuild\(\);/g)].length;
  assert.ok(scheduled >= 18, `every write handler enqueues (found ${scheduled})`);
  for (const fn of ['handleApprove_', 'handleReject_', 'handleDefer_', 'handleAssign_', 'handleSetStatus_', 'handleSetBlocked_', 'handleCreateRequest_', 'handleEditRequest_', 'handleDeleteRequest_']) {
    const body = CODE_GS.slice(CODE_GS.indexOf(`function ${fn}(`));
    const end = body.indexOf('\nfunction ', 1);
    assert.match(body.slice(0, end), /scheduleDigestRebuild\(\)/, `${fn} enqueues the rebuild`);
  }
});
