// approval.js — the heart of the app: approval routing (chain B) + status-transition rules.
//
// PURE, dependency-free module (no imports, no Apps Script APIs) so node:test verifies every rule
// directly. The chain-B routing block is mirrored VERBATIM (logic-for-logic) inside
// apps-script/Code.gs; a guard test (test/mirror-drift.test.js) asserts the two copies stay in sync.
//
// Chain B (increment 30) — replaces the Inc-10/Inc-14 "Roy approves alone" routing. Evaluate in
// order and return the ROLE (not a person's name):
//   1. urgency = חירום            → 'auto' (auto-approved, emergency bypass, no human approver)
//   2. house is טרום-פתיחה, OR ceo_ceiling set and cost exceeds it → 'ceo'
//   3. cost > approval_threshold  → 'ops_manager'
//   4. otherwise (incl. blank/unknown cost) → 'field_ops'
// Deferral stays field_ops at any amount; on wake-up the amount is re-checked through rules 1–4.

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

// ---- Status transition validation (inline Hebrew statuses so this module stays dependency-free) ----
var S = {
  REQUEST: 'דרישה',
  PENDING_APPROVAL: 'ממתין לאישור',
  APPROVED: 'מאושר',
  NOT_APPROVED: 'לא מאושר',
  DEFERRED: 'נדחה לתאריך',
  IN_PROGRESS: 'בביצוע',
  COMPLETED: 'הושלם',
  CLOSED: 'סגור',
};

// Allowed status transitions. Each key = from-status, value = set of legal to-statuses.
var TRANSITIONS = {};
TRANSITIONS[S.REQUEST] = new Set([S.PENDING_APPROVAL, S.APPROVED, S.NOT_APPROVED, S.DEFERRED]);
TRANSITIONS[S.PENDING_APPROVAL] = new Set([S.APPROVED, S.NOT_APPROVED, S.DEFERRED]);
TRANSITIONS[S.DEFERRED] = new Set([S.APPROVED, S.NOT_APPROVED, S.DEFERRED]); // wake-up: re-decide
TRANSITIONS[S.APPROVED] = new Set([S.IN_PROGRESS]);                          // no separate "assigned"
TRANSITIONS[S.IN_PROGRESS] = new Set([S.COMPLETED]);
TRANSITIONS[S.COMPLETED] = new Set([S.CLOSED]);
TRANSITIONS[S.NOT_APPROVED] = new Set([]); // terminal
TRANSITIONS[S.CLOSED] = new Set([]);       // terminal

function canTransition(fromStatus, toStatus) {
  var allowed = TRANSITIONS[fromStatus];
  return !!allowed && allowed.has(toStatus);
}

export {
  APPROVER, URGENCY_EMERGENCY, HOUSE_PRE_OPENING_HE, HOUSE_PRE_OPENING_EN,
  costIsBlank, isPreOpening, ceilingIsSet, whoApproves, approvalRequired, canTransition,
};
