// roles.js — role constants + permission predicates for the identity-based auth (increment 30).
//
// PURE, dependency-free module. Mirrored VERBATIM (logic-for-logic) inside apps-script/Code.gs
// so the SAME permission rules are enforced on the public /exec endpoint — the Node layer is
// never trusted. A guard test (test/mirror-drift.test.js) asserts the two copies stay in sync.
//
// The five roles the app knows. Identity + role ride inside the signed session token; every
// enforced action resolves the actor from that token, never from a client-supplied field.

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

export { ROLE, ROLES, isRole, canApprove, canDefer, canDispatch };
