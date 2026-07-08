// edit.js — pure rules for editing and deleting requests (increment 5).
// Mirrored in Code.gs. Edit is allowed only BEFORE approval so the §6 routing can't be bypassed
// by changing the cost after approval; delete is Roy/Sandra only, one quick (audited) action.

import { STATUSES } from './schema.js';

export const DELETERS = ['רועי', 'sandra'];
export const EDITABLE_STATUSES = [STATUSES.REQUEST, STATUSES.PENDING_APPROVAL];
export const EDITABLE_FIELDS = ['description', 'location_in_house', 'category', 'urgency', 'estimated_cost', 'house'];

export function canDelete(by) {
  return DELETERS.includes(by);
}

export function canEdit(status) {
  return EDITABLE_STATUSES.includes(status);
}
