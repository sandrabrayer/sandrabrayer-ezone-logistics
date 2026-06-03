// test/edit.test.js — locks delete authority + edit-before-approval rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canDelete, canEdit, EDITABLE_FIELDS } from '../src/edit.js';
import { STATUSES } from '../src/schema.js';

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
