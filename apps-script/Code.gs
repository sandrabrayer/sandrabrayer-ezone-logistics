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
function getUsers() { return readObjects_('Users'); }

/** Active users only, trimmed to the fields the UI needs (name/role/house). */
function getActiveUsers_() {
  return getUsers()
    .filter(function (u) { return isActive_(u.active); })
    .map(function (u) { return { name: u.name, role: u.role, house: u.house }; });
}

/** Fast name → house row map, for cluster-scope resolution. */
function housesByName_() {
  var map = {};
  getHouses().forEach(function (h) { map[String(h.name)] = h; });
  return map;
}

function houseIsPreOpening_(house) {
  var map = housesByName_();
  var h = map[String(house)];
  return !!h && String(h.status) === 'pre-opening'; // pre-opening = טרום-פתיחה
}

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
    case 'users':       result = getActiveUsers_(); break;
    default:
      return jsonOut_({ ok: false, error: 'Unknown or missing action' });
  }
  return jsonOut_({ ok: true, data: result });
}

// Controlled vocabularies (mirror of src/schema.js + src/request.js).
var VALID_CATEGORIES = ['רכישה', 'תיקון', 'החלפה'];
var VALID_URGENCIES = ['רגיל', 'דחוף', 'חירום'];
// created_by is no longer a hardcoded roster: any ACTIVE user may create (Users sheet),
// coordinators own-house only — enforced in handleCreateRequest_ via authorizeAction_.
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
    case 'inventoryCount': return handleInventoryCount_(body.payload || {});
    default:
      return jsonOut_({ ok: false, error: 'Unknown or unsupported action' });
  }
}

function handleCreateRequest_(input) {
  var validationError = validateNewRequest_(input);
  if (validationError) return jsonOut_({ ok: false, error: validationError });
  // Identity + role gate (increment 28): created_by must be an ACTIVE user; a coordinator may
  // only create for their own house. Fail-closed on unknown/inactive.
  var user = findUser_(input.created_by);
  var authErr = authorizeAction_(user, 'create', { house: input.house });
  if (authErr) return jsonOut_({ ok: false, error: authErr });

  // Server owns id, status, created_at — the client never supplies them.
  var row = buildNewRequest_(input);
  // Stamp the derived approval_required flag through the §6 chain.
  row.approval_required = approvalRequired_(row.estimated_cost, row.urgency, houseIsPreOpening_(row.house));
  appendRequest(row);
  return jsonOut_({ ok: true, id: row.id });
}

/** Validate raw form input. estimated_cost BLANK is valid (unknown cost is a real case). */
function validateNewRequest_(p) {
  if (!p || typeof p !== 'object') return 'Missing payload';
  if (!p.house) return 'Missing house';
  if (VALID_CATEGORIES.indexOf(p.category) === -1) return 'Invalid or missing category';
  if (VALID_URGENCIES.indexOf(p.urgency) === -1) return 'Invalid or missing urgency';
  if (!p.created_by) return 'Invalid or missing created_by'; // roster check is role-based below
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
// ---- Roles + approval chain (mirror of src/schema.js ROLES + src/approval.js) ----
var ROLE = {
  COORDINATOR: 'coordinator', MAINTENANCE: 'maintenance', FIELD_OPS: 'field_ops',
  OPS_MANAGER: 'ops_manager', CEO: 'ceo',
};
var ALL_ROLES_ = ['coordinator', 'maintenance', 'field_ops', 'ops_manager', 'ceo'];
var ALL_HOUSES_MARK_ = '*';
var CLUSTER_SCOPE_PREFIX_ = 'cluster:';

function costIsBlank_(c) { return c === '' || c === null || c === undefined; }
function ceilingSet_(v) { return !(v === '' || v === null || v === undefined); }

/**
 * §6 chain (a–d), evaluated in order. Returns 'auto' | 'ceo' | 'ops_manager' | 'field_ops'.
 * housePreOpening is passed in by the caller (computed from the Houses sheet status).
 */
function resolveApprover_(cost, urgency, housePreOpening) {
  if (urgency === 'חירום') return 'auto';                    // a. emergency bypass
  if (housePreOpening) return ROLE.CEO;                      // b. pre-opening house → CEO
  var ceiling = getConfig('ceo_ceiling');
  if (ceilingSet_(ceiling) && !costIsBlank_(cost) && Number(cost) > Number(ceiling)) {
    return ROLE.CEO;                                         // b. over CEO ceiling → CEO
  }
  var t = Number(getConfig('approval_threshold'));
  if (!costIsBlank_(cost) && Number(cost) > t) return ROLE.OPS_MANAGER; // c. over threshold
  return ROLE.FIELD_OPS;                                     // d. otherwise (incl. blank cost)
}

function approvalRequired_(cost, urgency, housePreOpening) {
  var who = resolveApprover_(cost, urgency, housePreOpening);
  return who === ROLE.OPS_MANAGER || who === ROLE.CEO;
}

function canApprove_(role, resolvedApprover) {
  if (role === ROLE.CEO) return true;
  if (resolvedApprover === 'auto') return true;
  return role === resolvedApprover;
}

// ---- User identity + authorization matrix (mirror of src/roles.js) ----
var TRUE_STRINGS_ROLE_ = ['true', 'TRUE', 'True', '1', 'yes', 'YES'];

function isActive_(a) {
  if (a === true) return true;
  return TRUE_STRINGS_ROLE_.indexOf(String(a).trim()) !== -1;
}

function findUser_(name) {
  if (name == null || name === '') return null;
  var users = getUsers();
  for (var i = 0; i < users.length; i++) {
    if (String(users[i].name) === String(name)) return users[i];
  }
  return null;
}

function userCoversHouse_(user, house, byName) {
  if (!user) return false;
  var scope = user.house;
  if (scope === ALL_HOUSES_MARK_) return true;
  if (typeof scope === 'string' && scope.indexOf(CLUSTER_SCOPE_PREFIX_) === 0) {
    var clusters = scope.slice(CLUSTER_SCOPE_PREFIX_.length).split('+');
    var h = byName && byName[String(house)];
    return !!h && clusters.indexOf(h.cluster) !== -1;
  }
  return String(scope) === String(house);
}

/**
 * Authorize a write action. Returns null when allowed, else a Hebrew error string. Fail-closed:
 * unknown/inactive/unrecognized-role → nothing allowed. ctx: { house, byName, resolvedApprover }.
 */
function authorizeAction_(user, action, ctx) {
  ctx = ctx || {};
  if (!user) return 'משתמש לא מוכר';
  if (!isActive_(user.active)) return 'משתמש אינו פעיל';
  if (ALL_ROLES_.indexOf(user.role) === -1) return 'תפקיד לא מוכר';

  var coordinatorOffHouse =
    user.role === ROLE.COORDINATOR && !userCoversHouse_(user, ctx.house, ctx.byName);

  if (action === 'create') {
    if (coordinatorOffHouse) return 'רכז/ת מוגבל/ת לבית שלו/ה';
    return null;
  }
  if (action === 'approve' || action === 'reject') {
    if (user.role === ROLE.CEO) return null;
    if (ctx.resolvedApprover === 'auto') return null;
    if (user.role !== ctx.resolvedApprover) return 'התפקיד אינו המאשר הנדרש לבקשה זו';
    return null;
  }
  if (action === 'defer' || action === 'assign') {
    if ([ROLE.FIELD_OPS, ROLE.OPS_MANAGER, ROLE.CEO].indexOf(user.role) === -1) {
      return 'התפקיד אינו מורשה לפעולה זו';
    }
    return null;
  }
  if (action === 'inventory') {
    if ([ROLE.COORDINATOR, ROLE.MAINTENANCE, ROLE.FIELD_OPS, ROLE.OPS_MANAGER, ROLE.CEO]
        .indexOf(user.role) === -1) {
      return 'התפקיד אינו מורשה להגשת ספירה';
    }
    if (coordinatorOffHouse) return 'רכז/ת מוגבל/ת לבית שלו/ה';
    return null;
  }
  return 'פעולה לא מוכרת';
}

/** Every AuditLog note carries the acting user's role (increment 28). */
function noteWithRole_(role, base) {
  var tag = 'תפקיד: ' + role;
  return base ? base + ' · ' + tag : tag;
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
  var user = findUser_(p.by);
  var who = resolveApprover_(req.estimated_cost, req.urgency, houseIsPreOpening_(req.house));
  var authErr = authorizeAction_(user, 'approve', { resolvedApprover: who });
  if (authErr) return jsonOut_({ ok: false, error: authErr });
  var base = who === 'auto' ? 'עקיפת חירום (אישור אוטומטי)' : (p.note || ''); // emergency bypass
  updateRequest_(p.id,
    { status: ST.APPROVED, approved_by: p.by, approved_at: new Date().toISOString() },
    req.status, ST.APPROVED, p.by, noteWithRole_(user.role, base));
  return jsonOut_({ ok: true });
}

function handleReject_(p) {
  if (!p.id || !p.by) return jsonOut_({ ok: false, error: 'Missing id or by' });
  var req = getRequestById(p.id);
  if (!req) return jsonOut_({ ok: false, error: 'Request not found' });
  if (!canTransition_(req.status, ST.NOT_APPROVED)) {
    return jsonOut_({ ok: false, error: 'Cannot reject from status "' + req.status + '"' });
  }
  var user = findUser_(p.by);
  var who = resolveApprover_(req.estimated_cost, req.urgency, houseIsPreOpening_(req.house));
  var authErr = authorizeAction_(user, 'reject', { resolvedApprover: who });
  if (authErr) return jsonOut_({ ok: false, error: authErr });
  updateRequest_(p.id,
    { status: ST.NOT_APPROVED, rejection_reason: p.reason || '' },
    req.status, ST.NOT_APPROVED, p.by, noteWithRole_(user.role, p.reason || ''));
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
  var user = findUser_(p.by);
  var authErr = authorizeAction_(user, 'defer', {});
  if (authErr) return jsonOut_({ ok: false, error: authErr });
  // Defer is a "this can wait" call at any amount (§6); on wake-up the amount is re-checked a–d.
  updateRequest_(p.id,
    { status: ST.DEFERRED, deferred_until: p.deferred_until },
    req.status, ST.DEFERRED, p.by, noteWithRole_(user.role, 'נדחה ל-' + p.deferred_until));
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
  var user = findUser_(p.by);
  var authErr = authorizeAction_(user, 'assign', {});
  if (authErr) return jsonOut_({ ok: false, error: authErr });
  updateRequest_(p.id,
    { status: ST.IN_PROGRESS, assigned_to: p.assigned_to, assignment_type: p.assignment_type || '' },
    req.status, ST.IN_PROGRESS, p.by, noteWithRole_(user.role, 'הוקצה ל-' + p.assigned_to));
  return jsonOut_({ ok: true });
}

function handleSetStatus_(p) {
  if (!p.id || !p.by || !p.to) return jsonOut_({ ok: false, error: 'Missing id, by, or to' });
  var req = getRequestById(p.id);
  if (!req) return jsonOut_({ ok: false, error: 'Request not found' });
  if (!canTransition_(req.status, p.to)) {
    return jsonOut_({ ok: false, error: 'Illegal transition ' + req.status + ' → ' + p.to });
  }
  var user = findUser_(p.by);
  // Completing / closing is a dispatch-tier action (field_ops+); reuse the assign gate.
  var authErr = authorizeAction_(user, 'assign', {});
  if (authErr) return jsonOut_({ ok: false, error: authErr });
  var fields = { status: p.to };
  if (p.to === ST.COMPLETED) {
    fields.completed_at = new Date().toISOString();
    if (p.actual_cost != null) fields.actual_cost = p.actual_cost;
    if (p.completion_notes) fields.completion_notes = p.completion_notes;
  }
  updateRequest_(p.id, fields, req.status, p.to, p.by, noteWithRole_(user.role, p.note || ''));
  return jsonOut_({ ok: true });
}

/**
 * Inventory count submit (increment 28 plumbing). No inventory sheet yet — this endpoint proves
 * the role gate end-to-end: coordinators may submit for their OWN house only; maintenance is a
 * backstop; field_ops/ops_manager/ceo may submit anywhere. The count is audit-logged for now.
 */
function handleInventoryCount_(p) {
  if (!p.by || !p.house) return jsonOut_({ ok: false, error: 'Missing by or house' });
  var user = findUser_(p.by);
  var authErr = authorizeAction_(user, 'inventory', { house: p.house, byName: housesByName_() });
  if (authErr) return jsonOut_({ ok: false, error: authErr });
  writeAuditEntry(p.id || '', '', 'ספירת מלאי', p.by,
    noteWithRole_(user.role, 'ספירת מלאי — ' + p.house));
  return jsonOut_({ ok: true });
}
