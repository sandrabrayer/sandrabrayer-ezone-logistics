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
    case 'checklist':   result = readObjects_('ChecklistItems'); break;
    case 'inspections': result = readObjects_('Inspections'); break;
    case 'findings':    result = readObjects_('InspectionFindings'); break;
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

  // Whitelisted actions only.
  switch (body.action) {
    case 'createRequest': return handleCreateRequest_(body.payload || {});
    case 'approve':       return handleApprove_(body.payload || {});
    case 'reject':        return handleReject_(body.payload || {});
    case 'defer':         return handleDefer_(body.payload || {});
    case 'assign':        return handleAssign_(body.payload || {});
    case 'setStatus':     return handleSetStatus_(body.payload || {});
    case 'createInspection': return handleCreateInspection_(body.payload || {});
    case 'addFinding':       return handleAddFinding_(body.payload || {});
    case 'confirmFinding':   return handleConfirmFinding_(body.payload || {});
    case 'deleteRequest':    return handleDeleteRequest_(body.payload || {});
    case 'editRequest':      return handleEditRequest_(body.payload || {});
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
  if (urgency === 'חירום') return 'auto';
  if (costIsBlank_(cost)) return 'roy';
  var t = Number(getConfig('approval_threshold'));
  return Number(cost) > t ? 'sandra' : 'roy';
}

function canApprove_(approver, cost, urgency) {
  var who = whoApproves_(cost, urgency);
  if (who === 'auto') return true;
  if (who === 'sandra') return approver === APPROVER_SANDRA;
  return approver === APPROVER_ROY || approver === APPROVER_SANDRA;
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
    return jsonOut_({ ok: false, error: 'Not authorized for this amount (above threshold requires Sandra)' });
  }
  updateRequest_(p.id,
    { status: ST.APPROVED, approved_by: p.by, approved_at: new Date().toISOString() },
    req.status, ST.APPROVED, p.by, p.note || '');
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
    return jsonOut_({ ok: false, error: 'Not authorized for this amount' });
  }
  updateRequest_(p.id,
    { status: ST.NOT_APPROVED, rejection_reason: p.reason || '' },
    req.status, ST.NOT_APPROVED, p.by, p.reason || '');
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
  return jsonOut_({ ok: true });
}

function handleAssign_(p) {
  if (!p.id || !p.by || !p.assigned_to) {
    return jsonOut_({ ok: false, error: 'Missing id, by, or assigned_to' });
  }
  var req = getRequestById(p.id);
  if (!req) return jsonOut_({ ok: false, error: 'Request not found' });
  // Approved → in progress (no separate "assigned" status, §5). Assignment sets the lead.
  if (!canTransition_(req.status, ST.IN_PROGRESS)) {
    return jsonOut_({ ok: false, error: 'Can only assign an approved request' });
  }
  updateRequest_(p.id,
    { status: ST.IN_PROGRESS, assigned_to: p.assigned_to, assignment_type: p.assignment_type || '' },
    req.status, ST.IN_PROGRESS, p.by, 'הוקצה ל-' + p.assigned_to);
  return jsonOut_({ ok: true });
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
  return jsonOut_({ ok: true });
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
  return jsonOut_({ ok: true });
}
