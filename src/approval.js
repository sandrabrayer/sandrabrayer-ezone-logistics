// approval.js — the heart of the app: approval routing (chain B) + status-transition rules.
//
// PURE, dependency-free module (no imports, no Apps Script APIs) so node:test verifies every rule
// directly. The chain-B routing block is mirrored VERBATIM (logic-for-logic) inside
// apps-script/Code.gs; a guard test (test/mirror-drift.test.js) asserts the two copies stay in sync.
//
// Chain B v2 (increment 31) — routing by AMOUNT only. Evaluate in order and return the ROLE:
//   1. urgency = חירום            → 'auto' (auto-approved, emergency bypass, no human approver)
//   2. cost > approval_threshold  → 'ops_manager'
//   3. otherwise (incl. blank/unknown cost) → 'field_ops'
// The increment-30 pre-opening→ceo and ceo_ceiling branches are REMOVED: pre-opening houses route
// by amount exactly like open houses. The ceo role constant and the ceo_ceiling Config key are kept
// but are DORMANT — nothing in routing reads them. Deferral stays field_ops at any amount; on
// wake-up the amount is re-checked through rules 1–3.

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
  APPROVER, URGENCY_EMERGENCY, costIsBlank, whoApproves, approvalRequired, canTransition,
};
