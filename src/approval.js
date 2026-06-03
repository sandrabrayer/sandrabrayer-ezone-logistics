// approval.js — the heart of the app: approval routing + status-transition rules.
//
// PURE module (no Apps Script APIs) so node:test verifies every rule directly. Code.gs mirrors
// whoApproves / canApprove and calls these rules, then writes AuditLog + the row.
//
// §6 of the spec (locked): routing depends ONLY on amount, every time — first arrival AND
// deferred wake-up. ≤ threshold → Roy; > threshold → Sandra; emergency bypasses entirely;
// defer is Roy at any amount; blank cost falls under threshold (Roy).

import { STATUSES, URGENCY } from './schema.js';

export const APPROVERS = { ROY: 'רועי', SANDRA: 'sandra' };

/**
 * Is the cost effectively blank/unknown? Blank routes under the threshold (Roy).
 */
function costIsBlank(cost) {
  return cost === '' || cost === null || cost === undefined;
}

/**
 * Who is authorized to approve this request for execution, by amount + urgency.
 * @returns {'auto'|'roy'|'sandra'} 'auto' = emergency bypass (no human approval needed)
 */
export function whoApproves(cost, urgency, threshold) {
  if (urgency === URGENCY.EMERGENCY) return 'auto';
  if (costIsBlank(cost)) return 'roy';          // unknown cost → under threshold → Roy
  return Number(cost) > Number(threshold) ? 'sandra' : 'roy';
}

/**
 * Derived approval_required flag (§6): TRUE when cost > threshold AND not emergency.
 */
export function approvalRequired(cost, urgency, threshold) {
  if (urgency === URGENCY.EMERGENCY) return false;
  if (costIsBlank(cost)) return false;
  return Number(cost) > Number(threshold);
}

/**
 * Can THIS approver approve THIS request? Roy cannot approve above threshold; Sandra can.
 * Emergency needs no human, but if a human does act, either may (it's already auto-approved).
 */
export function canApprove(approver, cost, urgency, threshold) {
  const who = whoApproves(cost, urgency, threshold);
  if (who === 'auto') return true;
  if (who === 'sandra') return approver === APPROVERS.SANDRA;
  return approver === APPROVERS.ROY || approver === APPROVERS.SANDRA; // Roy's tier; Sandra may too
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
 * @param {object} req      the current request row (needs status, estimated_cost, urgency)
 * @param {string} approver who is acting (APPROVERS value)
 * @param {number} threshold
 */
export function validateApproval(req, approver, threshold) {
  if (!canTransition(req.status, S.APPROVED)) {
    throw new Error(`Cannot approve a request in status "${req.status}"`);
  }
  if (!canApprove(approver, req.estimated_cost, req.urgency, threshold)) {
    throw new Error('Approver not authorized for this amount (above threshold requires Sandra)');
  }
  return S.APPROVED;
}
