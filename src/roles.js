// roles.js — role constants + permission predicates for the identity-based auth (increment 30).
//
// PURE, dependency-free module. Mirrored VERBATIM (logic-for-logic) inside apps-script/Code.gs
// so the SAME permission rules are enforced on the public /exec endpoint — the Node layer is
// never trusted. A guard test (test/mirror-drift.test.js) asserts the two copies stay in sync.
//
// The four roles the app knows (ceo removed in PR 2). Identity + role ride inside the signed session token; every
// enforced action resolves the actor from that token, never from a client-supplied field.

// === MIRROR:roles START ===
var ROLE = {
  COORDINATOR: 'coordinator',
  MAINTENANCE: 'maintenance',
  FIELD_OPS: 'field_ops',
  OPS_MANAGER: 'ops_manager',
};

var ROLES = [ROLE.COORDINATOR, ROLE.MAINTENANCE, ROLE.FIELD_OPS, ROLE.OPS_MANAGER];

function isRole(role) {
  return ROLES.indexOf(role) !== -1;
}

// approve / reject: the ops_manager (אולגה) is THE approver. Chain B v3 routes every non-emergency
// request to ops_manager, and the approve/reject write is additionally gated by the APPROVER_CODE
// (server.js + Code.gs), so the role alone never approves. requiredRole is the whoApproves() result.
// The ceo role was removed (PR 2): no other role approves anything.
function canApprove(actorRole, requiredRole) {
  return actorRole === ROLE.OPS_MANAGER && requiredRole === ROLE.OPS_MANAGER;
}

// defer: field_ops, ops_manager (a "this can wait" call, not the money decision).
function canDefer(actorRole) {
  return actorRole === ROLE.FIELD_OPS || actorRole === ROLE.OPS_MANAGER;
}

// assignment / dispatch (assign, batch-assign, mark-external, set-status, set-execution):
// field_ops, ops_manager.
function canDispatch(actorRole) {
  return actorRole === ROLE.FIELD_OPS || actorRole === ROLE.OPS_MANAGER;
}

// block / unblock a request (increment 36): field_ops, ops_manager. A coordinator/maintenance
// gets 403 — same tier boundary as defer/dispatch.
function canBlock(actorRole) {
  return actorRole === ROLE.FIELD_OPS || actorRole === ROLE.OPS_MANAGER;
}

// Manager tier (tier A) — sees ALL houses and holds the dispatch powers. field_ops / ops_manager.
// Everyone else (coordinator, maintenance) is the restricted tier B.
function isManagerRole(role) {
  return role === ROLE.FIELD_OPS || role === ROLE.OPS_MANAGER;
}

// /management screen (increment 37): the NETWORK-MANAGEMENT view for Olga (ops_manager) only.
// NARROWER than isManagerRole — field_ops (Roy) is a manager tier for dispatch but is NOT an exec, so
// he gets 403 here. Enforced server-side AND in Code.gs, never UI-only.
function canManage(role) {
  return role === ROLE.OPS_MANAGER;
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

export { ROLE, ROLES, isRole, canApprove, canDefer, canDispatch, canBlock, canManage, isManagerRole, houseInScope };
