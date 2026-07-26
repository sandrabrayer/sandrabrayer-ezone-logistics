// approval.js — the heart of the app: approval routing + status-transition rules.
//
// PURE module (no Apps Script APIs) so node:test verifies every rule directly. Code.gs mirrors
// resolveApprover / approvalRequired / canApprove and calls these rules, then writes AuditLog +
// the row. src/roles.js owns the per-action authorization matrix; this file owns WHO the chain
// resolves to for a given request.
//
// APPROVAL CHAIN (§6, increment 28 — replaces the old Roy→Sandra threshold split). Evaluated
// in order for every arrival AND every deferred wake-up:
//   a. urgency = חירום            → 'auto' (emergency bypass, no human approval needed)
//   b. house is טרום-פתיחה (pre-opening)  OR  (ceo_ceiling set AND cost > ceo_ceiling)  → ceo
//   c. cost > approval_threshold  → ops_manager
//   d. otherwise (incl. blank cost) → field_ops
// Deferral (נדחה לתאריך) is always field_ops for any amount; on wake-up the amount is re-checked
// through a–d exactly as on first arrival.

import { STATUSES, URGENCY, ROLES } from './schema.js';

/** Is the cost effectively blank/unknown? Blank never crosses any ceiling → routes to field_ops. */
function costIsBlank(cost) {
  return cost === '' || cost === null || cost === undefined;
}

/** Is a config ceiling actually set? Blank ('') means the ceiling is disabled. */
function ceilingSet(v) {
  return !(v === '' || v === null || v === undefined);
}

/**
 * Who is authorized to approve this request, by the chain a–d above.
 * @param {number|string} cost           estimated_cost (blank allowed)
 * @param {string} urgency               URGENCY value
 * @param {boolean} housePreOpening      is the request's house טרום-פתיחה?
 * @param {number|string} threshold      approval_threshold
 * @param {number|string} ceoCeiling     ceo_ceiling ('' = disabled)
 * @returns {'auto'|'ceo'|'ops_manager'|'field_ops'}
 */
export function resolveApprover(cost, urgency, housePreOpening, threshold, ceoCeiling) {
  // a. emergency bypasses approval entirely.
  if (urgency === URGENCY.EMERGENCY) return 'auto';
  // b. pre-opening house, or an explicitly-set CEO ceiling that the cost exceeds → CEO.
  if (housePreOpening) return ROLES.CEO;
  if (ceilingSet(ceoCeiling) && !costIsBlank(cost) && Number(cost) > Number(ceoCeiling)) {
    return ROLES.CEO;
  }
  // c. above the approval threshold → ops manager.
  if (!costIsBlank(cost) && Number(cost) > Number(threshold)) return ROLES.OPS_MANAGER;
  // d. everything else, including blank/unknown cost → field ops.
  return ROLES.FIELD_OPS;
}

/**
 * Derived approval_required flag: TRUE when the request needs escalated (above-field_ops)
 * approval — i.e. the chain resolves to ops_manager or ceo. Emergency ('auto') and the
 * field_ops base tier are FALSE.
 */
export function approvalRequired(cost, urgency, housePreOpening, threshold, ceoCeiling) {
  const who = resolveApprover(cost, urgency, housePreOpening, threshold, ceoCeiling);
  return who === ROLES.OPS_MANAGER || who === ROLES.CEO;
}

/**
 * Can a user with `role` approve/reject a request whose chain resolved to `resolvedApprover`?
 * CEO can approve anything; emergency ('auto') is already approved so any actor may confirm;
 * otherwise the role must be exactly the resolved approver.
 */
export function canApprove(role, resolvedApprover) {
  if (role === ROLES.CEO) return true;
  if (resolvedApprover === 'auto') return true;
  return role === resolvedApprover;
}

// ---- Status transition validation ----
const S = STATUSES;

// Allowed status transitions. Each key = from-status, value = set of legal to-statuses.
const TRANSITIONS = {
  [S.REQUEST]:          new Set([S.PENDING_APPROVAL, S.APPROVED, S.NOT_APPROVED, S.DEFERRED]),
  [S.PENDING_APPROVAL]: new Set([S.APPROVED, S.NOT_APPROVED, S.DEFERRED]),
  [S.DEFERRED]:         new Set([S.APPROVED, S.NOT_APPROVED, S.DEFERRED]), // wake-up: re-decide
  [S.APPROVED]:         new Set([S.IN_PROGRESS]),                          // no separate "assigned"
  [S.IN_PROGRESS]:      new Set([S.COMPLETED]),
  [S.COMPLETED]:        new Set([S.CLOSED]),
  [S.NOT_APPROVED]:     new Set([]),  // terminal
  [S.CLOSED]:           new Set([]),  // terminal
};

/**
 * Is moving from -> to a legal transition?
 */
export function canTransition(fromStatus, toStatus) {
  const allowed = TRANSITIONS[fromStatus];
  return !!allowed && allowed.has(toStatus);
}

/**
 * Validate an approval action and return the resulting status, or throw with a clear reason.
 * Used by Code.gs before it writes the row + audit entry.
 *
 * @param {object} req   the current request row (needs status)
 * @param {string} role  the acting user's role
 * @param {'auto'|'ceo'|'ops_manager'|'field_ops'} resolvedApprover  chain result for this request
 */
export function validateApproval(req, role, resolvedApprover) {
  if (!canTransition(req.status, S.APPROVED)) {
    throw new Error(`Cannot approve a request in status "${req.status}"`);
  }
  if (!canApprove(role, resolvedApprover)) {
    throw new Error('Role is not the resolved approver for this request');
  }
  return S.APPROVED;
}
