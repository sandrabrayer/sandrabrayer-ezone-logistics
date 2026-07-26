// roles.js — user identity, house-scoping, and the server-side authorization matrix (increment 28).
//
// PURE module (no Apps Script APIs) so node:test verifies every rule directly. Code.gs mirrors
// isActive_/findUser_/userCoversHouse_/authorizeAction_. Drift between the two has caused bugs
// before — keep them in sync.
//
// Fail-closed is the contract: an unknown or inactive user is authorized for NOTHING. Every
// write path (approve/reject/defer/assign/inventory/create) runs through authorizeAction.

import { ROLES, ALL_HOUSES_MARK, CLUSTER_SCOPE_PREFIX } from './schema.js';

export { ROLES };
export const ALL_ROLES = Object.values(ROLES);

// Truthy spellings accepted for the Users `active` column (Sheet stores strings; tests use bools).
const TRUE_STRINGS = new Set(['true', 'TRUE', 'True', '1', 'yes', 'YES']);

/** Is this user active? Handles both the Sheet's string 'TRUE' and a real boolean. Fail-closed. */
export function isActive(user) {
  if (!user) return false;
  const a = user.active;
  if (a === true) return true;
  return TRUE_STRINGS.has(String(a).trim());
}

/** Look up a user by name in a Users list. Returns the row object or null. */
export function findUser(users, name) {
  if (!Array.isArray(users) || name == null || name === '') return null;
  for (const u of users) {
    if (u && String(u.name) === String(name)) return u;
  }
  return null;
}

/**
 * Does this user's scope cover `house`?
 *  - '*'              → every house
 *  - 'cluster:a+b'    → houses whose cluster is in {a, b} (needs housesByName for the lookup)
 *  - literal name     → exactly that house (coordinators, own house only)
 * @param {object} user
 * @param {string} house              the request's house name
 * @param {Record<string,object>} housesByName  name → house row ({ cluster, ... }); optional
 */
export function userCoversHouse(user, house, housesByName) {
  if (!user) return false;
  const scope = user.house;
  if (scope === ALL_HOUSES_MARK) return true;
  if (typeof scope === 'string' && scope.startsWith(CLUSTER_SCOPE_PREFIX)) {
    const clusters = scope.slice(CLUSTER_SCOPE_PREFIX.length).split('+').filter(Boolean);
    const h = housesByName && housesByName[house];
    return !!h && clusters.includes(h.cluster);
  }
  return String(scope) === String(house);
}

// Roles allowed for the non-approval write actions (approval is dynamic; see below).
const DEFER_ASSIGN_ROLES = new Set([ROLES.FIELD_OPS, ROLES.OPS_MANAGER, ROLES.CEO]);
const INVENTORY_ROLES = new Set([
  ROLES.COORDINATOR, ROLES.MAINTENANCE, ROLES.FIELD_OPS, ROLES.OPS_MANAGER, ROLES.CEO,
]);

/**
 * Authorize a write action for a user. Returns null when allowed, else a Hebrew error string.
 * The caller resolves the approver first (src/approval.js resolveApprover) and passes it in
 * ctx.resolvedApprover for approve/reject.
 *
 * @param {object|null} user  Users row ({ name, role, house, active }) or null (unknown)
 * @param {'create'|'approve'|'reject'|'defer'|'assign'|'inventory'} action
 * @param {object} ctx  { house, housesByName, resolvedApprover }
 * @returns {string|null}
 */
export function authorizeAction(user, action, ctx = {}) {
  // Fail-closed identity gate: unknown, inactive, or unrecognized role → nothing is allowed.
  if (!user) return 'משתמש לא מוכר';
  if (!isActive(user)) return 'משתמש אינו פעיל';
  if (!ALL_ROLES.includes(user.role)) return 'תפקיד לא מוכר';

  const coordinatorOffHouse =
    user.role === ROLES.COORDINATOR && !userCoversHouse(user, ctx.house, ctx.housesByName);

  switch (action) {
    case 'create':
      // Any active user may create; a coordinator only for their own house.
      if (coordinatorOffHouse) return 'רכז/ת מוגבל/ת לבית שלו/ה';
      return null;

    case 'approve':
    case 'reject': {
      if (user.role === ROLES.CEO) return null; // CEO may approve/reject anything
      const who = ctx.resolvedApprover;
      if (who === 'auto') return null; // emergency is already auto-approved; any active user may confirm
      if (user.role !== who) return 'התפקיד אינו המאשר הנדרש לבקשה זו';
      return null;
    }

    case 'defer':
    case 'assign':
      if (!DEFER_ASSIGN_ROLES.has(user.role)) return 'התפקיד אינו מורשה לפעולה זו';
      return null;

    case 'inventory':
      if (!INVENTORY_ROLES.has(user.role)) return 'התפקיד אינו מורשה להגשת ספירה';
      if (coordinatorOffHouse) return 'רכז/ת מוגבל/ת לבית שלו/ה';
      return null;

    default:
      return 'פעולה לא מוכרת';
  }
}
