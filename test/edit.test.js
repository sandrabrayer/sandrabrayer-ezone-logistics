// test/edit.test.js — locks delete authority + edit-before-approval rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canDelete, canEdit, EDITABLE_FIELDS,
  canEditCategory, isCategoryChange, categoryChangeNote, CATEGORIES,
} from '../src/edit.js';
import { STATUSES, CATEGORY } from '../src/schema.js';

test('only Roy or Sandra can delete', () => {
  assert.equal(canDelete('רועי'), true);
  assert.equal(canDelete('sandra'), true);
  assert.equal(canDelete('רמי'), false);
  assert.equal(canDelete('צחי'), false);
});

test('edit allowed only before approval', () => {
  assert.equal(canEdit(STATUSES.REQUEST), true);
  assert.equal(canEdit(STATUSES.PENDING_APPROVAL), true);
  // after approval (or any later/terminal state) — locked
  assert.equal(canEdit(STATUSES.APPROVED), false);
  assert.equal(canEdit(STATUSES.IN_PROGRESS), false);
  assert.equal(canEdit(STATUSES.COMPLETED), false);
  assert.equal(canEdit(STATUSES.CLOSED), false);
  assert.equal(canEdit(STATUSES.DEFERRED), false);
});

test('editable fields include cost and scope but not lifecycle/approval fields', () => {
  assert.ok(EDITABLE_FIELDS.includes('estimated_cost'));
  assert.ok(EDITABLE_FIELDS.includes('description'));
  assert.ok(EDITABLE_FIELDS.includes('house'));
  // must NOT allow editing these directly
  assert.equal(EDITABLE_FIELDS.includes('status'), false);
  assert.equal(EDITABLE_FIELDS.includes('approved_by'), false);
  assert.equal(EDITABLE_FIELDS.includes('id'), false);
});

// ---- Category correction (רכישה→תיקון): manager-only, audited as a category change ----

test('category is an editable field, so a correction is possible via the edit modal', () => {
  assert.ok(EDITABLE_FIELDS.includes('category'));
  assert.deepEqual(CATEGORIES, [CATEGORY.PURCHASE, CATEGORY.REPAIR, CATEGORY.REPLACEMENT]);
});

test('only management (ops_manager / ceo) may change a category', () => {
  assert.equal(canEditCategory('ops_manager'), true);
  assert.equal(canEditCategory('ceo'), true);
  // field_ops can edit other fields pre-approval but NOT correct the category
  assert.equal(canEditCategory('field_ops'), false);
  assert.equal(canEditCategory('coordinator'), false);
  assert.equal(canEditCategory('maintenance'), false);
});

test('isCategoryChange is true only for a real change to a valid category', () => {
  // רכישה → תיקון (the fridge example): a real correction
  assert.equal(isCategoryChange(CATEGORY.PURCHASE, CATEGORY.REPAIR), true);
  // same category re-sent → not a change (no gate, no special audit line)
  assert.equal(isCategoryChange(CATEGORY.REPAIR, CATEGORY.REPAIR), false);
  // blank / missing new value → not a change (an edit that leaves category alone)
  assert.equal(isCategoryChange(CATEGORY.PURCHASE, ''), false);
  assert.equal(isCategoryChange(CATEGORY.PURCHASE, null), false);
  assert.equal(isCategoryChange(CATEGORY.PURCHASE, undefined), false);
  // an unknown / bogus category is never accepted as a change
  assert.equal(isCategoryChange(CATEGORY.PURCHASE, 'משהו'), false);
});

test('a category change is logged as a category change, from → to + actor', () => {
  const note = categoryChangeNote(CATEGORY.PURCHASE, CATEGORY.REPAIR, 'אולגה');
  assert.match(note, /קטגוריה שונתה/);
  assert.match(note, /רכישה/);
  assert.match(note, /תיקון/);
  assert.match(note, /אולגה/);
  // a missing side renders as an em-dash, never a blank or "undefined"
  assert.match(categoryChangeNote('', CATEGORY.REPAIR, 'סנדרה'), /— → תיקון/);
});
