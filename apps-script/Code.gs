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

// Proof the Node login layer presents to read the roster WITH pin_hash (server-to-server). Mirrors
// src/auth.js rosterProof: HMAC(SESSION_SECRET, 'roster:users'). '' when the secret is unset.
function rosterProof_() {
  var secret = getSessionSecret_();
  return secret ? hmacHex_(secret, 'roster:users') : '';
}

// The Users roster for a doGet('users') read. pin_hash is returned ONLY to a caller presenting the
// server-to-server proof (Node login). Every other caller — including anyone who has the world-
// callable /exec URL — gets pin_hash STRIPPED, so password hashes never leak off the sheet.
function usersForRead_(e) {
  var proof = (e && e.parameter && e.parameter.auth) || '';
  var expected = rosterProof_();
  var withHash = expected !== '' && constantTimeEq_(proof, expected);
  var users = getUsers();
  if (withHash) return users;
  return users.map(function (u) {
    var c = {};
    for (var k in u) { if (k !== 'pin_hash') c[k] = u[k]; }
    return c;
  });
}

function getRequestById(id) {
  var all = getRequests();
  for (var i = 0; i < all.length; i++) {
    if (String(all[i].id) === String(id)) return all[i];
  }
  return null;
}

// The cluster of a house, looked up by name. '' when unknown. Used for tier-B (maintenance)
// house-scope enforcement.
function getHouseCluster_(house) {
  var houses = getHouses();
  for (var i = 0; i < houses.length; i++) {
    if (String(houses[i].name) === String(house)) return houses[i].cluster;
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
 * Verify a Bearer session token. Returns { name, role, scope } on success, or null on any failure
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
  return { name: claims.n || '', role: claims.r || '', scope: claims.sc || '' };
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

// block / unblock a request (increment 36): field_ops, ops_manager, ceo. A coordinator/maintenance
// gets 403 — same tier boundary as defer/dispatch.
function canBlock(actorRole) {
  return actorRole === ROLE.FIELD_OPS || actorRole === ROLE.OPS_MANAGER || actorRole === ROLE.CEO;
}

// Manager tier (tier A) — sees ALL houses and holds the approve/dispatch powers. field_ops /
// ops_manager / ceo. Everyone else (coordinator, maintenance) is the restricted tier B.
function isManagerRole(role) {
  return role === ROLE.FIELD_OPS || role === ROLE.OPS_MANAGER || role === ROLE.CEO;
}

// /management screen (increment 37): the NETWORK-MANAGEMENT view for Olga (ops_manager) and the CEO.
// NARROWER than isManagerRole — field_ops (Roy) is a manager tier for dispatch but is NOT an exec, so
// he gets 403 here. Enforced server-side AND in Code.gs, never UI-only.
function canManage(role) {
  return role === ROLE.OPS_MANAGER || role === ROLE.CEO;
}

// House-scope visibility (increment 31). Managers see every house. A coordinator sees ONLY their
// own house (scope = that house name). A maintenance lead sees the houses in their cluster(s)
// (scope = a comma-separated cluster list; houseCluster is the candidate house's cluster). The
// scope value comes from the signed session token, never from a client-supplied field.
function houseInScope(role, scope, houseName, houseCluster) {
  if (isManagerRole(role)) return true;
  if (role === ROLE.COORDINATOR) return String(houseName) === String(scope);
  if (role === ROLE.MAINTENANCE) {
    var clusters = String(scope == null ? '' : scope).split(',');
    for (var i = 0; i < clusters.length; i++) {
      if (clusters[i].replace(/^\s+|\s+$/g, '') === String(houseCluster)) return true;
    }
    return false;
  }
  return false;
}
// === MIRROR:roles END ===

// === MIRROR:approval START ===
var URGENCY_EMERGENCY = 'חירום';

var APPROVER = { AUTO: 'auto', FIELD_OPS: 'field_ops', OPS_MANAGER: 'ops_manager' };

function costIsBlank(cost) {
  return cost === '' || cost === null || cost === undefined;
}

// Which ROLE must approve this request. Returns 'auto' for the emergency bypass. Routes by amount
// only — house status is NOT consulted (chain B v2).
function whoApproves(cost, urgency, approvalThreshold) {
  if (urgency === URGENCY_EMERGENCY) return APPROVER.AUTO;
  if (!costIsBlank(cost) && Number(cost) > Number(approvalThreshold)) return APPROVER.OPS_MANAGER;
  return APPROVER.FIELD_OPS;
}

// Derived approval_required flag — TRUE when the request escalates above the default field_ops
// approver (i.e. routes to ops_manager). Emergency (auto) and field_ops are FALSE.
function approvalRequired(cost, urgency, approvalThreshold) {
  return whoApproves(cost, urgency, approvalThreshold) === APPROVER.OPS_MANAGER;
}
// === MIRROR:approval END ===

// === MIRROR:sla START ===
// Parse a "label:days|label:days" spec (e.g. "חירום:1|דחוף:3|רגיל:14") into { label: days }, or null
// when empty or ANY pair is malformed — empty label, missing colon, or days not a whole number > 0.
// null means "do not trust this spec"; the caller derives no due date rather than guessing one.
function parseSlaSpec(spec) {
  if (typeof spec !== 'string' || spec.replace(/^\s+|\s+$/g, '') === '') return null;
  var parts = spec.split('|');
  var out = {};
  var n = 0;
  for (var i = 0; i < parts.length; i++) {
    var seg = parts[i].replace(/^\s+|\s+$/g, '');
    if (seg === '') return null;
    var idx = seg.lastIndexOf(':');
    if (idx <= 0 || idx === seg.length - 1) return null;
    var label = seg.slice(0, idx).replace(/^\s+|\s+$/g, '');
    var days = Number(seg.slice(idx + 1).replace(/^\s+|\s+$/g, ''));
    if (!label || !isFinite(days) || days <= 0 || Math.floor(days) !== days) return null;
    out[label] = days;
    n++;
  }
  return n ? out : null;
}

// The SLA days for an urgency, or null (malformed spec OR unknown urgency → null; caller logs and
// derives no due date — never a silently wrong default).
function slaDaysFor(spec, urgency) {
  var map = parseSlaSpec(spec);
  if (!map) return null;
  return Object.prototype.hasOwnProperty.call(map, urgency) ? map[urgency] : null;
}

// due_at = fromIso + (days for urgency), in ISO. '' when no due date can be derived (malformed spec,
// unknown urgency, or unparseable fromIso). `log`, if given, is called with the reason it was blank.
function deriveDueAt(fromIso, urgency, spec, log) {
  var days = slaDaysFor(spec, urgency);
  if (days == null) {
    if (log) log('sla: no due date for urgency "' + urgency + '" (spec "' + spec + '") — left blank');
    return '';
  }
  var base = new Date(fromIso);
  if (isNaN(base.getTime())) {
    if (log) log('sla: unparseable base date "' + fromIso + '" — due date left blank');
    return '';
  }
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString();
}

// Whole days a request has been open: created_at → completed_at once completed, else created_at → now.
// FREEZES at completion. null on unparseable input; never negative.
function daysOpen(createdAt, completedAt, now) {
  var start = new Date(createdAt);
  var endRaw = (completedAt != null && String(completedAt) !== '') ? completedAt : now;
  var end = endRaw instanceof Date ? endRaw : new Date(endRaw);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;
  var ms = end.getTime() - start.getTime();
  if (ms < 0) ms = 0;
  return Math.floor(ms / 86400000);
}

// Overdue = due_at set AND now strictly past it AND the request is still ageing: NOT completed/closed,
// and NOT deferred (a deferral parks the SLA — while נדחה לתאריך a request is never overdue). `blocked`
// is deliberately NOT consulted: a blocked request still ages and can still be overdue.
function isOverdue(dueAt, status, now) {
  if (dueAt == null || String(dueAt) === '') return false;
  if (status === 'הושלם' || status === 'סגור') return false;
  if (status === 'נדחה לתאריך') return false;
  var due = new Date(dueAt);
  var n = now instanceof Date ? now : new Date(now);
  if (isNaN(due.getTime()) || isNaN(n.getTime())) return false;
  return n.getTime() > due.getTime();
}

// Whole days past due_at, or 0 when not overdue.
function daysOverdue(dueAt, status, now) {
  if (!isOverdue(dueAt, status, now)) return 0;
  var due = new Date(dueAt);
  var n = now instanceof Date ? now : new Date(now);
  return Math.floor((n.getTime() - due.getTime()) / 86400000);
}

// A request's `blocked` cell (stored 'TRUE'/'FALSE') as a boolean.
function isBlocked(v) {
  return String(v == null ? '' : v).toUpperCase() === 'TRUE';
}

// Validate a block/unblock request. Returns an error string, or null when OK. Blocking REQUIRES a
// non-empty reason; unblocking needs none. (Role gating is separate — see canBlock in roles.)
function blockValidation(blocked, reason) {
  var block = (blocked === true || String(blocked).toUpperCase() === 'TRUE');
  if (block && String(reason == null ? '' : reason).replace(/^\s+|\s+$/g, '') === '') {
    return 'חסימה מחייבת סיבה';
  }
  return null;
}

// All read-time aging facts for a request row, in one call (used by the UI list + the digest).
function ticketAging(req, now) {
  var status = req && req.status != null ? String(req.status) : '';
  var dueAt = req && req.due_at != null ? req.due_at : '';
  return {
    days_open: daysOpen(req ? req.created_at : '', req ? req.completed_at : '', now),
    overdue: isOverdue(dueAt, status, now),
    days_overdue: daysOverdue(dueAt, status, now),
    blocked: isBlocked(req ? req.blocked : ''),
  };
}
// === MIRROR:sla END ===

// Config accessor for the SLA spec (never hardcoded). Returns the raw "urgency:days" string, or ''.
function slaSpec_() { var v = getConfig('sla_days'); return v == null ? '' : String(v); }

// Config accessor for the routing rule (never hardcode the value). ceo_ceiling stays in Config but
// is DORMANT (chain B v2 does not read it).
function approvalThreshold_() { return Number(getConfig('approval_threshold')); }

// The derived approval_required for a request (chain B v2 — amount only).
function approvalRequiredFor_(cost, urgency) {
  return approvalRequired(cost, urgency, approvalThreshold_());
}

// The role that must approve a given request row.
function requiredApproverFor_(req) {
  return whoApproves(req.estimated_cost, req.urgency, approvalThreshold_());
}

// ---- HTTP router ----

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || '';
  var result;
  switch (action) {
    case 'houses':      result = getHouses(); break;
    case 'technicians': result = getTechnicians(); break;
    case 'requests':    result = getRequests(); break;
    case 'users':       result = usersForRead_(e); break;
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
    case 'setBlocked':    return handleSetBlocked_(body.payload || {}, actor);
    case 'managementData': return handleManagementData_(body.payload || {}, actor);
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
  // The submitter is the verified token identity, never a client-supplied field.
  input.created_by = actor.name;
  var validationError = validateNewRequest_(input);
  if (validationError) return jsonOut_({ ok: false, error: validationError });
  // Tier B (coordinator / maintenance) may only file a request for a house in THEIR scope; the
  // scope comes from the token. Managers may file for any house.
  if (!isManagerRole(actor.role) &&
      !houseInScope(actor.role, actor.scope, input.house, getHouseCluster_(input.house))) {
    return forbidden_();
  }
  var row = buildNewRequest_(input);
  row.approval_required = approvalRequiredFor_(row.estimated_cost, row.urgency);
  // due_at derived from urgency at creation (Config sla_days). Malformed spec / unknown urgency → ''
  // (logged), never a silently wrong date.
  row.due_at = deriveDueAt(row.created_at, row.urgency, slaSpec_(), function (m) { Logger.log(m); });
  appendRequest(row);
  rebuildDigest();
  return jsonOut_({ ok: true, id: row.id });
}

function validateNewRequest_(p) {
  if (!p || typeof p !== 'object') return 'Missing payload';
  if (!p.house) return 'Missing house';
  if (VALID_CATEGORIES.indexOf(p.category) === -1) return 'Invalid or missing category';
  if (VALID_URGENCIES.indexOf(p.urgency) === -1) return 'Invalid or missing urgency';
  // created_by is the verified token identity (set by the caller), so it is trusted here — no
  // SUBMITTERS allow-list check (that list predates identity auth).
  if (!p.created_by) return 'Missing created_by';
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
    // SLA + aging (increment 36). due_at is derived in handleCreateRequest_ (needs Config); a request
    // starts unblocked.
    due_at: '', blocked: 'FALSE', blocked_reason: '', blocked_at: '',
    // Preventive maintenance (תחזוקה מונעת). Blank for a user-filed request; set by
    // createMaintenanceRequest_ for a generated one.
    plan_id: '',
    // Compliance (עמידה באמות מידה). Blank for a user-filed request; set by createComplianceRequest_.
    compliance_id: '',
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
  var fields = { status: ST.APPROVED, approved_by: actor.name, approved_at: new Date().toISOString() };
  // SLA wake-up (increment 36): a request approved OUT OF deferral re-derives its due date from the
  // deferral date FORWARD (not from original creation) — the clock restarts when it wakes up.
  if (req.status === ST.DEFERRED) {
    fields.due_at = deriveDueAt(req.deferred_until, req.urgency, slaSpec_(), function (m) { Logger.log(m); });
  }
  updateRequest_(p.id, fields,
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
  // Preventive maintenance: a completed plan-linked request writes its completion date back to the
  // plan's last_done (no-op for a normal request — plan_id blank).
  if (p.to === ST.COMPLETED) updatePlanLastDone_({ plan_id: req.plan_id, completed_at: fields.completed_at });
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
    var completedAt = new Date().toISOString();
    updateRequest_(p.id,
      { execution_status: 'בוצע', status: ST.COMPLETED, completed_at: completedAt },
      req.status, ST.COMPLETED, actor.name, 'סומן כבוצע');
    // Preventive maintenance: write completion date back to the plan's last_done (no-op if not linked).
    updatePlanLastDone_({ plan_id: req.plan_id, completed_at: completedAt });
    rebuildDigest();
    return jsonOut_({ ok: true, completed: true });
  }

  updateRequest_(p.id,
    { execution_status: p.value },
    req.status, req.status, actor.name, 'סטטוס ביצוע: ' + p.value);
  rebuildDigest();
  return jsonOut_({ ok: true, completed: false });
}

// Block / unblock a request (increment 36). A manual flag set by field_ops / ops_manager / ceo —
// enforced HERE (403 for coordinator/maintenance), never UI-only. Blocking REQUIRES a reason. A block
// is NOT a status transition (the status is untouched) and does NOT pause aging — a blocked request
// still ages and can still be overdue. Every block/unblock is logged to AuditLog with actor + time.
function handleSetBlocked_(p, actor) {
  if (!p.id || p.blocked == null) return jsonOut_({ ok: false, error: 'Missing id or blocked' });
  if (!canBlock(actor.role)) return forbidden_();
  var req = getRequestById(p.id);
  if (!req) return jsonOut_({ ok: false, error: 'Request not found' });
  var block = (p.blocked === true || String(p.blocked).toUpperCase() === 'TRUE');
  var invalid = blockValidation(p.blocked, p.reason);
  if (invalid) return jsonOut_({ ok: false, error: invalid });
  if (block) {
    var reason = String(p.reason == null ? '' : p.reason).trim();
    updateRequest_(p.id,
      { blocked: 'TRUE', blocked_reason: reason.slice(0, 500), blocked_at: new Date().toISOString() },
      req.status, req.status, actor.name, 'חסום: ' + reason);
  } else {
    updateRequest_(p.id,
      { blocked: 'FALSE', blocked_reason: '', blocked_at: '' },
      req.status, req.status, actor.name, 'שוחרר מחסימה');
  }
  rebuildDigest();
  return jsonOut_({ ok: true, blocked: block });
}

// === MIRROR:digestconsume START ===
// Header aliases for the kitchen FoodShortages tab — read by NAME so column order never matters and
// minor naming differences are tolerated. A row is an object keyed by its header.
var FOOD_HOUSE_KEYS = ['house', 'house_id', 'houseId', 'houseID'];
var FOOD_ITEM_KEYS = ['item', 'item_text', 'itemName', 'product', 'name'];

// The first candidate header actually present on the row, or '' if none are.
function pickHeader(row, candidates) {
  for (var i = 0; i < candidates.length; i++) {
    if (row && Object.prototype.hasOwnProperty.call(row, candidates[i])) return candidates[i];
  }
  return '';
}

// Shape FoodShortages rows → { available, reason?, houses:[{id,house,count,items}] }.
//   rows     : array of header-keyed objects (empty array → available with no houses; NOT an error).
//   idToName : canonical house id → city-first Hebrew display name (HOUSE-IDS.md). A row whose house
//              id is not in this map is OMITTED (never guessed).
// Missing the house OR item header entirely → available:false (we will not fabricate a shape or a 0).
function summarizeFoodShortages(rows, idToName) {
  if (!rows || rows.length === 0) return { available: true, houses: [] };
  var houseKey = pickHeader(rows[0], FOOD_HOUSE_KEYS);
  var itemKey = pickHeader(rows[0], FOOD_ITEM_KEYS);
  if (!houseKey || !itemKey) return { available: false, reason: 'חסרות כותרות מזוהות בדייג׳סט המטבח' };
  var map = idToName || {};
  var byId = {};
  var order = [];
  for (var r = 0; r < rows.length; r++) {
    var id = String(rows[r][houseKey] == null ? '' : rows[r][houseKey]).replace(/^\s+|\s+$/g, '');
    if (!id || !Object.prototype.hasOwnProperty.call(map, id)) continue; // unmapped house → omit
    var item = String(rows[r][itemKey] == null ? '' : rows[r][itemKey]).replace(/^\s+|\s+$/g, '');
    if (!item) continue;
    if (!Object.prototype.hasOwnProperty.call(byId, id)) { byId[id] = { id: id, house: map[id], count: 0, items: [] }; order.push(id); }
    byId[id].count++;
    byId[id].items.push(item);
  }
  order.sort(function (a, b) { var x = byId[a].house, y = byId[b].house; return x < y ? -1 : x > y ? 1 : 0; });
  var out = [];
  for (var i = 0; i < order.length; i++) out.push(byId[order[i]]);
  return { available: true, houses: out };
}

// Turn a read context into a panel. Keeps every "unavailable" reason in ONE pure place so the Code.gs
// side only does the SpreadsheetApp read and hands the outcome here.
//   ctx: { configured, readError, missingTab, rows }
function foodShortagesPanel(ctx, idToName) {
  var c = ctx || {};
  if (!c.configured) return { available: false, reason: 'לא הוגדר מזהה דייג׳סט מטבח (Config: kitchen_digest_id)' };
  if (c.readError) return { available: false, reason: 'שגיאת קריאה מדייג׳סט המטבח — בדוק הרשאת צפייה לחשבון הלוגיסטיקה' };
  if (c.missingTab) return { available: false, reason: 'הטאב FoodShortages לא נמצא בדייג׳סט המטבח' };
  return summarizeFoodShortages(c.rows || [], idToName);
}
// === MIRROR:digestconsume END ===

// Read an arbitrary (possibly FOREIGN, read-only) sheet into header-keyed objects. By-name reads only.
function objectsFromSheet_(sheet) {
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

// Canonical house id → city-first Hebrew display name, derived from the digest house map (HOUSE-IDS.md).
function canonicalHouseIdToName_() {
  var out = {};
  for (var name in DIGEST_HOUSE_IDS_) {
    if (Object.prototype.hasOwnProperty.call(DIGEST_HOUSE_IDS_, name)) out[DIGEST_HOUSE_IDS_[name]] = name;
  }
  return out;
}

// READ-ONLY consumption of the ezone-kitchen digest (tab FoodShortages). Cached ~5 min so the screen
// doesn't hammer the foreign sheet. Any failure (no id, no access, missing tab, missing headers) yields
// an "unavailable" panel — never a crash, never a fabricated 0. Never writes anything.
function readKitchenShortages_() {
  var CK = 'mgmt_kitchen_food_v1';
  var cache = null;
  try { cache = CacheService.getScriptCache(); } catch (e) { cache = null; }
  if (cache) { var hit = cache.get(CK); if (hit) { try { return JSON.parse(hit); } catch (e2) {} } }

  var id = String(getConfig('kitchen_digest_id') || '').replace(/^\s+|\s+$/g, '');
  var ctx = { configured: id !== '' };
  if (ctx.configured) {
    try {
      var ss = SpreadsheetApp.openById(id);
      var sheet = ss.getSheetByName('FoodShortages');
      if (!sheet) ctx.missingTab = true;
      else ctx.rows = objectsFromSheet_(sheet);
    } catch (e) {
      ctx.readError = true;
    }
  }
  var panel = foodShortagesPanel(ctx, canonicalHouseIdToName_());
  if (cache) { try { cache.put(CK, JSON.stringify(panel), 300); } catch (e3) {} }
  return panel;
}

// Coordinators digest: no coordinators-PUBLISHED digest exists to read (this app only PUBLISHES one
// FOR the coordinators app). Reported "unavailable" with what is missing — never invented.
function readCoordinatorsShortages_() {
  var id = String(getConfig('coordinators_digest_id') || '').replace(/^\s+|\s+$/g, '');
  if (!id) return { available: false, reason: 'אין דייג׳סט רכזים מתפרסם לקריאה (Config: coordinators_digest_id ריק)' };
  return { available: false, reason: 'קריאת דייג׳סט רכזים טרם מומשה (מבנה טאב לא מוגדר)' };
}

// === MIRROR:budget START ===
// A cell → a number, or null when blank/non-numeric (so blanks never coerce to 0).
function budgetNum(v) {
  if (v == null) return null;
  var s = String(v).replace(/^\s+|\s+$/g, '');
  if (s === '') return null;
  var n = Number(s);
  return isFinite(n) ? n : null;
}

// The month (YYYY-MM) a request's spend is attributed to: the month of completed_at once completed,
// else the month of created_at. '' when neither parses.
function requestPeriod(request) {
  var basis = (request && request.completed_at != null && String(request.completed_at).replace(/^\s+|\s+$/g, '') !== '')
    ? request.completed_at : (request ? request.created_at : '');
  var m = String(basis == null ? '' : basis).match(/^(\d{4})-(\d{2})/);
  return m ? (m[1] + '-' + m[2]) : '';
}

// The spend amount for a request and WHICH field it came from: actual_cost if present, else a fallback
// to estimated_cost. { amount:null, source:null } when neither is a number.
function requestActual(request) {
  var a = budgetNum(request ? request.actual_cost : null);
  if (a != null) return { amount: a, source: 'actual' };
  var e = budgetNum(request ? request.estimated_cost : null);
  if (e != null) return { amount: e, source: 'estimated' };
  return { amount: null, source: null };
}

// THE attribution rule: one request → one spend line { houseId, period, amount, source }, or null when
// it is not a spend line. Not spend: a rejected request (לא מאושר), a house that is not a canonical id
// (omitted, never guessed), no attributable month, or no cost at all.
function attributeRequest(request, nameToId) {
  if (!request) return null;
  if (String(request.status) === 'לא מאושר') return null;
  var name = String(request.house == null ? '' : request.house).replace(/^\s+|\s+$/g, '');
  var map = nameToId || {};
  if (!Object.prototype.hasOwnProperty.call(map, name)) return null;
  var period = requestPeriod(request);
  if (!period) return null;
  var act = requestActual(request);
  if (act.amount == null) return null;
  return { houseId: map[name], period: period, amount: act.amount, source: act.source };
}

// Parse + validate one Budgets row → { houseId, period, amount } or null (malformed → logged, skipped).
function parseBudgetRow(row, log) {
  var house = String(row && row.house != null ? row.house : '').replace(/^\s+|\s+$/g, '');
  var period = String(row && row.period != null ? row.period : '').replace(/^\s+|\s+$/g, '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    if (log) log('budget: bad period "' + period + '" for house "' + house + '" — row skipped');
    return null;
  }
  var amount = budgetNum(row ? row.amount : null);
  if (amount == null || amount < 0) {
    if (log) log('budget: non-numeric/negative amount for house "' + house + '" ' + period + ' — row skipped');
    return null;
  }
  if (!house) {
    if (log) log('budget: missing house for period ' + period + ' — row skipped');
    return null;
  }
  return { houseId: house, period: period, amount: amount };
}

// Adherence for ONE period. maps: { nameToId, idToName }. Returns per-house rows (worst-first) plus a
// skipped count. A house with an actual but no budget row is shown with budgetDefined=false ("not
// defined") — never a fabricated 0 budget. A house with a budget but no spend shows actual 0.
function computeAdherence(budgets, requests, maps, period, log) {
  var nameToId = (maps && maps.nameToId) || {};
  var idToName = (maps && maps.idToName) || {};

  var budgetByHouse = {};
  var skipped = 0;
  for (var i = 0; i < (budgets || []).length; i++) {
    var b = parseBudgetRow(budgets[i], log);
    if (!b) { skipped++; continue; }
    if (b.period !== period) continue;
    if (!Object.prototype.hasOwnProperty.call(idToName, b.houseId)) {
      if (log) log('budget: unknown house id "' + b.houseId + '" — row skipped');
      skipped++; continue;
    }
    budgetByHouse[b.houseId] = (budgetByHouse[b.houseId] || 0) + b.amount;
  }

  var actualByHouse = {};
  var usedEstimated = {};
  for (var j = 0; j < (requests || []).length; j++) {
    var a = attributeRequest(requests[j], nameToId);
    if (!a || a.period !== period) continue;
    actualByHouse[a.houseId] = (actualByHouse[a.houseId] || 0) + a.amount;
    if (a.source === 'estimated') usedEstimated[a.houseId] = true;
  }

  var ids = {};
  var k;
  for (k in budgetByHouse) if (Object.prototype.hasOwnProperty.call(budgetByHouse, k)) ids[k] = true;
  for (k in actualByHouse) if (Object.prototype.hasOwnProperty.call(actualByHouse, k)) ids[k] = true;

  var rows = [];
  for (var id in ids) {
    if (!Object.prototype.hasOwnProperty.call(ids, id)) continue;
    var hasBudget = Object.prototype.hasOwnProperty.call(budgetByHouse, id);
    var actual = actualByHouse[id] || 0;
    var row = { id: id, house: idToName[id] || id, actual: actual, usedEstimated: !!usedEstimated[id], budgetDefined: hasBudget };
    if (hasBudget) {
      var budget = budgetByHouse[id];
      row.budget = budget;
      row.remaining = budget - actual;
      row.percentUsed = budget > 0 ? Math.round((100 * actual) / budget) : null;
      row.over = actual > budget;
    } else {
      row.over = false;
    }
    rows.push(row);
  }

  rows.sort(function (x, y) {
    if ((x.over ? 1 : 0) !== (y.over ? 1 : 0)) return (y.over ? 1 : 0) - (x.over ? 1 : 0);
    var xp = x.budgetDefined ? (x.percentUsed == null ? -1 : x.percentUsed) : -2;
    var yp = y.budgetDefined ? (y.percentUsed == null ? -1 : y.percentUsed) : -2;
    if (xp !== yp) return yp - xp;
    return x.house < y.house ? -1 : x.house > y.house ? 1 : 0;
  });

  return { period: period, houses: rows, skipped: skipped };
}

// Periods offered by the month selector: every period that has a budget row or an attributable
// request, plus the current period, most-recent first.
function budgetPeriods(budgets, requests, maps, currentPeriod) {
  var nameToId = (maps && maps.nameToId) || {};
  var set = {};
  if (currentPeriod) set[currentPeriod] = true;
  for (var i = 0; i < (budgets || []).length; i++) {
    var b = parseBudgetRow(budgets[i], null);
    if (b) set[b.period] = true;
  }
  for (var j = 0; j < (requests || []).length; j++) {
    var a = attributeRequest(requests[j], nameToId);
    if (a) set[a.period] = true;
  }
  var out = [];
  for (var p in set) if (Object.prototype.hasOwnProperty.call(set, p)) out.push(p);
  out.sort(function (x, y) { return x < y ? 1 : x > y ? -1 : 0; }); // most-recent first
  return out;
}
// === MIRROR:budget END ===

// === MIRROR:maintenance START ===
// Two-digit zero-pad for a month/day number.
function maintPad2(n) { return n < 10 ? '0' + n : '' + n; }

// A cell → a POSITIVE integer, or null when blank / non-numeric / not a positive whole number (so a
// bad frequency never coerces to a silent default).
function maintNum(v) {
  if (v == null) return null;
  var s = String(v).replace(/^\s+|\s+$/g, '');
  if (s === '') return null;
  var n = Number(s);
  if (!isFinite(n) || n <= 0 || Math.floor(n) !== n) return null;
  return n;
}

// TRUE/FALSE cell → boolean. Only the explicit 'TRUE' (any case) is active; blank / anything else is
// inactive (an inactive plan never generates a request and is not tracked in the panel).
function maintActive(v) {
  return String(v == null ? '' : v).replace(/^\s+|\s+$/g, '').toUpperCase() === 'TRUE';
}

// Any date-ish cell → 'YYYY-MM-DD', or '' when blank / unparseable. Handles a Date object (Apps Script
// reads a date cell as one) and an ISO/date string; the time portion is dropped.
function maintDateOnly(v) {
  if (v == null) return '';
  if (typeof v === 'object' && typeof v.getFullYear === 'function' && isFinite(v.getTime())) {
    return v.getFullYear() + '-' + maintPad2(v.getMonth() + 1) + '-' + maintPad2(v.getDate());
  }
  var m = String(v).replace(/^\s+|\s+$/g, '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? (m[1] + '-' + m[2] + '-' + m[3]) : '';
}

// 'YYYY-MM-DD' → UTC epoch ms at midnight, or null when unparseable.
function ymdToUTC(ymd) {
  var m = String(ymd).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// Days in a (UTC) month; mZeroBased is 0..11.
function daysInMonthUTC_(y, mZeroBased) {
  return new Date(Date.UTC(y, mZeroBased + 1, 0)).getUTCDate();
}

// Add whole months to a 'YYYY-MM-DD' (clamping the day to the target month's length, so
// 2026-01-31 + 1 month = 2026-02-28). Returns '' when the input is unparseable.
function addMonthsToDate(ymd, months) {
  var m = String(ymd).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  var y = Number(m[1]);
  var mo = Number(m[2]) - 1;
  var d = Number(m[3]);
  var total = mo + months;
  var ny = y + Math.floor(total / 12);
  var nm = total % 12;
  if (nm < 0) { nm += 12; ny -= 1; }
  var dim = daysInMonthUTC_(ny, nm);
  var nd = d > dim ? dim : d;
  return ny + '-' + maintPad2(nm + 1) + '-' + maintPad2(nd);
}

// Whole days from fromYmd to toYmd (to - from), or null when either is unparseable.
function maintDaysBetween(fromYmd, toYmd) {
  var a = ymdToUTC(fromYmd), b = ymdToUTC(toYmd);
  if (a == null || b == null) return null;
  return Math.round((b - a) / 86400000);
}

// Derived status of ONE task as of nowDay ('YYYY-MM-DD'): { nextDue, daysUntil, overdue }.
//   - blank last_done (never done) OR bad frequency → due immediately: { nextDue:'', daysUntil:0, overdue:true }.
//   - else nextDue = last_done + frequency months; daysUntil = nextDue - now; overdue = daysUntil <= 0.
function planTaskStatus(lastDone, frequencyMonths, nowDay) {
  var last = maintDateOnly(lastDone);
  var freq = maintNum(frequencyMonths);
  if (!last || freq == null) return { nextDue: '', daysUntil: 0, overdue: true };
  var nextDue = addMonthsToDate(last, freq);
  var daysUntil = maintDaysBetween(nowDay, nextDue);
  if (daysUntil == null) return { nextDue: nextDue, daysUntil: 0, overdue: true };
  return { nextDue: nextDue, daysUntil: daysUntil, overdue: daysUntil <= 0 };
}

// Parse + validate one MaintenancePlan row → normalized object, or null (malformed → logged, skipped).
// idToName is the canonical-id → name map; house must be 'all' or one of its keys.
function parsePlanRow(row, idToName, log) {
  var idMap = idToName || {};
  var id = String(row && row.id != null ? row.id : '').replace(/^\s+|\s+$/g, '');
  var house = String(row && row.house != null ? row.house : '').replace(/^\s+|\s+$/g, '');
  var task = String(row && row.task != null ? row.task : '').replace(/^\s+|\s+$/g, '');
  if (!id) { if (log) log('maintenance: plan row missing id — skipped'); return null; }
  if (!task) { if (log) log('maintenance: plan "' + id + '" missing task — skipped'); return null; }
  var freq = maintNum(row ? row.frequency_months : null);
  if (freq == null) { if (log) log('maintenance: plan "' + id + '" bad frequency_months — skipped'); return null; }
  if (house !== 'all' && !Object.prototype.hasOwnProperty.call(idMap, house)) {
    if (log) log('maintenance: plan "' + id + '" unknown house "' + house + '" — skipped');
    return null;
  }
  return {
    id: id, house: house, task: task, frequency: freq,
    lastDone: maintDateOnly(row ? row.last_done : ''),
    active: maintActive(row ? row.active : ''),
    notes: String(row && row.notes != null ? row.notes : '')
  };
}

// A plan's target house(s) → array of canonical ids. 'all' → every OPEN house; a specific id → itself.
function expandHouses(house, openHouseIds) {
  if (house === 'all') return (openHouseIds || []).slice();
  return [house];
}

// The request-input for a generated maintenance task. A NORMAL request (תיקון / רגיל) — it flows
// through the same approval chain + SLA as any request. plan_id links it back to its plan row.
function maintenanceRequestInput(target) {
  return {
    house: target.houseName,
    category: 'תיקון',
    urgency: 'רגיל',
    description: target.task + ' (תחזוקה מונעת)',
    location_in_house: '',
    estimated_cost: '',
    created_by: 'מערכת - תחזוקה מונעת',
    plan_id: target.planId
  };
}

// A completed request → { planId, day } to write back to its plan's last_done, or null when the
// request is not plan-linked or has no completion date. Idempotent to compute (pure).
function planLastDoneOnComplete(request) {
  if (!request) return null;
  var planId = String(request.plan_id == null ? '' : request.plan_id).replace(/^\s+|\s+$/g, '');
  if (!planId) return null;
  var day = maintDateOnly(request.completed_at);
  if (!day) return null;
  return { planId: planId, day: day };
}

// The set of statuses that mean a generated request is CLOSED-OUT and no longer blocks a re-generation.
var MAINT_TERMINAL_ = { 'הושלם': 1, 'סגור': 1, 'לא מאושר': 1 };

// Decide what to generate this pass. Returns { toCreate:[{planId,houseId,houseName,task}],
// skippedDuplicate, skippedMalformed, skippedInactive }. A task generates only when it is due
// (overdue==true). It is SKIPPED when a non-terminal (still-open) request already exists for the same
// plan_id + house — no duplicate open request is ever created. maps: { idToName }.
function planGenerationPlan(plans, requests, openHouseIds, maps, nowDay, log) {
  var idToName = (maps && maps.idToName) || {};
  var openKeys = {};
  for (var r = 0; r < (requests || []).length; r++) {
    var req = requests[r];
    var pid = String(req && req.plan_id != null ? req.plan_id : '').replace(/^\s+|\s+$/g, '');
    if (!pid) continue;
    var st = String(req && req.status != null ? req.status : '').replace(/^\s+|\s+$/g, '');
    if (Object.prototype.hasOwnProperty.call(MAINT_TERMINAL_, st)) continue;
    var hn = String(req && req.house != null ? req.house : '').replace(/^\s+|\s+$/g, '');
    openKeys[pid + '|' + hn] = true;
  }
  var toCreate = [], skippedDuplicate = 0, skippedMalformed = 0, skippedInactive = 0;
  for (var i = 0; i < (plans || []).length; i++) {
    var plan = parsePlanRow(plans[i], idToName, log);
    if (!plan) { skippedMalformed++; continue; }
    if (!plan.active) { skippedInactive++; continue; }
    var status = planTaskStatus(plan.lastDone, plan.frequency, nowDay);
    if (!status.overdue) continue;
    var houseIds = expandHouses(plan.house, openHouseIds);
    for (var h = 0; h < houseIds.length; h++) {
      var houseId = houseIds[h];
      var houseName = idToName[houseId] || houseId;
      var key = plan.id + '|' + houseName;
      if (openKeys[key]) { skippedDuplicate++; continue; }
      toCreate.push({ planId: plan.id, houseId: houseId, houseName: houseName, task: plan.task });
      openKeys[key] = true; // guard two plan rows for the same plan+house within one pass
    }
  }
  return {
    toCreate: toCreate, skippedDuplicate: skippedDuplicate,
    skippedMalformed: skippedMalformed, skippedInactive: skippedInactive
  };
}

// Plan-adherence panel data: per-house tasks (worst-first) as of nowDay, plus a skipped (malformed)
// count. Open houses are ALWAYS listed (a house with no active plan row → planDefined:false →
// "not defined", never a fabricated 0). maps: { idToName }.
function planAdherence(plans, maps, openHouseIds, nowDay, log) {
  var idToName = (maps && maps.idToName) || {};
  var openIds = openHouseIds || [];
  var tasksByHouse = {};
  var skipped = 0;
  function ensure(id) {
    if (!Object.prototype.hasOwnProperty.call(tasksByHouse, id)) tasksByHouse[id] = [];
    return tasksByHouse[id];
  }
  for (var o = 0; o < openIds.length; o++) ensure(openIds[o]);
  for (var i = 0; i < (plans || []).length; i++) {
    var plan = parsePlanRow(plans[i], idToName, log);
    if (!plan) { skipped++; continue; }
    if (!plan.active) continue;
    var status = planTaskStatus(plan.lastDone, plan.frequency, nowDay);
    var houseIds = expandHouses(plan.house, openIds);
    for (var h = 0; h < houseIds.length; h++) {
      ensure(houseIds[h]).push({
        task: plan.task, lastDone: plan.lastDone, frequency: plan.frequency,
        nextDue: status.nextDue, daysUntil: status.daysUntil, overdue: status.overdue
      });
    }
  }
  var houses = [];
  for (var id in tasksByHouse) {
    if (!Object.prototype.hasOwnProperty.call(tasksByHouse, id)) continue;
    var tasks = tasksByHouse[id];
    tasks.sort(function (a, b) {
      if ((a.overdue ? 1 : 0) !== (b.overdue ? 1 : 0)) return (b.overdue ? 1 : 0) - (a.overdue ? 1 : 0);
      if (a.daysUntil !== b.daysUntil) return a.daysUntil - b.daysUntil;
      return a.task < b.task ? -1 : a.task > b.task ? 1 : 0;
    });
    var overdueCount = 0;
    for (var t = 0; t < tasks.length; t++) if (tasks[t].overdue) overdueCount++;
    houses.push({
      id: id, house: idToName[id] || id, planDefined: tasks.length > 0,
      tasks: tasks, overdueCount: overdueCount
    });
  }
  houses.sort(function (a, b) {
    if (a.overdueCount !== b.overdueCount) return b.overdueCount - a.overdueCount;
    return a.house < b.house ? -1 : a.house > b.house ? 1 : 0;
  });
  return { houses: houses, skipped: skipped };
}
// === MIRROR:maintenance END ===

// === MIRROR:compliance START ===
// A cell → a NON-NEGATIVE integer, or null when blank / non-numeric / negative / fractional (so a bad
// reminder_days never coerces to a silent value — the caller falls back to the Config default).
function complianceNum(v) {
  if (v == null) return null;
  var s = String(v).replace(/^\s+|\s+$/g, '');
  if (s === '') return null;
  var n = Number(s);
  if (!isFinite(n) || n < 0 || Math.floor(n) !== n) return null;
  return n;
}

// Derived status of ONE item as of nowDay ('YYYY-MM-DD'): { expires, daysToExpiry, status, expiring,
// expired }. reminderDays is the effective window (row override or Config default).
//   - daysToExpiry < 0          → 'פג תוקף'  (expired)   — past the expiry date.
//   - 0 <= daysToExpiry <= win  → 'פג בקרוב' (expiring)  — inside the reminder window (0 = expires today).
//   - else                      → 'בתוקף'    (valid).
function complianceStatus(expiresAt, reminderDays, nowDay) {
  var expires = maintDateOnly(expiresAt);
  var days = maintDaysBetween(nowDay, expires);
  if (expires === '' || days == null) return { expires: '', daysToExpiry: null, status: 'לא ידוע', expiring: false, expired: false };
  if (days < 0) return { expires: expires, daysToExpiry: days, status: 'פג תוקף', expiring: false, expired: true };
  if (days <= reminderDays) return { expires: expires, daysToExpiry: days, status: 'פג בקרוב', expiring: true, expired: false };
  return { expires: expires, daysToExpiry: days, status: 'בתוקף', expiring: false, expired: false };
}

// Parse + validate one Compliance row → normalized object, or null (malformed → logged, skipped).
// idToName is the canonical-id → name map; house must be 'all' or one of its keys. reminder_days blank
// → defaultReminderDays; a NON-blank but invalid reminder_days is logged and also falls back to it.
function parseComplianceRow(row, idToName, defaultReminderDays, log) {
  var idMap = idToName || {};
  var id = String(row && row.id != null ? row.id : '').replace(/^\s+|\s+$/g, '');
  var house = String(row && row.house != null ? row.house : '').replace(/^\s+|\s+$/g, '');
  var item = String(row && row.item != null ? row.item : '').replace(/^\s+|\s+$/g, '');
  if (!id) { if (log) log('compliance: row missing id — skipped'); return null; }
  if (!item) { if (log) log('compliance: item "' + id + '" missing name — skipped'); return null; }
  var expires = maintDateOnly(row ? row.expires_at : '');
  if (!expires) { if (log) log('compliance: item "' + id + '" blank/unparseable expires_at — skipped'); return null; }
  if (house !== 'all' && !Object.prototype.hasOwnProperty.call(idMap, house)) {
    if (log) log('compliance: item "' + id + '" unknown house "' + house + '" — skipped');
    return null;
  }
  var rawReminder = String(row && row.reminder_days != null ? row.reminder_days : '').replace(/^\s+|\s+$/g, '');
  var reminder = complianceNum(rawReminder);
  if (reminder == null) {
    if (rawReminder !== '' && log) log('compliance: item "' + id + '" bad reminder_days "' + rawReminder + '" — using default');
    reminder = defaultReminderDays;
  }
  return {
    id: id, house: house, item: item, expires: expires, reminderDays: reminder,
    docUrl: String(row && row.doc_url != null ? row.doc_url : '').replace(/^\s+|\s+$/g, ''),
    notes: String(row && row.notes != null ? row.notes : ''),
    active: maintActive(row ? row.active : '')
  };
}

// The request-input for a generated renewal. A NORMAL request — it flows through the same approval
// chain + SLA as any request. urgency is דחוף when the item is already expired, else רגיל.
// compliance_id links it back to its Compliance row.
function complianceRequestInput(target) {
  return {
    house: target.houseName,
    category: 'תיקון',
    urgency: target.expired ? 'דחוף' : 'רגיל',
    description: 'חידוש: ' + target.item + ' — ' + target.houseName + ' (עמידה באמות מידה)',
    location_in_house: '',
    estimated_cost: '',
    created_by: 'מערכת - אמות מידה',
    compliance_id: target.complianceId
  };
}

// Statuses that mean a generated renewal request is CLOSED-OUT and no longer blocks a re-generation.
var COMPLIANCE_TERMINAL_ = { 'הושלם': 1, 'סגור': 1, 'לא מאושר': 1 };

// Decide what to generate this pass. Returns { toCreate:[{complianceId,houseId,houseName,item,expired}],
// skippedDuplicate, skippedMalformed, skippedInactive }. An item generates when it is expiring OR
// expired (a valid item does not). It is SKIPPED when a non-terminal (still-open) request already
// exists for the same compliance_id + house — no duplicate open request is ever created. maps:
// { idToName }. defaultReminderDays is the Config default for rows that leave reminder_days blank.
function complianceGenerationPlan(items, requests, openHouseIds, maps, defaultReminderDays, nowDay, log) {
  var idToName = (maps && maps.idToName) || {};
  var openKeys = {};
  for (var r = 0; r < (requests || []).length; r++) {
    var req = requests[r];
    var cid = String(req && req.compliance_id != null ? req.compliance_id : '').replace(/^\s+|\s+$/g, '');
    if (!cid) continue;
    var st = String(req && req.status != null ? req.status : '').replace(/^\s+|\s+$/g, '');
    if (Object.prototype.hasOwnProperty.call(COMPLIANCE_TERMINAL_, st)) continue;
    var hn = String(req && req.house != null ? req.house : '').replace(/^\s+|\s+$/g, '');
    openKeys[cid + '|' + hn] = true;
  }
  var toCreate = [], skippedDuplicate = 0, skippedMalformed = 0, skippedInactive = 0;
  for (var i = 0; i < (items || []).length; i++) {
    var it = parseComplianceRow(items[i], idToName, defaultReminderDays, log);
    if (!it) { skippedMalformed++; continue; }
    if (!it.active) { skippedInactive++; continue; }
    var status = complianceStatus(it.expires, it.reminderDays, nowDay);
    if (!status.expiring && !status.expired) continue;
    var houseIds = expandHouses(it.house, openHouseIds);
    for (var h = 0; h < houseIds.length; h++) {
      var houseId = houseIds[h];
      var houseName = idToName[houseId] || houseId;
      var key = it.id + '|' + houseName;
      if (openKeys[key]) { skippedDuplicate++; continue; }
      toCreate.push({ complianceId: it.id, houseId: houseId, houseName: houseName, item: it.item, expired: status.expired });
      openKeys[key] = true; // guard two rows for the same compliance+house within one pass
    }
  }
  return {
    toCreate: toCreate, skippedDuplicate: skippedDuplicate,
    skippedMalformed: skippedMalformed, skippedInactive: skippedInactive
  };
}

// Compliance-adherence panel data: per-house items (worst-first: expired first, then soonest-to-expire)
// as of nowDay, plus a skipped (malformed) count. Open houses are ALWAYS listed (a house with no active
// compliance row → defined:false → "not defined", never a fabricated 0). maps: { idToName }.
function complianceAdherence(items, maps, openHouseIds, defaultReminderDays, nowDay, log) {
  var idToName = (maps && maps.idToName) || {};
  var openIds = openHouseIds || [];
  var itemsByHouse = {};
  var skipped = 0;
  function ensure(id) {
    if (!Object.prototype.hasOwnProperty.call(itemsByHouse, id)) itemsByHouse[id] = [];
    return itemsByHouse[id];
  }
  for (var o = 0; o < openIds.length; o++) ensure(openIds[o]);
  for (var i = 0; i < (items || []).length; i++) {
    var it = parseComplianceRow(items[i], idToName, defaultReminderDays, log);
    if (!it) { skipped++; continue; }
    if (!it.active) continue;
    var status = complianceStatus(it.expires, it.reminderDays, nowDay);
    var houseIds = expandHouses(it.house, openIds);
    for (var h = 0; h < houseIds.length; h++) {
      ensure(houseIds[h]).push({
        item: it.item, expires: it.expires, reminderDays: it.reminderDays, docUrl: it.docUrl,
        daysToExpiry: status.daysToExpiry, status: status.status, expiring: status.expiring, expired: status.expired
      });
    }
  }
  var houses = [];
  for (var id in itemsByHouse) {
    if (!Object.prototype.hasOwnProperty.call(itemsByHouse, id)) continue;
    var list = itemsByHouse[id];
    list.sort(function (a, b) {
      var ad = a.daysToExpiry == null ? 1e9 : a.daysToExpiry;
      var bd = b.daysToExpiry == null ? 1e9 : b.daysToExpiry;
      if (ad !== bd) return ad - bd; // most-negative (expired worst) first, then soonest
      return a.item < b.item ? -1 : a.item > b.item ? 1 : 0;
    });
    var expiredCount = 0, expiringCount = 0;
    for (var t = 0; t < list.length; t++) {
      if (list[t].expired) expiredCount++;
      else if (list[t].expiring) expiringCount++;
    }
    houses.push({
      id: id, house: idToName[id] || id, defined: list.length > 0,
      items: list, expiredCount: expiredCount, expiringCount: expiringCount
    });
  }
  houses.sort(function (a, b) {
    if (a.expiredCount !== b.expiredCount) return b.expiredCount - a.expiredCount;
    if (a.expiringCount !== b.expiringCount) return b.expiringCount - a.expiringCount;
    return a.house < b.house ? -1 : a.house > b.house ? 1 : 0;
  });
  return { houses: houses, skipped: skipped };
}
// === MIRROR:compliance END ===

// ===== Preventive maintenance (תחזוקה מונעת) — Apps-Script wiring around the pure block above =====

// Canonical ids of the houses that are OPEN (status 'open'). 'all' plans + adherence expand to these.
function openHouseIds_() {
  var houses = getHouses();
  var out = [];
  for (var i = 0; i < houses.length; i++) {
    if (String(houses[i].status).replace(/^\s+|\s+$/g, '') !== 'open') continue;
    var id = DIGEST_HOUSE_IDS_[String(houses[i].name).replace(/^\s+|\s+$/g, '')];
    if (id) out.push(id);
  }
  return out;
}

// Today as 'YYYY-MM-DD' in the script's timezone (server clock). The one impure input to the scan/panel.
function todayYmd_() {
  var d = new Date();
  return d.getFullYear() + '-' + maintPad2(d.getMonth() + 1) + '-' + maintPad2(d.getDate());
}

// Create ONE maintenance request from a generation target. Goes through the SAME pipeline as a
// user-filed request — approval_required + due_at derived, appended, audited. Returns the new id.
function createMaintenanceRequest_(target) {
  var input = maintenanceRequestInput(target);
  var row = buildNewRequest_(input);
  row.plan_id = target.planId;
  row.approval_required = approvalRequiredFor_(row.estimated_cost, row.urgency);
  row.due_at = deriveDueAt(row.created_at, row.urgency, slaSpec_(), function (m) { Logger.log(m); });
  appendRequest(row);
  writeAuditEntry(row.id, '', row.status, 'מערכת - תחזוקה מונעת',
    'נוצר מתוכנית תחזוקה מונעת (plan ' + target.planId + ')');
  return row.id;
}

// The scheduled scan: find due preventive-maintenance tasks AND due/expired compliance items and
// generate their requests (idempotently — never a second OPEN request for the same plan/compliance +
// house). Time-based trigger entry point (see installMaintenanceTrigger). The compliance pass rides on
// this SAME daily trigger — there is no separate compliance trigger to install.
function runMaintenanceScan() {
  var lock = null;
  try { lock = LockService.getScriptLock(); lock.waitLock(30000); } catch (e) { return; }
  try {
    var openIds = openHouseIds_();
    var maps = { idToName: canonicalHouseIdToName_() };
    var today = todayYmd_();
    var requests = getRequests();
    var log = function (m) { Logger.log(m); };

    // Preventive maintenance (תחזוקה מונעת)
    var plan = planGenerationPlan(readObjects_('MaintenancePlan'), requests, openIds, maps, today, log);
    for (var i = 0; i < plan.toCreate.length; i++) createMaintenanceRequest_(plan.toCreate[i]);

    // Compliance (עמידה באמות מידה) — same dedup snapshot of requests; a maintenance request just created
    // carries plan_id (not compliance_id) so it never affects this pass.
    var comp = complianceGenerationPlan(readObjects_('Compliance'), requests, openIds, maps,
      complianceDefaultReminder_(), today, log);
    for (var j = 0; j < comp.toCreate.length; j++) createComplianceRequest_(comp.toCreate[j]);

    if (plan.toCreate.length || comp.toCreate.length) rebuildDigest();
    Logger.log('scan: maintenance created ' + plan.toCreate.length + ' (dup ' + plan.skippedDuplicate +
      ', malformed ' + plan.skippedMalformed + ', inactive ' + plan.skippedInactive + '); compliance created ' +
      comp.toCreate.length + ' (dup ' + comp.skippedDuplicate + ', malformed ' + comp.skippedMalformed +
      ', inactive ' + comp.skippedInactive + ')');
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (e2) {} }
  }
}

// Idempotently (re)install the daily maintenance scan trigger (06:00, script timezone). Same convention
// as installDigestTrigger: delete any existing handler first so re-running never stacks triggers.
function installMaintenanceTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runMaintenanceScan') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runMaintenanceScan').timeBased().everyDays(1).atHour(6).create();
}

// Write a completion date back to a plan row's last_done (the ONE write to the plan sheet). Called from
// both completion paths (setStatus → הושלם and setExecution → בוצע). Idempotent: overwrites with the
// same value on a repeat. No-op when the request is not plan-linked.
function updatePlanLastDone_(request) {
  var back = planLastDoneOnComplete(request);
  if (!back) return;
  var sheet = getSheet_('MaintenancePlan');
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return;
  var headers = data[0];
  var idCol = headers.indexOf('id');
  var lastCol = headers.indexOf('last_done');
  if (idCol === -1 || lastCol === -1) return;
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][idCol]).replace(/^\s+|\s+$/g, '') === back.planId) {
      sheet.getRange(r + 1, lastCol + 1).setValue(back.day);
      return;
    }
  }
}

// Plan-adherence panel for /management (canManage-gated). Derived, read-only; writes nothing.
function readMaintenanceAdherence_() {
  var maps = { idToName: canonicalHouseIdToName_() };
  return planAdherence(readObjects_('MaintenancePlan'), maps, openHouseIds_(), todayYmd_(),
    function (m) { Logger.log(m); });
}

// ===== Compliance (עמידה באמות מידה) — Apps-Script wiring around the MIRROR:compliance block =====

// The seeded default reminder window (days). Used ONLY as the fallback when compliance_reminder_days is
// missing/malformed — it is the documented seed value, not a silent invented default.
var COMPLIANCE_DEFAULT_REMINDER_ = 30;

// Effective Config default reminder window: compliance_reminder_days when valid, else the seed (logged).
function complianceDefaultReminder_() {
  var raw = getConfig('compliance_reminder_days');
  var n = complianceNum(raw);
  if (n != null) return n;
  if (raw != null && String(raw).replace(/^\s+|\s+$/g, '') !== '') {
    Logger.log('compliance: bad compliance_reminder_days "' + raw + '" — using seed default ' + COMPLIANCE_DEFAULT_REMINDER_);
  }
  return COMPLIANCE_DEFAULT_REMINDER_;
}

// Create ONE renewal request from a compliance generation target. Same pipeline as a user-filed request
// (approval_required + due_at derived, appended, audited). urgency comes from the input (דחוף/רגיל).
function createComplianceRequest_(target) {
  var input = complianceRequestInput(target);
  var row = buildNewRequest_(input);
  row.compliance_id = target.complianceId;
  row.approval_required = approvalRequiredFor_(row.estimated_cost, row.urgency);
  row.due_at = deriveDueAt(row.created_at, row.urgency, slaSpec_(), function (m) { Logger.log(m); });
  appendRequest(row);
  writeAuditEntry(row.id, '', row.status, 'מערכת - אמות מידה',
    'נוצר מעמידה באמות מידה (compliance ' + target.complianceId + ')');
  return row.id;
}

// Compliance-adherence panel for /management (canManage-gated). Derived, read-only; writes nothing.
// NOTE: on completion of a renewal request NOTHING is written back to the Compliance row — the new
// expiry lives on the new certificate, so Olga updates expires_at by hand.
function readComplianceAdherence_() {
  var maps = { idToName: canonicalHouseIdToName_() };
  return complianceAdherence(readObjects_('Compliance'), maps, openHouseIds_(),
    complianceDefaultReminder_(), todayYmd_(), function (m) { Logger.log(m); });
}

// Current month as YYYY-MM (server clock).
function currentPeriod_() {
  var d = new Date();
  return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2);
}

// Budget adherence panel for the selected (or current) period. Financial — returned ONLY here, inside
// the canManage gate, and NEVER written to any digest.
function readBudgetAdherence_(period, requests) {
  var maps = { nameToId: DIGEST_HOUSE_IDS_, idToName: canonicalHouseIdToName_() };
  var wanted = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(period || '')) ? String(period) : currentPeriod_();
  var budgets = readObjects_('Budgets');
  var reqs = requests || getRequests();
  return {
    period: wanted,
    periods: budgetPeriods(budgets, reqs, maps, currentPeriod_()),
    adherence: computeAdherence(budgets, reqs, maps, wanted, function (m) { Logger.log(m); }),
  };
}

// ===== /management (increment 37) — exec network-management view for ops_manager + ceo =====
// Role-gated HERE (not UI-only): a request from any other role — including field_ops — is refused
// 403 before any data is read. Served as a POST so the token identity is verified (doGet is not
// identity-checked). Reads Logistics-owned sheets, PLUS the ezone-kitchen digest READ-ONLY (never
// written) for the food-shortages panel. It writes nothing to any app. Budget/actual figures are
// returned here (financial) but are NEVER written to any digest.
function handleManagementData_(p, actor) {
  if (!canManage(actor.role)) return forbidden_();
  var requests = getRequests();
  return jsonOut_({
    ok: true,
    data: {
      requests: requests,
      inspections: readObjects_('Inspections'),
      findings: readObjects_('InspectionFindings'),
      houses: getHouses(),
      inventoryItems: readObjects_('InventoryItems'),
      inventoryCounts: readObjects_('InventoryCounts'),
      kitchen: readKitchenShortages_(),
      coordinators: readCoordinatorsShortages_(),
      budget: readBudgetAdherence_(p && p.period, requests),
      maintenance: readMaintenanceAdherence_(),
      compliance: readComplianceAdherence_(),
    },
  });
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
  row.approval_required = approvalRequiredFor_(row.estimated_cost, row.urgency);
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
  fields.approval_required = approvalRequiredFor_(merged.estimated_cost, merged.urgency);
  // Re-derive due_at when urgency changes (increment 36) — from the original created_at (an edit
  // happens pre-approval, before any deferral, so creation is the correct base).
  if (fields.urgency != null) {
    fields.due_at = deriveDueAt(req.created_at, merged.urgency, slaSpec_(), function (m) { Logger.log(m); });
  }
  updateRequest_(p.id, fields, req.status, req.status, actor.name, 'נערך ע"י ' + actor.name);
  rebuildDigest();
  return jsonOut_({ ok: true });
}

// ===== Inventory module — WEEKLY stock count per house (מלאי) =====

var INVENTORY_CATEGORIES_ = ['טואלטיקה', 'חומרי ניקוי'];
var INVENTORY_COUNTERS_ = ['שירה', 'יעקב', 'אורן', 'אביב', 'צחי', 'רועי', 'רמי'];

// ---- Units + par (increment 33) — mirror of src/inventory.js (server is the real gate) ----
// Par is a FLAT weekly par per house. No occupancy scaling — Logistics has no occupancy source until
// the Dashboard publishes one (a separate build-order item); par scaling is added THEN, not guessed.
var BASE_UNITS_ = ['kg', 'g', 'l', 'ml', 'unit'];

// "label:factor|label:factor|…" → [{label, factor}] (first = default), or null when empty/malformed
// (empty label, missing colon, or factor not a finite number > 0). null = do not trust these units.
function parseAllowedUnits_(spec) {
  if (typeof spec !== 'string' || spec.trim() === '') return null;
  var parts = spec.split('|');
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var seg = parts[i].trim();
    if (seg === '') return null;
    var idx = seg.lastIndexOf(':');
    if (idx <= 0 || idx === seg.length - 1) return null;
    var label = seg.slice(0, idx).trim();
    var factor = Number(seg.slice(idx + 1).trim());
    if (!label || !isFinite(factor) || factor <= 0) return null;
    out.push({ label: label, factor: factor });
  }
  return out.length ? out : null;
}

// One InventoryItems row → validated unit descriptor. A row that declares no units reads as unitless
// with no par (legacy/retired rows — not an error). A bad base_unit or malformed allowed_units → the
// item is unitless AND logged (never coerced to a guessed default). par_base is a number ≥ 0 or null.
function resolveItemUnit_(row) {
  var rawBase = row && row.base_unit != null ? String(row.base_unit).trim() : '';
  var rawAllowed = row && row.allowed_units != null ? String(row.allowed_units).trim() : '';
  var rawPar = row && row.par_base != null ? String(row.par_base).trim() : '';
  var item = row && row.item_text != null ? String(row.item_text) : '';

  var parBase = null;
  if (rawPar !== '') {
    var p = Number(rawPar);
    if (isFinite(p) && p >= 0) parBase = p;
    else Logger.log('inventory: par_base is not a number ≥ 0 for "' + item + '" — treated as no par');
  }

  var unitless = { unitless: true, base_unit: null, units: [], defaultUnit: null, par_base: parBase };
  if (rawBase === '' && rawAllowed === '') return unitless;

  if (BASE_UNITS_.indexOf(rawBase) === -1) {
    Logger.log('inventory: unknown base_unit "' + rawBase + '" for "' + item + '" — treated as unitless');
    return unitless;
  }
  var units = parseAllowedUnits_(rawAllowed);
  if (!units) {
    Logger.log('inventory: malformed allowed_units "' + rawAllowed + '" for "' + item + '" — treated as unitless');
    return unitless;
  }
  return { unitless: false, base_unit: rawBase, units: units, defaultUnit: units[0], par_base: parBase };
}

// Freeze the unit onto a count row: {unit_label, unit_factor}. Unitless item / unmatched label →
// factor 1; a unit item with an unmatched/blank label falls back to the DEFAULT (first) option.
function unitForCount_(desc, requestedLabel) {
  if (!desc || desc.unitless || !desc.units || desc.units.length === 0) {
    return { unit_label: '', unit_factor: 1 };
  }
  var chosen = null;
  for (var i = 0; i < desc.units.length; i++) {
    if (desc.units[i].label === requestedLabel) { chosen = desc.units[i]; break; }
  }
  if (!chosen) chosen = desc.defaultUnit || desc.units[0];
  return { unit_label: chosen.label, unit_factor: chosen.factor };
}

function computeQuantityBase_(quantity, factor) {
  var q = Number(quantity), f = Number(factor);
  if (!isFinite(q) || !isFinite(f)) return null;
  return q * f;
}

// item_text → resolved unit descriptor for the active catalog (used by submit + digest).
function itemUnitMap_() {
  var rows = readObjects_('InventoryItems');
  var out = {};
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!r || !r.item_text) continue;
    out[String(r.item_text)] = resolveItemUnit_(r);
  }
  return out;
}

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
      unit_label: it.unit_label, unit_factor: it.unit_factor, quantity_base: it.quantity_base,
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

  // Resolve units from the LIVE catalog: the factor is derived here (submit time) from the item's
  // current allowed_units and then FROZEN onto the row — never re-derived later, because labels and
  // factors are edited in the sheet. quantity stays exactly what the counter typed.
  var unitMap = itemUnitMap_();

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
    var chosen = unitForCount_(unitMap[String(it.item)], it.unit_label);
    filled.push({
      category: it.category, item: it.item, quantity: n, notes: String(it.notes || '').slice(0, 500),
      unit_label: chosen.unit_label, unit_factor: chosen.unit_factor,
      quantity_base: computeQuantityBase_(n, chosen.unit_factor),
    });
  }
  if (filled.length === 0) return jsonOut_({ ok: false, error: 'No quantities filled' });

  var res = writeInventoryRows_(
    p.house, p.week_start, p.counted_by, filled, 'ספירת מלאי',
    'ספירה שבועית ' + p.week_start + ' — ' + p.house + ' (' + filled.length + ' פריטים)');
  return jsonOut_({ ok: true, count_id: res.count_id, items: res.items });
}
