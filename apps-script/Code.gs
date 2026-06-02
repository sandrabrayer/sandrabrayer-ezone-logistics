/**
 * Code.gs — backend read/write layer for EZone Logistics.
 *
 * SCOPE (increment 1): data access ONLY. No approval routing, no status transitions, no
 * batching — those arrive in later increments. This layer exposes typed reads and two writes
 * (appendRequest, writeAuditEntry) that later logic builds on.
 *
 * SECURITY / LEAST PRIVILEGE:
 *  - This script is container-bound to THIS app's spreadsheet only. It must not be granted
 *    access to the Dashboard/Managers spreadsheets.
 *  - doPost validates and whitelists input before any write. No eval, no arbitrary sheet writes.
 *  - No secrets in this file. The deployment URL / Sheet ID live in the frontend .env, untracked.
 *
 * Mirrors src/schema.js (headers) and src/config.js (coercion). Keep them in sync.
 */

// ---- Coercion (mirror of src/config.js) ----
var NUMERIC_KEYS = ['approval_threshold', 'batching_window_days'];
var BOOLEAN_KEYS = ['emergency_bypasses_approval'];
var TRUE_STRINGS = ['true', 'TRUE', 'True', '1', 'yes', 'YES'];

function coerceConfigValue_(key, rawValue) {
  if (NUMERIC_KEYS.indexOf(key) !== -1) {
    var n = Number(rawValue);
    if (isNaN(n)) throw new Error('Config key "' + key + '" expected a number but got "' + rawValue + '"');
    return n;
  }
  if (BOOLEAN_KEYS.indexOf(key) !== -1) {
    return TRUE_STRINGS.indexOf(String(rawValue).trim()) !== -1;
  }
  return rawValue;
}

// ---- Generic sheet helpers ----

function getSheet_(name) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error('Sheet "' + name + '" not found. Run setupSheet() first.');
  return sheet;
}

/** Read a sheet into an array of objects keyed by its header row. */
function readObjects_(name) {
  var sheet = getSheet_(name);
  var range = sheet.getDataRange().getValues();
  if (range.length < 2) return [];
  var headers = range[0];
  var out = [];
  for (var r = 1; r < range.length; r++) {
    var row = range[r];
    var obj = {};
    for (var c = 0; c < headers.length; c++) obj[headers[c]] = row[c];
    out.push(obj);
  }
  return out;
}

// ---- Config ----

function getAllConfig() {
  var rows = readObjects_('Config');
  var out = {};
  rows.forEach(function (row) {
    if (row.key === '' || row.key === null) return;
    out[row.key] = coerceConfigValue_(row.key, row.value);
  });
  return out;
}

function getConfig(key) {
  var all = getAllConfig();
  return Object.prototype.hasOwnProperty.call(all, key) ? all[key] : null;
}

// ---- Reads ----

function getHouses() { return readObjects_('Houses'); }
function getTechnicians() { return readObjects_('Technicians'); }
function getRequests() { return readObjects_('Requests'); }

function getRequestById(id) {
  var all = getRequests();
  for (var i = 0; i < all.length; i++) {
    if (String(all[i].id) === String(id)) return all[i];
  }
  return null;
}

// ---- Writes ----

/**
 * Append one request row. Increment-1 write primitive: takes an object keyed by Requests
 * headers, fills missing columns with ''. Does NOT compute approval_required or status —
 * that is the approval increment's job. Returns the written id.
 */
function appendRequest(obj) {
  var sheet = getSheet_('Requests');
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var row = headers.map(function (h) {
    return Object.prototype.hasOwnProperty.call(obj, h) && obj[h] != null ? obj[h] : '';
  });
  sheet.appendRow(row);
  return obj.id;
}

/** Append one audit-log entry. Every later status transition calls this. */
function writeAuditEntry(requestId, fromStatus, toStatus, by, note) {
  var sheet = getSheet_('AuditLog');
  sheet.appendRow([
    requestId, fromStatus || '', toStatus || '', by || '', new Date().toISOString(), note || '',
  ]);
}

// ---- HTTP router (stubs; validated, whitelisted) ----

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || '';
  var result;
  switch (action) {
    case 'houses':      result = getHouses(); break;
    case 'technicians': result = getTechnicians(); break;
    case 'requests':    result = getRequests(); break;
    case 'config':      result = getAllConfig(); break;
    default:
      return jsonOut_({ ok: false, error: 'Unknown or missing action' });
  }
  return jsonOut_({ ok: true, data: result });
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return jsonOut_({ ok: false, error: 'Invalid JSON body' });
  }

  var action = body.action;
  // Whitelist: only known actions are accepted. Increment 1 exposes request creation only.
  if (action !== 'createRequest') {
    return jsonOut_({ ok: false, error: 'Unknown or unsupported action' });
  }

  var validationError = validateNewRequest_(body.payload);
  if (validationError) return jsonOut_({ ok: false, error: validationError });

  // NOTE: status/approval_required intentionally left to the approval increment.
  var id = appendRequest(body.payload);
  return jsonOut_({ ok: true, id: id });
}

/** Minimal input validation for a new request payload. Hardened further in later increments. */
function validateNewRequest_(p) {
  if (!p || typeof p !== 'object') return 'Missing payload';
  if (!p.id) return 'Missing id';
  if (!p.house) return 'Missing house';
  if (!p.category) return 'Missing category';
  if (p.estimated_cost !== '' && p.estimated_cost != null && isNaN(Number(p.estimated_cost))) {
    return 'estimated_cost must be a number or blank';
  }
  return null; // valid
}

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
