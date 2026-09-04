// approval.js — the heart of the app: approval routing (chain B) + status-transition rules.
//
// PURE, dependency-free module (no imports, no Apps Script APIs) so node:test verifies every rule
// directly. The chain-B routing block is mirrored VERBATIM (logic-for-logic) inside
// apps-script/Code.gs; a guard test (test/mirror-drift.test.js) asserts the two copies stay in sync.
//
// Chain B v3 (PR 2) — אולגה approves everything. Evaluate in order and return the ROLE:
//   1. urgency = חירום → 'auto' (auto-approved, emergency bypass, no human approver)
//   2. everything else → 'ops_manager'
// No amount tier, no house-status branch, no ceo: the field_ops approval tier (≤ approval_threshold)
// and the ceo role are REMOVED. `approval_threshold` stays in Config as a LEGACY key that nothing in
// routing reads. A deferral wake-up re-routes through the same two rules.

// === MIRROR:approval START ===
var URGENCY_EMERGENCY = 'חירום';

var APPROVER = { AUTO: 'auto', OPS_MANAGER: 'ops_manager' };

// Which ROLE must approve this request. Chain B v3 (PR 2): two rules, no amount, no house status.
//   1. urgency = חירום → 'auto' (auto-approved, emergency bypass, no human approver)
//   2. everything else → 'ops_manager' (אולגה approves everything)
// approval_threshold is NOT consulted (legacy Config key). A deferral wake-up re-routes through the
// same two rules. The cost argument is kept for call-site stability but is not read.
function whoApproves(cost, urgency) {
  if (urgency === URGENCY_EMERGENCY) return APPROVER.AUTO;
  return APPROVER.OPS_MANAGER;
}

// Derived approval_required flag — TRUE when a human (ops_manager) must approve; FALSE only for the
// emergency auto path.
function approvalRequired(cost, urgency) {
  return whoApproves(cost, urgency) === APPROVER.OPS_MANAGER;
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
  APPROVER, URGENCY_EMERGENCY, whoApproves, approvalRequired, canTransition,
};
