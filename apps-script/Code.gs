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

// ---- Write authorization (mirror of src/auth.js) ----
// The shared staff secret lives ONLY in Script Properties (STAFF_WRITE_TOKEN) — never in the
// repo, never injected into page HTML. The staff member types the code; the frontend verifies
// it via the verifyToken read action, then sends it as `token` on every staff write. Enforcement
// on writes is added in a later step; this block only stands up the check + verify endpoint.

// Staff-only write actions. createRequest is deliberately absent (public intake form).
var STAFF_WRITE_ACTIONS_ = [
  'approve', 'reject', 'defer', 'assign', 'markExternal', 'assignBatch',
  'setStatus', 'createInspection', 'addFinding', 'confirmFinding',
  'deleteRequest', 'editRequest', 'setExecution', 'submitInventory',
];

function writeRequiresToken_(action) {
  return STAFF_WRITE_ACTIONS_.indexOf(action) !== -1;
}

function getWriteToken_() {
  return PropertiesService.getScriptProperties().getProperty('STAFF_WRITE_TOKEN') || '';
}

// The kitchen ingest's OWN secret — a separate Script Property so the cooks app can never touch
// the staff-only writes. Fail-closed: if it is unset, tokenOk_ rejects every kitchen request.
function getKitchenSecret_() {
  return PropertiesService.getScriptProperties().getProperty('KITCHEN_COUNT_SECRET') || '';
}

/**
 * Constant-time equality of the provided token against the server secret. Fail-closed:
 * false if the server secret is unset/empty, if the provided token is empty, or on length
 * mismatch — only an exact match returns true.
 */
function tokenOk_(provided, expected) {
  if (typeof expected !== 'string' || expected.length === 0) return false;
  if (typeof provided !== 'string' || provided.length === 0) return false;
  if (provided.length !== expected.length) return false;
  var diff = 0;
  for (var i = 0; i < expected.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
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
    case 'checklist':   result = readObjects_('ChecklistItems'); break;
    case 'inspections': result = readObjects_('Inspections'); break;
    case 'findings':    result = readObjects_('InspectionFindings'); break;
    case 'inventoryItems':  result = readObjects_('InventoryItems'); break;
    case 'inventoryCounts': result = readObjects_('InventoryCounts'); break;
    // Verify a typed staff code against the server secret. Returns only a boolean — never
    // echoes the secret. The frontend gates the staff pages on { valid: true }.
    case 'verifyToken':
      return jsonOut_({ ok: true, valid: tokenOk_((e && e.parameter && e.parameter.token) || '', getWriteToken_()) });
    default:
      return jsonOut_({ ok: false, error: 'Unknown or missing action' });
  }
  return jsonOut_({ ok: true, data: result });
}

// Controlled vocabularies (mirror of src/schema.js + src/request.js).
var VALID_CATEGORIES = ['רכישה', 'תיקון', 'החלפה'];
var VALID_URGENCIES = ['רגיל', 'דחוף', 'חירום'];
var SUBMITTERS = ['שירה', 'יעקב', 'אורן', 'אביב', 'צחי', 'רועי'];
var STATUS_REQUEST = 'דרישה';

function doPost(e) {
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return jsonOut_({ ok: false, error: 'Invalid JSON body' });
  }

  // Fail-closed auth. The kitchen ingest is gated by its OWN secret (KITCHEN_COUNT_SECRET),
  // NOT the shared staff token — a leaked kitchen secret must never unlock the staff writes.
  // Every other staff write must carry the shared STAFF_WRITE_TOKEN. createRequest (public
  // intake) is exempt. This is the real gate — the public /exec is world-callable, so never
  // trust the Node layer. tokenOk_ is fail-closed: a missing/empty server secret rejects.
  if (body.action === 'submitKitchenCount') {
    if (!tokenOk_((body && body.token) || '', getKitchenSecret_())) {
      return jsonOut_({ ok: false, error: 'Unauthorized' });
    }
  } else if (writeRequiresToken_(body.action) && !tokenOk_((body && body.token) || '', getWriteToken_())) {
    return jsonOut_({ ok: false, error: 'Unauthorized' });
  }

  // Whitelisted actions only.
  switch (body.action) {
    case 'createRequest': return handleCreateRequest_(body.payload || {});
    case 'approve':       return handleApprove_(body.payload || {});
    case 'reject':        return handleReject_(body.payload || {});
    case 'defer':         return handleDefer_(body.payload || {});
    case 'assign':        return handleAssign_(body.payload || {});
    case 'markExternal':  return handleMarkExternal_(body.payload || {});
    case 'assignBatch':   return handleAssignBatch_(body.payload || {});
    case 'setStatus':     return handleSetStatus_(body.payload || {});
    case 'setExecution':  return handleSetExecution_(body.payload || {});
    case 'createInspection': return handleCreateInspection_(body.payload || {});
    case 'addFinding':       return handleAddFinding_(body.payload || {});
    case 'confirmFinding':   return handleConfirmFinding_(body.payload || {});
    case 'deleteRequest':    return handleDeleteRequest_(body.payload || {});
    case 'editRequest':      return handleEditRequest_(body.payload || {});
    case 'submitInventory':    return handleSubmitInventory_(body.payload || {});
    case 'submitKitchenCount': return handleSubmitKitchenCount_(body.payload || {});
    default:
      return jsonOut_({ ok: false, error: 'Unknown or unsupported action' });
  }
}

function handleCreateRequest_(input) {
  var validationError = validateNewRequest_(input);
  if (validationError) return jsonOut_({ ok: false, error: validationError });
  // Server owns id, status, created_at — the client never supplies them.
  var row = buildNewRequest_(input);
  // Stamp the derived approval_required flag (§6).
  row.approval_required = approvalRequired_(row.estimated_cost, row.urgency);
  appendRequest(row);
  rebuildDigest();
  return jsonOut_({ ok: true, id: row.id });
}

/** Validate raw form input. estimated_cost BLANK is valid (unknown cost is a real case). */
function validateNewRequest_(p) {
  if (!p || typeof p !== 'object') return 'Missing payload';
  if (!p.house) return 'Missing house';
  if (VALID_CATEGORIES.indexOf(p.category) === -1) return 'Invalid or missing category';
  if (VALID_URGENCIES.indexOf(p.urgency) === -1) return 'Invalid or missing urgency';
  if (SUBMITTERS.indexOf(p.created_by) === -1) return 'Invalid or missing created_by';
  var blank = (p.estimated_cost === '' || p.estimated_cost == null);
  if (!blank && isNaN(Number(p.estimated_cost))) return 'estimated_cost must be a number or blank';
  return null;
}

/** Build the full row, stamping id/status/created_at server-side. Approval fields stay blank (inc. 3). */
function buildNewRequest_(input) {
  var blank = (input.estimated_cost === '' || input.estimated_cost == null);
  return {
    id: generateRequestId_(),
    created_at: new Date().toISOString(),
    created_by: input.created_by,
    house: input.house,
    category: input.category,
    description: input.description || '',
    location_in_house: input.location_in_house || '',
    urgency: input.urgency,
    estimated_cost: blank ? '' : Number(input.estimated_cost),
    attachment_url: '',          // 2b
    status: STATUS_REQUEST,      // דרישה
    approval_required: '',       // increment 3
    approved_by: '', approved_at: '', rejection_reason: '',
    deferred_until: '', assigned_to: '', assignment_type: '', batch_id: '',
    completed_at: '', actual_cost: '', completion_notes: '',
  };
}

function generateRequestId_() {
  var stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  var suffix = String(Math.floor(Math.random() * 1e4)).padStart(4, '0');
  return 'REQ-' + stamp + '-' + suffix;
}

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===== Approval engine + status transitions (increment 3) =====
// Mirrors src/approval.js. Statuses mirror src/schema.js STATUSES.

var ST = {
  REQUEST: 'דרישה', PENDING: 'ממתין לאישור', APPROVED: 'מאושר',
  NOT_APPROVED: 'לא מאושר', DEFERRED: 'נדחה לתאריך', IN_PROGRESS: 'בביצוע',
  COMPLETED: 'הושלם', CLOSED: 'סגור',
};
var APPROVER_ROY = 'רועי';
var APPROVER_SANDRA = 'sandra';

function costIsBlank_(c) { return c === '' || c === null || c === undefined; }

function approvalRequired_(cost, urgency) {
  if (urgency === 'חירום') return false;
  if (costIsBlank_(cost)) return false;
  var t = Number(getConfig('approval_threshold'));
  return Number(cost) > t;
}

function whoApproves_(cost, urgency) {
  // Roy approves alone (Sandra removed in Inc 10). Emergencies bypass approval entirely.
  if (urgency === 'חירום') return 'auto';
  return 'roy';
}

function canApprove_(approver, cost, urgency) {
  // Any amount is Roy's call now; emergency auto-approves regardless of approver.
  return true;
}

var TRANSITIONS_ = {};
TRANSITIONS_[ST.REQUEST]  = [ST.PENDING, ST.APPROVED, ST.NOT_APPROVED, ST.DEFERRED];
TRANSITIONS_[ST.PENDING]  = [ST.APPROVED, ST.NOT_APPROVED, ST.DEFERRED];
TRANSITIONS_[ST.DEFERRED] = [ST.APPROVED, ST.NOT_APPROVED, ST.DEFERRED];
TRANSITIONS_[ST.APPROVED] = [ST.IN_PROGRESS];
TRANSITIONS_[ST.IN_PROGRESS] = [ST.COMPLETED];
TRANSITIONS_[ST.COMPLETED]   = [ST.CLOSED];
TRANSITIONS_[ST.NOT_APPROVED] = [];
TRANSITIONS_[ST.CLOSED]       = [];

function canTransition_(from, to) {
  var allowed = TRANSITIONS_[from];
  return !!allowed && allowed.indexOf(to) !== -1;
}

/** Update specific fields of a request row by id, and write an audit entry. */
function updateRequest_(id, fields, fromStatus, toStatus, by, note) {
  var sheet = getSheet_('Requests');
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][headers.indexOf('id')]) === String(id)) {
      for (var key in fields) {
        var col = headers.indexOf(key);
        if (col !== -1) sheet.getRange(r + 1, col + 1).setValue(fields[key]);
      }
      writeAuditEntry(id, fromStatus, toStatus, by, note || '');
      return true;
    }
  }
  return false;
}

function handleApprove_(p) {
  if (!p.id || !p.by) return jsonOut_({ ok: false, error: 'Missing id or by' });
  var req = getRequestById(p.id);
  if (!req) return jsonOut_({ ok: false, error: 'Request not found' });
  if (!canTransition_(req.status, ST.APPROVED)) {
    return jsonOut_({ ok: false, error: 'Cannot approve from status "' + req.status + '"' });
  }
  if (!canApprove_(p.by, req.estimated_cost, req.urgency)) {
    return jsonOut_({ ok: false, error: 'Not authorized for this status' });
  }
  updateRequest_(p.id,
    { status: ST.APPROVED, approved_by: p.by, approved_at: new Date().toISOString() },
    req.status, ST.APPROVED, p.by, p.note || '');
  rebuildDigest();
  return jsonOut_({ ok: true });
}

function handleReject_(p) {
  if (!p.id || !p.by) return jsonOut_({ ok: false, error: 'Missing id or by' });
  var req = getRequestById(p.id);
  if (!req) return jsonOut_({ ok: false, error: 'Request not found' });
  if (!canTransition_(req.status, ST.NOT_APPROVED)) {
    return jsonOut_({ ok: false, error: 'Cannot reject from status "' + req.status + '"' });
  }
  if (!canApprove_(p.by, req.estimated_cost, req.urgency)) {
    return jsonOut_({ ok: false, error: 'Not authorized for this status' });
  }
  updateRequest_(p.id,
    { status: ST.NOT_APPROVED, rejection_reason: p.reason || '' },
    req.status, ST.NOT_APPROVED, p.by, p.reason || '');
  rebuildDigest();
  return jsonOut_({ ok: true });
}

function handleDefer_(p) {
  if (!p.id || !p.by || !p.deferred_until) {
    return jsonOut_({ ok: false, error: 'Missing id, by, or deferred_until' });
  }
  var req = getRequestById(p.id);
  if (!req) return jsonOut_({ ok: false, error: 'Request not found' });
  if (!canTransition_(req.status, ST.DEFERRED)) {
    return jsonOut_({ ok: false, error: 'Cannot defer from status "' + req.status + '"' });
  }
  // Defer is Roy at any amount — a "this can wait" call, not financial (§6).
  updateRequest_(p.id,
    { status: ST.DEFERRED, deferred_until: p.deferred_until },
    req.status, ST.DEFERRED, p.by, 'נדחה ל-' + p.deferred_until);
  rebuildDigest();
  return jsonOut_({ ok: true });
}

function handleAssign_(p) {
  if (!p.id || !p.by || !p.assigned_to) {
    return jsonOut_({ ok: false, error: 'Missing id, by, or assigned_to' });
  }
  var req = getRequestById(p.id);
  if (!req) return jsonOut_({ ok: false, error: 'Request not found' });
  // Approved → in progress (no separate "assigned" status, §5). Assignment sets the lead.
  // Also allow RE-assigning the lead on a task already בביצוע (the "העברה לביצוע" tab lets Roy
  // change רמי/צחי/רועי on a live task) — no status change in that case.
  var reassigningInProgress = (req.status === ST.IN_PROGRESS);
  if (!reassigningInProgress && !canTransition_(req.status, ST.IN_PROGRESS)) {
    return jsonOut_({ ok: false, error: 'Can only assign an approved or in-progress request' });
  }
  var fields = { assigned_to: p.assigned_to };
  if (p.assignment_type != null) fields.assignment_type = p.assignment_type;
  if (p.trade != null) fields.trade = p.trade;
  if (!reassigningInProgress) fields.status = ST.IN_PROGRESS;
  var note = reassigningInProgress
    ? 'הועבר מחדש ל-' + p.assigned_to
    : 'הוקצה ל-' + p.assigned_to + (p.trade ? ' (' + p.trade + ')' : '');
  updateRequest_(p.id, fields, req.status, fields.status || req.status, p.by, note);
  rebuildDigest();
  return jsonOut_({ ok: true });
}

// Valid external trades (mirror of src/schema.js TRADES).
var VALID_TRADES_ = ['חשמלאי', 'אינסטלטור', 'איש מזגנים', 'צבעי', 'איש בריכות', 'איש רשתות', 'עבודות אלומיניום', 'עבודות נגרות', 'אחר'];

/**
 * Mark an APPROVED request as external work needing a given trade, WITHOUT assigning it yet.
 * This is what makes a request eligible for smart batching (trade × cluster). Status stays מאושר.
 */
function handleMarkExternal_(p) {
  if (!p.id || !p.by || !p.trade) return jsonOut_({ ok: false, error: 'Missing id, by, or trade' });
  if (VALID_TRADES_.indexOf(p.trade) === -1) return jsonOut_({ ok: false, error: 'Invalid trade' });
  var req = getRequestById(p.id);
  if (!req) return jsonOut_({ ok: false, error: 'Request not found' });
  if (req.status !== ST.APPROVED) return jsonOut_({ ok: false, error: 'ניתן לסמן רק דרישה מאושרת' });
  updateRequest_(p.id,
    { assignment_type: 'external', trade: p.trade },
    req.status, req.status, p.by, 'סומן כעבודה חיצונית: ' + p.trade);
  rebuildDigest();
  return jsonOut_({ ok: true });
}

/**
 * Assign a whole batch in one visit: every listed approved-external request gets the same batch_id
 * and moves to בביצוע together. ids must share trade × cluster (the UI builds these groups).
 */
function handleAssignBatch_(p) {
  if (!p.ids || !p.ids.length || !p.by) return jsonOut_({ ok: false, error: 'Missing ids or by' });
  var batchId = p.batch_id || ('BATCH-' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14));
  var assignedTo = p.assigned_to || (p.trade || 'טכנאי חיצוני');
  var done = [];
  for (var i = 0; i < p.ids.length; i++) {
    var id = p.ids[i];
    var req = getRequestById(id);
    if (!req || !canTransition_(req.status, ST.IN_PROGRESS)) continue;
    updateRequest_(id,
      { status: ST.IN_PROGRESS, assignment_type: 'external', assigned_to: assignedTo, trade: p.trade || req.trade || '', batch_id: batchId },
      req.status, ST.IN_PROGRESS, p.by, 'הוקצה בביקור מרוכז ' + batchId);
    done.push(id);
  }
  rebuildDigest();
  return jsonOut_({ ok: true, batch_id: batchId, assigned: done });
}

function handleSetStatus_(p) {
  if (!p.id || !p.by || !p.to) return jsonOut_({ ok: false, error: 'Missing id, by, or to' });
  var req = getRequestById(p.id);
  if (!req) return jsonOut_({ ok: false, error: 'Request not found' });
  if (!canTransition_(req.status, p.to)) {
    return jsonOut_({ ok: false, error: 'Illegal transition ' + req.status + ' → ' + p.to });
  }
  var fields = { status: p.to };
  if (p.to === ST.COMPLETED) {
    fields.completed_at = new Date().toISOString();
    if (p.actual_cost != null) fields.actual_cost = p.actual_cost;
    if (p.completion_notes) fields.completion_notes = p.completion_notes;
  }
  updateRequest_(p.id, fields, req.status, p.to, p.by, p.note || '');
  rebuildDigest();
  return jsonOut_({ ok: true });
}

// Execution status set from the /workorders "סטטוס ביצוע" tab. Values: בוצע / לא בוצע / אחר.
// A task stays LIVE until marked בוצע. לא בוצע and אחר are recorded but keep the task open.
// בוצע additionally completes the request (בביצוע → הושלם) so it leaves every worklist.
var VALID_EXECUTION_ = ['בוצע', 'לא בוצע', 'אחר'];

function handleSetExecution_(p) {
  if (!p.id || !p.by || p.value == null) return jsonOut_({ ok: false, error: 'Missing id, by, or value' });
  if (VALID_EXECUTION_.indexOf(p.value) === -1) return jsonOut_({ ok: false, error: 'Invalid execution value' });
  var req = getRequestById(p.id);
  if (!req) return jsonOut_({ ok: false, error: 'Request not found' });

  if (p.value === 'בוצע') {
    // Mark done → complete the request too. Requires it be בביצוע (the only state that → הושלם).
    if (!canTransition_(req.status, ST.COMPLETED)) {
      return jsonOut_({ ok: false, error: 'ניתן לסמן בוצע רק למשימה בביצוע' });
    }
    updateRequest_(p.id,
      { execution_status: 'בוצע', status: ST.COMPLETED, completed_at: new Date().toISOString() },
      req.status, ST.COMPLETED, p.by, 'סומן כבוצע');
    rebuildDigest();
    return jsonOut_({ ok: true, completed: true });
  }

  // לא בוצע / אחר → record only; status unchanged, task stays live.
  updateRequest_(p.id,
    { execution_status: p.value },
    req.status, req.status, p.by, 'סטטוס ביצוע: ' + p.value);
  rebuildDigest();
  return jsonOut_({ ok: true, completed: false });
}

// ===== Inspections module (increment 4, §13) =====
// Mirrors src/inspection.js. Findings of type physical_defect can be confirmed into requests
// that flow through the SAME approval pipeline (handleCreateRequest_ / approval engine).

var INSPECTION_USERS_ = ['רועי', 'אולגה', 'אורן', 'sandra'];
var DOMAINS_ = ['treatment', 'cleanliness', 'kitchen'];
var FINDING_TYPES_ = ['process_note', 'physical_defect'];

function genId_(prefix) {
  var stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return prefix + '-' + stamp + '-' + String(Math.floor(Math.random() * 1e4)).padStart(4, '0');
}

function appendRow_(sheetName, obj) {
  var sheet = getSheet_(sheetName);
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var row = headers.map(function (h) {
    return Object.prototype.hasOwnProperty.call(obj, h) && obj[h] != null ? obj[h] : '';
  });
  sheet.appendRow(row);
}

function handleCreateInspection_(p) {
  if (!p.house) return jsonOut_({ ok: false, error: 'Missing house' });
  if (INSPECTION_USERS_.indexOf(p.inspector) === -1) return jsonOut_({ ok: false, error: 'Invalid inspector' });
  if (!p.inspection_date) return jsonOut_({ ok: false, error: 'Missing inspection_date' });
  var id = genId_('INS');
  appendRow_('Inspections', {
    id: id, house: p.house, inspection_date: p.inspection_date, inspector: p.inspector,
    started_at: new Date().toISOString(),
    patient_count: p.patient_count || '', staff_present: p.staff_present || '',
    start_time: p.start_time || '', cleaner_present: p.cleaner_present || '',
    domain_treatment_summary: p.domain_treatment_summary || '',
    domain_cleanliness_summary: p.domain_cleanliness_summary || '',
    domain_kitchen_summary: p.domain_kitchen_summary || '',
    general_notes: p.general_notes || '', reinspect_date: p.reinspect_date || '', status: 'in-progress',
  });
  rebuildDigest();
  return jsonOut_({ ok: true, id: id });
}

function handleAddFinding_(p) {
  if (!p.inspection_id) return jsonOut_({ ok: false, error: 'Missing inspection_id' });
  if (DOMAINS_.indexOf(p.domain) === -1) return jsonOut_({ ok: false, error: 'Invalid domain' });
  if (!p.finding_text) return jsonOut_({ ok: false, error: 'Missing finding_text' });
  if (FINDING_TYPES_.indexOf(p.finding_type) === -1) return jsonOut_({ ok: false, error: 'Invalid finding_type' });
  if (p.finding_type === 'physical_defect' && p.suggested_category &&
      ['תיקון', 'החלפה'].indexOf(p.suggested_category) === -1) {
    return jsonOut_({ ok: false, error: 'suggested_category must be תיקון or החלפה' });
  }
  var id = genId_('FND');
  appendRow_('InspectionFindings', {
    id: id, inspection_id: p.inspection_id, domain: p.domain,
    location_in_house: p.location_in_house || '', finding_text: p.finding_text,
    finding_type: p.finding_type, severity: p.severity || '',
    suggested_category: p.suggested_category || '',
    linked_request_id: '', confirmed_by: '', confirmed_at: '',
  });
  rebuildDigest();
  return jsonOut_({ ok: true, id: id });
}

/** Roy confirms a physical-defect finding → creates a request via the SAME pipeline, links both. */
function handleConfirmFinding_(p) {
  if (!p.finding_id || !p.by) return jsonOut_({ ok: false, error: 'Missing finding_id or by' });
  var findings = readObjects_('InspectionFindings');
  var finding = null;
  for (var i = 0; i < findings.length; i++) {
    if (String(findings[i].id) === String(p.finding_id)) { finding = findings[i]; break; }
  }
  if (!finding) return jsonOut_({ ok: false, error: 'Finding not found' });
  if (finding.finding_type !== 'physical_defect') return jsonOut_({ ok: false, error: 'Only a physical defect can become a request' });
  if (finding.linked_request_id) return jsonOut_({ ok: false, error: 'Finding already linked to a request' });

  // Parent inspection (for house).
  var inspections = readObjects_('Inspections');
  var insp = null;
  for (var j = 0; j < inspections.length; j++) {
    if (String(inspections[j].id) === String(finding.inspection_id)) { insp = inspections[j]; break; }
  }
  if (!insp) return jsonOut_({ ok: false, error: 'Parent inspection not found' });

  // Build the request via the SAME path as a normal submission (cost blank → routes to Roy).
  var row = buildNewRequest_({
    created_by: p.by, house: insp.house,
    category: finding.suggested_category || 'תיקון',
    description: finding.finding_text, location_in_house: finding.location_in_house || '',
    urgency: 'רגיל', estimated_cost: '',
  });
  row.approval_required = approvalRequired_(row.estimated_cost, row.urgency);
  appendRequest(row);
  writeAuditEntry(row.id, '', row.status, p.by, 'נוצר מבקרה (finding ' + finding.id + ')');

  // Link the finding back to the request.
  updateFinding_(finding.id, { linked_request_id: row.id, confirmed_by: p.by, confirmed_at: new Date().toISOString() });
  rebuildDigest();
  return jsonOut_({ ok: true, request_id: row.id });
}

function updateFinding_(id, fields) {
  var sheet = getSheet_('InspectionFindings');
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][headers.indexOf('id')]) === String(id)) {
      for (var key in fields) {
        var col = headers.indexOf(key);
        if (col !== -1) sheet.getRange(r + 1, col + 1).setValue(fields[key]);
      }
      return true;
    }
  }
  return false;
}

// ===== Delete + edit requests (increment 5) =====
// Delete: Roy or Sandra, one quick action, audit-logged before removal. Hard delete (row removed).
// Edit: only BEFORE approval (דרישה / ממתין לאישור) so the §6 routing can't be bypassed by
// editing cost after approval. Editable fields are recomputed for approval_required.

var DELETERS_ = ['רועי', 'sandra'];
var EDITABLE_STATUSES_ = ['דרישה', 'ממתין לאישור'];
var EDITABLE_FIELDS_ = ['description', 'location_in_house', 'category', 'urgency', 'estimated_cost', 'house'];

function handleDeleteRequest_(p) {
  if (!p.id || !p.by) return jsonOut_({ ok: false, error: 'Missing id or by' });
  if (DELETERS_.indexOf(p.by) === -1) return jsonOut_({ ok: false, error: 'Not authorized to delete' });
  var sheet = getSheet_('Requests');
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var idCol = headers.indexOf('id');
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][idCol]) === String(p.id)) {
      // Audit the deletion BEFORE removing the row (keeps a record of what was deleted).
      writeAuditEntry(p.id, data[r][headers.indexOf('status')], 'נמחק', p.by, p.note || 'נמחק ע"י ' + p.by);
      sheet.deleteRow(r + 1);
      rebuildDigest();
      return jsonOut_({ ok: true });
    }
  }
  return jsonOut_({ ok: false, error: 'Request not found' });
}

function handleEditRequest_(p) {
  if (!p.id || !p.by) return jsonOut_({ ok: false, error: 'Missing id or by' });
  var req = getRequestById(p.id);
  if (!req) return jsonOut_({ ok: false, error: 'Request not found' });
  if (EDITABLE_STATUSES_.indexOf(req.status) === -1) {
    return jsonOut_({ ok: false, error: 'ניתן לערוך רק לפני אישור (status: ' + req.status + ')' });
  }
  var fields = {};
  for (var i = 0; i < EDITABLE_FIELDS_.length; i++) {
    var f = EDITABLE_FIELDS_[i];
    if (Object.prototype.hasOwnProperty.call(p, f)) fields[f] = p[f];
  }
  // Validate the merged result against the controlled vocabularies.
  var merged = {
    house: fields.house != null ? fields.house : req.house,
    category: fields.category != null ? fields.category : req.category,
    urgency: fields.urgency != null ? fields.urgency : req.urgency,
    created_by: req.created_by,
    estimated_cost: fields.estimated_cost != null ? fields.estimated_cost : req.estimated_cost,
  };
  var err = validateNewRequest_(merged);
  if (err) return jsonOut_({ ok: false, error: err });
  // Recompute approval_required from the (possibly new) cost/urgency.
  fields.approval_required = approvalRequired_(merged.estimated_cost, merged.urgency);
  updateRequest_(p.id, fields, req.status, req.status, p.by, 'נערך ע"י ' + p.by);
  rebuildDigest();
  return jsonOut_({ ok: true });
}

// ===== Inventory module (increments 25–26) — WEEKLY stock count per house (מלאי) =====
// Mirrors src/inventory.js validation. One InventoryCounts row PER ITEM, sharing a count_id.
// Re-submitting the same house+week appends a NEW count (no destructive edits — the sheet keeps
// full history); the frontend shows the latest counted_at per house+week.
//
// Increment 26: counts are WEEKLY. Each row carries week_start (YYYY-MM-DD Sunday) and source
// ('coordinator' / 'kitchen'), both APPENDED at the end of the header (setValues maps by header
// name, so appended columns just fill in). month is still written (derived from week_start) so
// nothing that still reads it breaks. Two write paths:
//   - submitInventory (coordinator): STAFF_WRITE_TOKEN gated, source='coordinator', all categories.
//   - submitKitchenCount (kitchen): KITCHEN_COUNT_SECRET gated, source='kitchen', מזון ONLY.

var INVENTORY_CATEGORIES_ = ['טואלטיקה', 'חומרי ניקוי', 'מזון'];
// Coordinators (increment 26), + רמי/צחי/רועי accepted as a backstop. Mirror of INVENTORY_COUNTERS.
var INVENTORY_COUNTERS_ = ['שירה', 'יעקב', 'אורן', 'אביב', 'צחי', 'רועי', 'רמי'];
var KITCHEN_CATEGORY_ = 'מזון';

function isValidMonth_(m) {
  return typeof m === 'string' && /^20[2-9][0-9]-(0[1-9]|1[0-2])$/.test(m);
}

// Sunday-based Israeli week-start, computed in UTC (mirror of weekStart in src/inventory.js).
function weekStart_(date) {
  var d = date instanceof Date ? new Date(date.getTime()) : new Date(date);
  if (isNaN(d.getTime())) return '';
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}

// A YYYY-MM-DD that is BOTH well-formed AND a Sunday (mirror of isValidWeekStart).
function isValidWeekStart_(w) {
  if (typeof w !== 'string') return false;
  if (!/^20[2-9][0-9]-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/.test(w)) return false;
  return weekStart_(w) === w;
}

// The YYYY-MM month a valid week_start falls in — for the derived `month` column.
function monthFromWeekStart_(w) {
  return isValidWeekStart_(w) ? w.slice(0, 7) : '';
}

/**
 * Write validated count rows in ONE batched setValues + a single AuditLog entry. Shared by both
 * write paths. `filled` = [{category,item,quantity,notes}]; `source` = 'coordinator'/'kitchen'.
 */
function writeInventoryRows_(house, weekStartStr, countedBy, source, filled, auditAction, auditNote) {
  var countId = genId_('INV');
  var countedAt = new Date().toISOString();
  var month = monthFromWeekStart_(weekStartStr);
  var sheet = getSheet_('InventoryCounts');
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var rows = filled.map(function (it) {
    var obj = {
      count_id: countId, house: house, month: month,
      counted_by: countedBy, counted_at: countedAt,
      category: it.category, item: it.item, quantity: it.quantity, notes: it.notes,
      week_start: weekStartStr, source: source,
    };
    return headers.map(function (h) {
      return Object.prototype.hasOwnProperty.call(obj, h) && obj[h] != null ? obj[h] : '';
    });
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
  writeAuditEntry(countId, '', auditAction, countedBy, auditNote);
  rebuildDigest();
  return { count_id: countId, items: filled.length };
}

function handleSubmitInventory_(p) {
  // -- validation (mirror of validateInventorySubmission in src/inventory.js) --
  if (!p || typeof p !== 'object') return jsonOut_({ ok: false, error: 'Missing payload' });
  if (!p.house) return jsonOut_({ ok: false, error: 'Missing house' });
  if (!isValidWeekStart_(p.week_start)) return jsonOut_({ ok: false, error: 'week_start must be a Sunday (YYYY-MM-DD)' });
  if (INVENTORY_COUNTERS_.indexOf(p.counted_by) === -1) return jsonOut_({ ok: false, error: 'Invalid counted_by' });
  if (!p.items || !p.items.length) return jsonOut_({ ok: false, error: 'Missing items' });

  var filled = [];
  for (var i = 0; i < p.items.length; i++) {
    var it = p.items[i];
    if (!it || !it.item) return jsonOut_({ ok: false, error: 'Item missing name' });
    if (INVENTORY_CATEGORIES_.indexOf(it.category) === -1) {
      return jsonOut_({ ok: false, error: 'Invalid category: ' + it.category });
    }
    var blank = (it.quantity === '' || it.quantity === null || it.quantity === undefined);
    if (blank) continue;                                    // unfilled row → skipped
    var n = Number(it.quantity);
    if (isNaN(n) || !isFinite(n) || n < 0) {
      return jsonOut_({ ok: false, error: 'quantity must be a number ≥ 0 (' + it.item + ')' });
    }
    filled.push({ category: it.category, item: it.item, quantity: n, notes: String(it.notes || '').slice(0, 500) });
  }
  if (filled.length === 0) return jsonOut_({ ok: false, error: 'No quantities filled' });

  var res = writeInventoryRows_(
    p.house, p.week_start, p.counted_by, 'coordinator', filled, 'ספירת מלאי',
    'ספירה שבועית ' + p.week_start + ' — ' + p.house + ' (' + filled.length + ' פריטים)');
  return jsonOut_({ ok: true, count_id: res.count_id, items: res.items });
}

/**
 * Kitchen ingest (increment 26). Gated by KITCHEN_COUNT_SECRET (see doPost). HARD CONSTRAINTS:
 *  - category is FORCED to מזון; any request carrying another category is rejected. The kitchen
 *    can never write טואלטיקה or חומרי ניקוי.
 *  - every item is validated against the ACTIVE מזון catalog; unknown items are rejected, not
 *    silently created.
 * Mirror of validateKitchenCount in src/inventory.js. Payload:
 *   { house, weekStart (YYYY-MM-DD Sunday), countedBy (<=60), items:[{item,quantity,notes}] }.
 */
function handleSubmitKitchenCount_(p) {
  if (!p || typeof p !== 'object') return jsonOut_({ ok: false, error: 'Missing payload' });
  if (!p.house) return jsonOut_({ ok: false, error: 'Missing house' });
  // House must be a real, known house.
  var houses = getHouses();
  var known = false;
  for (var h = 0; h < houses.length; h++) {
    if (String(houses[h].name) === String(p.house)) { known = true; break; }
  }
  if (!known) return jsonOut_({ ok: false, error: 'Unknown house: ' + p.house });
  if (!isValidWeekStart_(p.weekStart)) return jsonOut_({ ok: false, error: 'weekStart must be a Sunday (YYYY-MM-DD)' });
  if (typeof p.countedBy !== 'string' || p.countedBy.trim() === '') return jsonOut_({ ok: false, error: 'Missing countedBy' });
  if (p.countedBy.length > 60) return jsonOut_({ ok: false, error: 'countedBy must be <= 60 chars' });
  // Reject any payload-level category that is not מזון.
  if (p.category != null && String(p.category) !== KITCHEN_CATEGORY_) {
    return jsonOut_({ ok: false, error: 'Kitchen may only write ' + KITCHEN_CATEGORY_ });
  }
  if (!p.items || !p.items.length) return jsonOut_({ ok: false, error: 'Missing items' });

  // Build the allowed set from the ACTIVE מזון catalog.
  var catalog = readObjects_('InventoryItems');
  var allowed = {};
  for (var c = 0; c < catalog.length; c++) {
    var row = catalog[c];
    if (!row || !row.item_text) continue;
    if (String(row.active).toUpperCase() === 'FALSE') continue;
    if (row.category !== KITCHEN_CATEGORY_) continue;
    allowed[String(row.item_text)] = true;
  }

  var filled = [];
  for (var i = 0; i < p.items.length; i++) {
    var it = p.items[i];
    if (!it || !it.item) return jsonOut_({ ok: false, error: 'Item missing name' });
    // Per-item category guard — locked to מזון at the item level too.
    if (it.category != null && String(it.category) !== KITCHEN_CATEGORY_) {
      return jsonOut_({ ok: false, error: 'Kitchen may only write ' + KITCHEN_CATEGORY_ });
    }
    if (!allowed[String(it.item)]) return jsonOut_({ ok: false, error: 'Unknown item: ' + it.item });
    if (it.notes != null && String(it.notes).length > 200) {
      return jsonOut_({ ok: false, error: 'notes must be <= 200 chars (' + it.item + ')' });
    }
    var blank = (it.quantity === '' || it.quantity === null || it.quantity === undefined);
    if (blank) continue;
    var n = Number(it.quantity);
    if (isNaN(n) || !isFinite(n) || n < 0) {
      return jsonOut_({ ok: false, error: 'quantity must be a number ≥ 0 (' + it.item + ')' });
    }
    // category is FORCED to מזון regardless of what (if anything) the payload claimed.
    filled.push({ category: KITCHEN_CATEGORY_, item: String(it.item), quantity: n, notes: String(it.notes || '').slice(0, 200) });
  }
  if (filled.length === 0) return jsonOut_({ ok: false, error: 'No quantities filled' });

  var res = writeInventoryRows_(
    p.house, p.weekStart, p.countedBy, 'kitchen', filled, 'ספירת מטבח',
    'ספירת מטבח ' + p.weekStart + ' — ' + p.house + ' (' + filled.length + ' פריטים)');
  return jsonOut_({ ok: true, count_id: res.count_id, items: res.items });
}
