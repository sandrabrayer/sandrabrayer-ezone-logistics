// test/request.test.js — locks increment-2a behavior: capture + stamp as דרישה, no approval logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateNewRequest, buildNewRequest, generateRequestId, SUBMITTERS,
} from '../src/request.js';
import { STATUSES, CATEGORY, URGENCY } from '../src/schema.js';

const FIXED_NOW = '2026-06-02T10:00:00.000Z';
const valid = {
  house: 'רעננה',
  category: CATEGORY.REPAIR,
  urgency: URGENCY.NORMAL,
  created_by: 'רמי',
  description: 'ברז דולף',
  location_in_house: 'מטבח',
  estimated_cost: 250,
};

test('valid input passes validation', () => {
  assert.equal(validateNewRequest(valid), null);
});

test('BLANK estimated_cost is valid (unknown cost is a real case)', () => {
  assert.equal(validateNewRequest({ ...valid, estimated_cost: '' }), null);
  const row = buildNewRequest({ ...valid, estimated_cost: '' }, { id: 'X', now: FIXED_NOW });
  assert.equal(row.estimated_cost, ''); // stays blank, not coerced to 0
});

test('numeric cost is stored as a number', () => {
  const row = buildNewRequest({ ...valid, estimated_cost: '4000' }, { id: 'X', now: FIXED_NOW });
  assert.equal(row.estimated_cost, 4000);
  assert.equal(typeof row.estimated_cost, 'number');
});

test('non-numeric, non-blank cost is rejected', () => {
  assert.match(validateNewRequest({ ...valid, estimated_cost: 'abc' }), /number or blank/);
});

test('unknown category is rejected', () => {
  assert.match(validateNewRequest({ ...valid, category: 'משהו' }), /category/);
});

test('unknown urgency is rejected', () => {
  assert.match(validateNewRequest({ ...valid, urgency: 'מתישהו' }), /urgency/);
});

test('created_by must be from the controlled submitter list', () => {
  assert.match(validateNewRequest({ ...valid, created_by: 'מישהו אחר' }), /created_by/);
  for (const who of SUBMITTERS) {
    assert.equal(validateNewRequest({ ...valid, created_by: who }), null);
  }
});

test('every new request is stamped דרישה with server time and id', () => {
  const row = buildNewRequest(valid, { id: 'REQ-123', now: FIXED_NOW });
  assert.equal(row.status, STATUSES.REQUEST);
  assert.equal(row.status, 'דרישה');
  assert.equal(row.id, 'REQ-123');
  assert.equal(row.created_at, FIXED_NOW);
});

test('approval/assignment fields are left blank for later increments', () => {
  const row = buildNewRequest(valid, { id: 'X', now: FIXED_NOW });
  for (const f of ['approval_required', 'approved_by', 'assigned_to', 'batch_id', 'attachment_url']) {
    assert.equal(row[f], '', `${f} should be blank in 2a`);
  }
});

test('generateRequestId is deterministic with injected rand and uses REQ- prefix', () => {
  const id = generateRequestId(FIXED_NOW, 0.4242);
  assert.match(id, /^REQ-\d{14}-\d{4}$/);
});
