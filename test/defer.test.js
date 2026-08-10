// defer.test.js — deferral reminder date math.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reminderDate, reminderDue } from '../src/defer.js';

test('reminder fires 7 days before the deferred date', () => {
  assert.equal(reminderDate('2026-07-20', 7), '2026-07-13');
});

test('reminder handles month rollover', () => {
  assert.equal(reminderDate('2026-07-03', 7), '2026-06-26');
});

test('zero days before = same day', () => {
  assert.equal(reminderDate('2026-07-20', 0), '2026-07-20');
});

test('blank / invalid input returns empty string', () => {
  assert.equal(reminderDate('', 7), '');
  assert.equal(reminderDate(null, 7), '');
  assert.equal(reminderDate('not-a-date', 7), '');
});

test('reminderDue: true on or after the reminder date', () => {
  assert.equal(reminderDue('2026-07-13', '2026-07-12'), false);
  assert.equal(reminderDue('2026-07-13', '2026-07-13'), true);
  assert.equal(reminderDue('2026-07-13', '2026-07-20'), true);
});

test('reminderDue: false for blanks', () => {
  assert.equal(reminderDue('', '2026-07-13'), false);
  assert.equal(reminderDue('2026-07-13', ''), false);
});
