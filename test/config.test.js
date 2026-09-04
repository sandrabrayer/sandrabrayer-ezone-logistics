// test/config.test.js — locks the centralized coercion rule that the approval logic depends on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coerceConfigValue, coerceConfig } from '../src/config.js';

test('approval_threshold comes back as a NUMBER, not a string', () => {
  const v = coerceConfigValue('approval_threshold', '3000');
  assert.equal(typeof v, 'number');
  assert.equal(v, 3000);
  // The bug this guards against: string comparison. 500 > "3000" is false in JS via Number
  // coercion, but mixed comparisons are exactly what we must never rely on.
  assert.equal(v > 500, true);
  assert.equal(4000 > v, true);
});

test('emergency_bypasses_approval comes back as a BOOLEAN', () => {
  assert.equal(coerceConfigValue('emergency_bypasses_approval', 'TRUE'), true);
  assert.equal(coerceConfigValue('emergency_bypasses_approval', 'true'), true);
  assert.equal(coerceConfigValue('emergency_bypasses_approval', '1'), true);
  assert.equal(coerceConfigValue('emergency_bypasses_approval', 'FALSE'), false);
  assert.equal(coerceConfigValue('emergency_bypasses_approval', ''), false);
});

test('notify_enabled (e-mail master switch) comes back as a BOOLEAN; blank = off', () => {
  assert.equal(coerceConfigValue('notify_enabled', 'TRUE'), true);
  assert.equal(coerceConfigValue('notify_enabled', 'yes'), true);
  assert.equal(coerceConfigValue('notify_enabled', 'FALSE'), false);
  assert.equal(coerceConfigValue('notify_enabled', ''), false);
});

test('archive_after_days comes back as a NUMBER (the archive grace period)', () => {
  const v = coerceConfigValue('archive_after_days', '7');
  assert.equal(typeof v, 'number');
  assert.equal(v, 7);
});

test('unknown keys pass through as strings untouched', () => {
  assert.equal(coerceConfigValue('some_future_text_key', 'hello'), 'hello');
});

test('a non-numeric threshold throws rather than silently becoming NaN', () => {
  assert.throws(() => coerceConfigValue('approval_threshold', 'abc'), /expected a number/);
});

test('coerceConfig maps a whole raw key/value object', () => {
  const out = coerceConfig({
    approval_threshold: '3000',
    emergency_bypasses_approval: 'TRUE',
  });
  assert.equal(out.approval_threshold, 3000);
  assert.equal(out.emergency_bypasses_approval, true);
});
