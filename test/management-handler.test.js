// test/management-handler.test.js — end-to-end guard for the LIVE managementData failure path.
//
// Regression: after the training-digest consumption (increment 37) shipped, a throw OUTSIDE
// readTrainingCompliance_'s own try/catch (a flaky CacheService, a Config read, the id→name map)
// propagated out of the ENTIRE handleManagementData_ response as a non-JSON crash, so the client's
// res.json() failed and the WHOLE /management screen showed the generic "שגיאה בטעינה" — not just the
// training panel. The fix isolates every foreign/derived panel (safePanel_) and adds a top-level doPost
// catch. This test fixtures the FULL handler (not the pure shaper) by loading the real apps-script .gs
// files in a sandbox with stubbed Apps Script globals, and asserts a single panel failure degrades to an
// "unavailable" panel while the rest of the screen still loads (ok:true).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Apps Script shares ONE global scope across all .gs files; concatenate them like the runtime does.
const CODE = readFileSync(join(root, 'apps-script/digest.gs'), 'utf8') + '\n' +
  readFileSync(join(root, 'apps-script/Code.gs'), 'utf8');

function sheetOf(rows2d) {
  return { getDataRange: () => ({ getValues: () => rows2d }) };
}
// A sheet whose read throws — used to force a specific panel producer to blow up.
function throwingSheet(msg) {
  return { getDataRange: () => { throw new Error(msg); } };
}

const TRAINING_HEADERS = ['house', 'guideName', 'firstAidStatus', 'firstAidDate', 'instructorStatus', 'instructorDate', 'overallStatus', 'updatedAt'];

// Build the ACTIVE (Logistics) spreadsheet's sheet set. `overrides` swaps in throwing/edge sheets.
function activeSheets(overrides) {
  const base = {
    Config: sheetOf([['key', 'value'], ['approval_threshold', '3000'], ['training_digest_id', '  1RgLLrvymIhRh0sN6jOuCcgr5VT8hQL8wofhjUUt1CCI  ']]),
    Requests: sheetOf([['id', 'house', 'status', 'created_at']]),
    Inspections: sheetOf([['id']]),
    InspectionFindings: sheetOf([['id']]),
    Houses: sheetOf([['name', 'status'], ['רמות השבים', 'פתוח']]),
    InventoryItems: sheetOf([['item_text']]),
    InventoryCounts: sheetOf([['house']]),
    Budgets: sheetOf([['house', 'period', 'amount', 'notes']]),
    MaintenancePlan: sheetOf([['id', 'house', 'task', 'frequency_months', 'last_done', 'active', 'notes']]),
    Compliance: sheetOf([['id', 'house', 'item', 'expires_at', 'reminder_days', 'doc_url', 'notes', 'active']]),
    Events: sheetOf([['id', 'created_at', 'created_by', 'house', 'occurred_at', 'event_type', 'severity', 'description', 'immediate_action', 'root_cause', 'lessons', 'corrective_request_id', 'status', 'closed_at', 'notes']]),
  };
  return Object.assign(base, overrides || {});
}

const okCache = () => ({ getScriptCache: () => ({ get: () => null, put: () => {} }) });

// Load the real handler in a sandbox and return { handleManagementData_, safePanel_ } plus a capture.
function loadHandler({ sheets, openById, cacheService } = {}) {
  const captured = { out: null, logs: [] };
  const sandbox = {
    Logger: { log: (m) => captured.logs.push(String(m)) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (s) => ({ setMimeType: () => ({ _text: s }) }),
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({ getSheetByName: (n) => (sheets || activeSheets())[n] || null }),
      openById: openById || (() => { throw new Error('no access'); }),
    },
    CacheService: cacheService ? cacheService() : okCache(),
    console,
  };
  // ContentService capture: intercept createTextOutput to record the JSON string.
  sandbox.ContentService.createTextOutput = (s) => { captured.out = s; return { setMimeType: () => ({ _text: s }) }; };
  const keys = Object.keys(sandbox);
  const factory = new Function(...keys, CODE + '\n;return { handleManagementData_: handleManagementData_, safePanel_: safePanel_ };');
  const api = factory(...keys.map((k) => sandbox[k]));
  return { api, captured };
}

function callManagement(opts, actor) {
  const { api, captured } = loadHandler(opts);
  api.handleManagementData_({}, actor || { name: 'אולגה', role: 'ops_manager' });
  return { result: JSON.parse(captured.out), logs: captured.logs };
}

// ---- safePanel_ primitive ----

test('safePanel_ returns the producer value on success, and the fallback (logged) on throw', () => {
  const { api, captured } = loadHandler();
  assert.deepEqual(api.safePanel_('x', () => ({ available: true, houses: [] }), null), { available: true, houses: [] });
  const fb = { available: false, reason: 'r' };
  assert.equal(api.safePanel_('training', () => { throw new Error('boom'); }, fb), fb);
  assert.ok(captured.logs.some((l) => /panel "training" failed/.test(l) && /boom/.test(l)));
});

// ---- end-to-end: a single panel failing must NOT blank the screen ----

test('LIVE BUG: a training read that throws OUTSIDE its inner try (flaky CacheService) → ok:true, training degraded', () => {
  // Pre-fix this exact case escaped the reader and the handler → non-JSON crash → whole screen blank.
  const cacheService = () => ({ getScriptCache: () => ({ get: () => { throw new Error('cache backend error'); }, put: () => {} }) });
  const { result } = callManagement({ cacheService });
  assert.equal(result.ok, true);                       // the whole screen still loads
  assert.equal(result.data.training.available, false); // training degrades to its own "unavailable"
  assert.ok(result.data.training.reason);
  // every other section is still present — one panel's failure did not take them down
  assert.ok(Array.isArray(result.data.requests));
  assert.ok(result.data.houses && result.data.maintenance !== undefined && result.data.events !== undefined);
});

test('safePanel_ isolates a panel with NO inner guard (events sheet read throws) → ok:true, events null', () => {
  // readEventsAnalysis_ has no try/catch of its own; only safePanel_ stands between it and the handler.
  const sheets = activeSheets({ Events: throwingSheet('Events read failed') });
  const { result, logs } = callManagement({ sheets });
  assert.equal(result.ok, true);
  assert.equal(result.data.events, null);              // degraded to the html "לא זמין" fallback
  assert.ok(logs.some((l) => /panel "events" failed/.test(l)));
});

test('happy path: a valid TrainingCompliance tab → training available:true with real per-house numbers', () => {
  const digestSheet = sheetOf([
    TRAINING_HEADERS,
    ['ramot-hashavim', 'דנה', 'ok', '2026-01-05', 'warn', '2026-02-10', 'warn', '2026-08-01T00:00:00Z'],
    ['ramot-hashavim', 'אורי', 'ok', '2026-03-01', 'ok', '2026-03-01', 'ok', '2026-08-01T00:00:00Z'],
  ]);
  const openById = () => ({ getSheetByName: (n) => (n === 'TrainingCompliance' ? digestSheet : null) });
  const { result } = callManagement({ openById });
  assert.equal(result.ok, true);
  assert.equal(result.data.training.available, true);
  const ramot = result.data.training.houses.find((h) => h.id === 'ramot-hashavim');
  assert.equal(ramot.hasData, true);
  assert.equal(ramot.total, 2);
  assert.equal(ramot.compliancePercent, 50); // 1 of 2 overall-ok
});

test('canManage gate still holds: a non-manager actor → ok:false forbidden, no data read', () => {
  const { result } = callManagement({}, { name: 'רועי', role: 'field_ops' });
  assert.equal(result.ok, false);
  assert.match(result.error, /[Ff]orbidden/);
});
