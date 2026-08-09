// edit.js — pure rules for editing and deleting requests (increment 5).
// Mirrored in Code.gs. Edit is allowed only BEFORE approval so the §6 routing can't be bypassed
// by changing the cost after approval; delete is Roy/Sandra only, one quick (audited) action.

import { STATUSES, CATEGORY } from './schema.js';
import { canManage } from './roles.js';

export const DELETERS = ['רועי', 'sandra'];
export const EDITABLE_STATUSES = [STATUSES.REQUEST, STATUSES.PENDING_APPROVAL];
export const EDITABLE_FIELDS = ['description', 'location_in_house', 'category', 'urgency', 'estimated_cost', 'house'];
export const CATEGORIES = [CATEGORY.PURCHASE, CATEGORY.REPAIR, CATEGORY.REPLACEMENT];

export function canDelete(by) {
  return DELETERS.includes(by);
}

export function canEdit(status) {
  return EDITABLE_STATUSES.includes(status);
}

// A category correction (e.g. רכישה→תיקון when a coordinator asked to BUY but the item can be
// REPAIRED) is a manager-side decision, NOT a field-level tweak: only management (ops_manager / ceo)
// may change a request's category. Mirror of Code.gs isManagement_ (via canManage). The other
// EDITABLE_FIELDS keep the shared pre-approval edit rule (canEdit).
export function canEditCategory(role) {
  return canManage(role);
}

// True when an edit payload actually CHANGES the category: a new value is present, differs from the
// current one, and is a known category. A no-op re-send of the same category is not a change (so it
// neither triggers the manager gate nor writes a category-change audit line).
export function isCategoryChange(fromCategory, toCategory) {
  if (toCategory == null || String(toCategory) === '') return false;
  if (CATEGORIES.indexOf(String(toCategory)) === -1) return false;
  return String(fromCategory == null ? '' : fromCategory) !== String(toCategory);
}

// The AuditLog note for a category correction, so the change reads as a category change in the log
// rather than a generic "edited". Mirror in Code.gs handleEditRequest_.
export function categoryChangeNote(fromCategory, toCategory, by) {
  const from = fromCategory == null || fromCategory === '' ? '—' : fromCategory;
  const to = toCategory == null || toCategory === '' ? '—' : toCategory;
  return 'קטגוריה שונתה: ' + from + ' → ' + to + ' (' + (by || '') + ')';
}
