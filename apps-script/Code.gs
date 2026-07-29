/**
 * Code.gs — backend read/write layer for EZone Logistics.
 *
 * SECURITY / LEAST PRIVILEGE:
 *  - Container-bound to THIS app's spreadsheet only.
 *  - doPost validates and whitelists input before any write. No eval, no arbitrary sheet writes.
 *  - Identity auth (increment 30): every write carries an HMAC session token (issued by the Node
 *    /api/login endpoint). This layer VERIFIES that token INDEPENDENTLY against the SESSION_SECRET
 *    Script Property — the Node layer is never trusted — and resolves the actor (name + role) from
 *    the verified token, never from a client-supplied field. Role rules (chain B) are enforced here.
 *  - Secrets live ONLY in Script Properties (SESSION_SECRET) / Railway env — never in the repo.
 *
 * Mirrors src/schema.js (headers) and src/config.js (coercion). The chain-B routing (src/approval.js)
 * and the role predicates (src/roles.js) are mirrored VERBATIM below — see the MIRROR markers; a
 * guard test (test/mirror-drift.test.js) asserts the two copies stay logic-equivalent.
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

function getRequestById(id) {
  var all = getRequests();
  for (var i = 0; i < all.length; i++) {
    if (String(all[i].id) === String(id)) return all[i];
  }
  return null;
}

// The pre-opening / status of a house, looked up by name. '' when unknown.
function getHouseStatus_(house) {
  var houses = getHouses();
  for (var i = 0; i < houses.length; i++) {
    if (String(houses[i].name) === String(house)) return houses[i].status;
  }
  return '';
}

// ---- Writes ----

function appendRequest(obj) {
  var sheet = getSheet_('Requests');
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var row = headers.map(function (h) {
    return Object.prototype.hasOwnProperty.call(obj, h) && obj[h] != null ? obj[h] : '';
  });
  sheet.appendRow(row);
  return obj.id;
}

/** Append one audit-log entry. Every status transition calls this. */
function writeAuditEntry(requestId, fromStatus, toStatus, by, note) {
  var sheet = getSheet_('AuditLog');
  sheet.appendRow([
    requestId, fromStatus || '', toStatus || '', by || '', new Date().toISOString(), note || '',
  ]);
}

// =====================================================================================
// AUTH — HMAC session-token verification (mirror of src/auth.js token format).
// The Node /api/login endpoint issues "<payloadB64url>.<hmacSha256Hex>" over the base64url payload
// {n:name, r:role, iat, exp}, keyed by SESSION_SECRET. We verify it here INDEPENDENTLY.
// =====================================================================================

function getSessionSecret_() {
  return PropertiesService.getScriptProperties().getProperty('SESSION_SECRET') || '';
}

function hmacHex_(secret, data) {
  var raw = Utilities.computeHmacSha256Signature(data, secret);
  var hex = '';
  for (var i = 0; i < raw.length; i++) {
    var b = raw[i]; if (b < 0) b += 256;
    var h = b.toString(16); if (h.length < 2) h = '0' + h;
    hex += h;
  }
  return hex;
}

function b64urlDecode_(s) {
  var t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  var bytes = Utilities.base64Decode(t);
  return Utilities.newBlob(bytes).getDataAsString('UTF-8');
}

// Constant-time equality of two equal-length hex strings. Fail-closed on empty/length mismatch.
function constantTimeEq_(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length === 0 || a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a Bearer session token. Returns { name, role } on success, or null on any failure
 * (unset secret, malformed token, bad signature, expired). Never trusts the payload without a
 * valid signature.
 */
function verifyToken_(secret, token) {
  if (!secret || typeof token !== 'string') return null;
  var dot = token.indexOf('.');
  if (dot < 0) return null;
  var payload = token.slice(0, dot);
  var sig = token.slice(dot + 1);
  if (!/^[0-9a-f]{64}$/.test(sig)) return null;
  var expected = hmacHex_(secret, payload);
  if (!constantTimeEq_(sig, expected)) return null;
  var claims;
  try { claims = JSON.parse(b64urlDecode_(payload)); } catch (e) { return null; }
  if (!claims || typeof claims !== 'object') return null;
  if (typeof claims.exp !== 'number' || claims.exp < Date.now()) return null;
  return { name: claims.n || '', role: claims.r || '' };
}

// === MIRROR:roles START ===
var ROLE = {
  COORDINATOR: 'coordinator',
  MAINTENANCE: 'maintenance',
  FIELD_OPS: 'field_ops',
  OPS_MANAGER: 'ops_manager',
  CEO: 'ceo',
};

var ROLES = [ROLE.COORDINATOR, ROLE.MAINTENANCE, ROLE.FIELD_OPS, ROLE.OPS_MANAGER, ROLE.CEO];

function isRole(role) {
  return ROLES.indexOf(role) !== -1;
}

// approve / reject: only the role that chain B resolves to FOR THAT REQUEST. The CEO may always
// approve. requiredRole is the whoApproves() result ('field_ops' | 'ops_manager' | 'ceo').
function canApprove(actorRole, requiredRole) {
  if (actorRole === ROLE.CEO) return true;
  return actorRole === requiredRole;
}

// defer: field_ops, ops_manager, ceo (a "this can wait" call, not the money decision).
function canDefer(actorRole) {
  return actorRole === ROLE.FIELD_OPS || actorRole === ROLE.OPS_MANAGER || actorRole === ROLE.CEO;
}

// assignment / dispatch (assign, batch-assign, mark-external, set-status, set-execution):
// field_ops, ops_manager, ceo.
function canDispatch(actorRole) {
  return actorRole === ROLE.FIELD_OPS || actorRole === ROLE.OPS_MANAGER || actorRole === ROLE.CEO;
}
// === MIRROR:roles END ===

// === MIRROR:approval START ===
var URGENCY_EMERGENCY = 'חירום';
// A house in pre-opening. The Houses sheet historically stored the English 'pre-opening'; the
// increment-30 vocabulary is the Hebrew 'טרום-פתיחה'. Accept BOTH so routing is correct against
// either representation.
var HOUSE_PRE_OPENING_HE = 'טרום-פתיחה';
var HOUSE_PRE_OPENING_EN = 'pre-opening';

var APPROVER = { AUTO: 'auto', FIELD_OPS: 'field_ops', OPS_MANAGER: 'ops_manager', CEO: 'ceo' };

function costIsBlank(cost) {
  return cost === '' || cost === null || cost === undefined;
}

function isPreOpening(houseStatus) {
  return houseStatus === HOUSE_PRE_OPENING_HE || houseStatus === HOUSE_PRE_OPENING_EN;
}

// ceo_ceiling is disabled when blank/unset. Any non-blank value enables the ceiling rule.
function ceilingIsSet(ceoCeiling) {
  return !(ceoCeiling === '' || ceoCeiling === null || ceoCeiling === undefined);
}

// Which ROLE must approve this request. Returns 'auto' for the emergency bypass.
function whoApproves(cost, urgency, houseStatus, approvalThreshold, ceoCeiling) {
  if (urgency === URGENCY_EMERGENCY) return APPROVER.AUTO;
  var overCeiling = ceilingIsSet(ceoCeiling) && !costIsBlank(cost)
    && Number(cost) > Number(ceoCeiling);
  if (isPreOpening(houseStatus) || overCeiling) return APPROVER.CEO;
  if (!costIsBlank(cost) && Number(cost) > Number(approvalThreshold)) return APPROVER.OPS_MANAGER;
  return APPROVER.FIELD_OPS;
}

// Derived approval_required flag — TRUE when the request escalates above the default field_ops
// approver (i.e. routes to ops_manager or ceo). Emergency (auto) and field_ops are FALSE.
function approvalRequired(cost, urgency, houseStatus, approvalThreshold, ceoCeiling) {
  var role = whoApproves(cost, urgency, houseStatus, approvalThreshold, ceoCeiling);
  return role === APPROVER.OPS_MANAGER || role === APPROVER.CEO;
}
// === MIRROR:approval END ===

// Config accessors for the routing rules (never hardcode the values).
function approvalThreshold_() { return Number(getConfig('approval_threshold')); }
function ceoCeiling_() { return getConfig('ceo_ceiling'); } // '' / null (disabled) or a number string

// The derived approval_required for a request, resolving house status + config.
function approvalRequiredFor_(cost, urgency, house) {
  return approvalRequired(cost, urgency, getHouseStatus_(house), approvalThreshold_(), ceoCeiling_());
}

// The role that must approve a given request row.
function requiredApproverFor_(req) {
  return whoApproves(req.estimated_cost, req.urgency, getHouseStatus_(req.house),
    approvalThreshold_(), ceoCeiling_());
}

// ---- HTTP router ----

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || '';
  var result;
  switch (action) {
    case 'houses':      result = getHouses(); break;
    case 'technicians': result = getTechnicians(); break;
    case 'requests':    result = getRequests(); break;
    case 'users':       result = getUsers(); break;
    case 'config':      result = getAllConfig(); break;
    case 'checklist':   result = readObjects_('ChecklistItems'); break;
    case 'inspections': result = readObjects_('Inspections'); break;
    case 'findings':    result = readObjects_('InspectionFindings'); break;
    case 'inventoryItems':  result = readObjects_('InventoryItems'); break;
    case 'inventoryCounts': result = readObjects_('InventoryCounts'); break;
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

// Actions whose actor + role are enforced by chain B (Step 5). createRequest / edits / inspections /
// inventory only require a valid session (any authenticated user).
function doPost(e) {
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return jsonOut_({ ok: false, error: 'Invalid JSON body' });
  }

  // Fail-closed identity auth: EVERY write must carry a valid HMAC session token, verified here
  // against the SESSION_SECRET Script Property. The actor (name + role) comes from the token only.
  var actor = verifyToken_(getSessionSecret_(), (body && body.token) || '');
  if (!actor) return jsonOut_({ ok: false, error: 'Unauthorized' });

  switch (body.action) {
    case 'createRequest': return handleCreateRequest_(body.payload || {}, actor);
    case 'approve':       return handleApprove_(body.payload || {}, actor);
    case 'reject':        return handleReject_(body.payload || {}, actor);
    case 'defer':         return handleDefer_(body.payload || {}, actor);
    case 'assign':        return handleAssign_(body.payload || {}, actor);
    case 'markExternal':  return handleMarkExternal_(body.payload || {}, actor);
    case 'assignBatch':   return handleAssignBatch_(body.payload || {}, actor);
    case 'setStatus':     return handleSetStatus_(body.payload || {}, actor);
    case 'setExecution':  return handleSetExecution_(body.payload || {}, actor);
    case 'createInspection': return handleCreateInspection_(body.payload || {}, actor);
    case 'addFinding':       return handleAddFinding_(body.payload || {}, actor);
    case 'confirmFinding':   return handleConfirmFinding_(body.payload || {}, actor);
    case 'deleteRequest':    return handleDeleteRequest_(body.payload || {}, actor);
    case 'editRequest':      return handleEditRequest_(body.payload || {}, actor);
    case 'submitInventory':  return handleSubmitInventory_(body.payload || {}, actor);
    default:
      return jsonOut_({ ok: false, error: 'Unknown or unsupported action' });
  }
}

function forbidden_() { return jsonOut_({ ok: false, error: 'Forbidden: role not authorized for this action' }); }

function handleCreateRequest_(input, actor) {
  var validationError = validateNewRequest_(input);
  if (validationError) return jsonOut_({ ok: false, error: validationError });
  var row = buildNewRequest_(input);
  row.approval_required = approvalRequiredFor_(row.estimated_cost, row.urgency, row.house);
  appendRequest(row);
  rebuildDigest();
  return jsonOut_({ ok: true, id: row.id });
}

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
    attachment_url: '',
    status: STATUS_REQUEST,
    approval_required: '',
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

// ===== Approval engine + status transitions =====

var ST = {
  REQUEST: 'דרישה', PENDING: 'ממתין לאישור', APPROVED: 'מאושר',
  NOT_APPROVED: 'לא מאושר', DEFERRED: 'נדחה לתאריך', IN_PROGRESS: 'בביצוע',
  COMPLETED: 'הושלם', CLOSED: 'סגור',
};

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

// Is this actor authorized to APPROVE/REJECT this specific request? Chain B: the resolved role (or
// ceo). Emergency (auto) requires no human approver — allow any dispatch-capable actor to record it.
function actorMayApprove_(actor, req) {
  var required = requiredApproverFor_(req);
  if (required === APPROVER.AUTO) return canDispatch(actor.role);
  return canApprove(actor.role, required);
}

function handleApprove_(p, actor) {
  if (!p.id) return jsonOut_({ ok: false, error: 'Missing id' });
  var req = getRequestById(p.id);
  if (!req) return jsonOut_({ ok: false, error: 'Request not found' });
  if (!canTransition_(req.status, ST.APPROVED)) {
    return jsonOut_({ ok: false, error: 'Cannot approve from status "' + req.status + '"' });
  }
  if (!actorMayApprove_(actor, req)) return forbidden_();
  var emergency = (requiredApproverFor_(req) === APPROVER.AUTO);
  updateRequest_(p.id,
    { status: ST.APPROVED, approved_by: actor.name, approved_at: new Date().toISOString() },
    req.status, ST.APPROVED, actor.name, emergency ? 'אושר אוטומטית (חירום)' : (p.note || ''));
  rebuildDigest();
  return jsonOut_({ ok: true });
}

function handleReject_(p, actor) {
  if (!p.id) return jsonOut_({ ok: false, error: 'Missing id' });
  var req = getRequestById(p.id);
  if (!req) return jsonOut_({ ok: false, error: 'Request not found' });
  if (!canTransition_(req.status, ST.NOT_APPROVED)) {
    return jsonOut_({ ok: false, error: 'Cannot reject from status "' + req.status + '"' });
  }
  if (!actorMayApprove_(actor, req)) return forbidden_();
  updateRequest_(p.id,
    { status: ST.NOT_APPROVED, rejection_reason: p.reason || '' },
    req.status, ST.NOT_APPROVED, actor.name, p.reason || '');
  rebuildDigest();
  return jsonOut_({ ok: true });
}

function handleDefer_(p, actor) {
  if (!p.id || !p.deferred_until) {
    return jsonOut_({ ok: false, error: 'Missing id or deferred_until' });
  }
  if (!canDefer(actor.role)) return forbidden_();
  var req = getRequestById(p.id);
  if (!req) return jsonOut_({ ok: false, error: 'Request not found' });
  if (!canTransition_(req.status, ST.DEFERRED)) {
    return jsonOut_({ ok: false, error: 'Cannot defer from status "' + req.status + '"' });
  }
  updateRequest_(p.id,
    { status: ST.DEFERRED, deferred_until: p.deferred_until },
    req.status, ST.DEFERRED, actor.name, 'נדחה ל-' + p.deferred_until);
  rebuildDigest();
  return jsonOut_({ ok: true });
}

function handleAssign_(p, actor) {
  if (!p.id || !p.assigned_to) {
    return jsonOut_({ ok: false, error: 'Missing id or assigned_to' });
  }
  if (!canDispatch(actor.role)) return forbidden_();
  var req = getRequestById(p.id);
  if (!req) return jsonOut_({ ok: false, error: 'Request not found' });
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
  updateRequest_(p.id, fields, req.status, fields.status || req.status, actor.name, note);
  rebuildDigest();
  return jsonOut_({ ok: true });
}

var VALID_TRADES_ = ['חשמלאי', 'אינסטלטור', 'איש מזגנים', 'צבעי', 'איש בריכות', 'איש רשתות', 'עבודות אלומיניום', 'עבודות נגרות', 'אחר'];

function handleMarkExternal_(p, actor) {
  if (!p.id || !p.trade) return jsonOut_({ ok: false, error: 'Missing id or trade' });
  if (!canDispatch(actor.role)) return forbidden_();
  if (VALID_TRADES_.indexOf(p.trade) === -1) return jsonOut_({ ok: false, error: 'Invalid trade' });
  var req = getRequestById(p.id);
  if (!req) return jsonOut_({ ok: false, error: 'Request not found' });
  if (req.status !== ST.APPROVED) return jsonOut_({ ok: false, error: 'ניתן לסמן רק דרישה מאושרת' });
  updateRequest_(p.id,
    { assignment_type: 'external', trade: p.trade },
    req.status, req.status, actor.name, 'סומן כעבודה חיצונית: ' + p.trade);
  rebuildDigest();
  return jsonOut_({ ok: true });
}

function handleAssignBatch_(p, actor) {
  if (!p.ids || !p.ids.length) return jsonOut_({ ok: false, error: 'Missing ids' });
  if (!canDispatch(actor.role)) return forbidden_();
  var batchId = p.batch_id || ('BATCH-' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14));
  var assignedTo = p.assigned_to || (p.trade || 'טכנאי חיצוני');
  var done = [];
  for (var i = 0; i < p.ids.length; i++) {
    var id = p.ids[i];
    var req = getRequestById(id);
    if (!req || !canTransition_(req.status, ST.IN_PROGRESS)) continue;
    updateRequest_(id,
      { status: ST.IN_PROGRESS, assignment_type: 'external', assigned_to: assignedTo, trade: p.trade || req.trade || '', batch_id: batchId },
      req.status, ST.IN_PROGRESS, actor.name, 'הוקצה בביקור מרוכז ' + batchId);
    done.push(id);
  }
  rebuildDigest();
  return jsonOut_({ ok: true, batch_id: batchId, assigned: done });
}

function handleSetStatus_(p, actor) {
  if (!p.id || !p.to) return jsonOut_({ ok: false, error: 'Missing id or to' });
  if (!canDispatch(actor.role)) return forbidden_();
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
  updateRequest_(p.id, fields, req.status, p.to, actor.name, p.note || '');
  rebuildDigest();
  return jsonOut_({ ok: true });
}

var VALID_EXECUTION_ = ['בוצע', 'לא בוצע', 'אחר'];

function handleSetExecution_(p, actor) {
  if (!p.id || p.value == null) return jsonOut_({ ok: false, error: 'Missing id or value' });
  if (!canDispatch(actor.role)) return forbidden_();
  if (VALID_EXECUTION_.indexOf(p.value) === -1) return jsonOut_({ ok: false, error: 'Invalid execution value' });
  var req = getRequestById(p.id);
  if (!req) return jsonOut_({ ok: false, error: 'Request not found' });

  if (p.value === 'בוצע') {
    if (!canTransition_(req.status, ST.COMPLETED)) {
      return jsonOut_({ ok: false, error: 'ניתן לסמן בוצע רק למשימה בביצוע' });
    }
    updateRequest_(p.id,
      { execution_status: 'בוצע', status: ST.COMPLETED, completed_at: new Date().toISOString() },
      req.status, ST.COMPLETED, actor.name, 'סומן כבוצע');
    rebuildDigest();
    return jsonOut_({ ok: true, completed: true });
  }

  updateRequest_(p.id,
    { execution_status: p.value },
    req.status, req.status, actor.name, 'סטטוס ביצוע: ' + p.value);
  rebuildDigest();
  return jsonOut_({ ok: true, completed: false });
}

// ===== Inspections module =====

var INSPECTION_USERS_ = ['רועי', 'אולגה', 'אורן', 'sandra', 'סנדרה'];
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

function handleCreateInspection_(p, actor) {
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

function handleAddFinding_(p, actor) {
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

/** Confirm a physical-defect finding → creates a request via the SAME pipeline, links both. */
function handleConfirmFinding_(p, actor) {
  if (!p.finding_id) return jsonOut_({ ok: false, error: 'Missing finding_id' });
  var findings = readObjects_('InspectionFindings');
  var finding = null;
  for (var i = 0; i < findings.length; i++) {
    if (String(findings[i].id) === String(p.finding_id)) { finding = findings[i]; break; }
  }
  if (!finding) return jsonOut_({ ok: false, error: 'Finding not found' });
  if (finding.finding_type !== 'physical_defect') return jsonOut_({ ok: false, error: 'Only a physical defect can become a request' });
  if (finding.linked_request_id) return jsonOut_({ ok: false, error: 'Finding already linked to a request' });

  var inspections = readObjects_('Inspections');
  var insp = null;
  for (var j = 0; j < inspections.length; j++) {
    if (String(inspections[j].id) === String(finding.inspection_id)) { insp = inspections[j]; break; }
  }
  if (!insp) return jsonOut_({ ok: false, error: 'Parent inspection not found' });

  var row = buildNewRequest_({
    created_by: actor.name, house: insp.house,
    category: finding.suggested_category || 'תיקון',
    description: finding.finding_text, location_in_house: finding.location_in_house || '',
    urgency: 'רגיל', estimated_cost: '',
  });
  row.approval_required = approvalRequiredFor_(row.estimated_cost, row.urgency, row.house);
  appendRequest(row);
  writeAuditEntry(row.id, '', row.status, actor.name, 'נוצר מבקרה (finding ' + finding.id + ')');

  updateFinding_(finding.id, { linked_request_id: row.id, confirmed_by: actor.name, confirmed_at: new Date().toISOString() });
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

// ===== Delete + edit requests =====
// Delete: management (ops_manager / ceo), audit-logged before removal. Edit: only BEFORE approval.

var EDITABLE_STATUSES_ = ['דרישה', 'ממתין לאישור'];
var EDITABLE_FIELDS_ = ['description', 'location_in_house', 'category', 'urgency', 'estimated_cost', 'house'];

function isManagement_(role) { return role === ROLE.OPS_MANAGER || role === ROLE.CEO; }

function handleDeleteRequest_(p, actor) {
  if (!p.id) return jsonOut_({ ok: false, error: 'Missing id' });
  if (!isManagement_(actor.role)) return forbidden_();
  var sheet = getSheet_('Requests');
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var idCol = headers.indexOf('id');
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][idCol]) === String(p.id)) {
      writeAuditEntry(p.id, data[r][headers.indexOf('status')], 'נמחק', actor.name, p.note || 'נמחק ע"י ' + actor.name);
      sheet.deleteRow(r + 1);
      rebuildDigest();
      return jsonOut_({ ok: true });
    }
  }
  return jsonOut_({ ok: false, error: 'Request not found' });
}

function handleEditRequest_(p, actor) {
  if (!p.id) return jsonOut_({ ok: false, error: 'Missing id' });
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
  var merged = {
    house: fields.house != null ? fields.house : req.house,
    category: fields.category != null ? fields.category : req.category,
    urgency: fields.urgency != null ? fields.urgency : req.urgency,
    created_by: req.created_by,
    estimated_cost: fields.estimated_cost != null ? fields.estimated_cost : req.estimated_cost,
  };
  var err = validateNewRequest_(merged);
  if (err) return jsonOut_({ ok: false, error: err });
  fields.approval_required = approvalRequiredFor_(merged.estimated_cost, merged.urgency, merged.house);
  updateRequest_(p.id, fields, req.status, req.status, actor.name, 'נערך ע"י ' + actor.name);
  rebuildDigest();
  return jsonOut_({ ok: true });
}

// ===== Inventory module — WEEKLY stock count per house (מלאי) =====

var INVENTORY_CATEGORIES_ = ['טואלטיקה', 'חומרי ניקוי'];
var INVENTORY_COUNTERS_ = ['שירה', 'יעקב', 'אורן', 'אביב', 'צחי', 'רועי', 'רמי'];

function isValidMonth_(m) {
  return typeof m === 'string' && /^20[2-9][0-9]-(0[1-9]|1[0-2])$/.test(m);
}

function weekStart_(date) {
  var d = date instanceof Date ? new Date(date.getTime()) : new Date(date);
  if (isNaN(d.getTime())) return '';
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}

function isValidWeekStart_(w) {
  if (typeof w !== 'string') return false;
  if (!/^20[2-9][0-9]-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/.test(w)) return false;
  return weekStart_(w) === w;
}

function monthFromWeekStart_(w) {
  return isValidWeekStart_(w) ? w.slice(0, 7) : '';
}

function writeInventoryRows_(house, weekStartStr, countedBy, filled, auditAction, auditNote) {
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
      week_start: weekStartStr,
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

function handleSubmitInventory_(p, actor) {
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
    if (blank) continue;
    var n = Number(it.quantity);
    if (isNaN(n) || !isFinite(n) || n < 0) {
      return jsonOut_({ ok: false, error: 'quantity must be a number ≥ 0 (' + it.item + ')' });
    }
    filled.push({ category: it.category, item: it.item, quantity: n, notes: String(it.notes || '').slice(0, 500) });
  }
  if (filled.length === 0) return jsonOut_({ ok: false, error: 'No quantities filled' });

  var res = writeInventoryRows_(
    p.house, p.week_start, p.counted_by, filled, 'ספירת מלאי',
    'ספירה שבועית ' + p.week_start + ' — ' + p.house + ' (' + filled.length + ' פריטים)');
  return jsonOut_({ ok: true, count_id: res.count_id, items: res.items });
}
