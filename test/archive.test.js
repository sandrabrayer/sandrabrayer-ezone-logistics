// test/archive.test.js — locks the dashboard archive grace-period rule: completed/closed requests
// that finished more than archive_after_days ago leave the active board for the read-only ארכיון tab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isArchived, isArchivableStatus, completionTime, daysSince, partitionByArchive,
  ARCHIVABLE_STATUSES, DEFAULT_ARCHIVE_AFTER_DAYS,
} from '../src/archive.js';
import { STATUSES } from '../src/schema.js';

const NOW = '2026-08-09T12:00:00.000Z';
const nowMs = new Date(NOW).getTime();
const daysAgo = (n) => new Date(nowMs - n * 86400000).toISOString();

test('only completed/closed statuses are ever archivable', () => {
  assert.deepEqual(ARCHIVABLE_STATUSES, [STATUSES.COMPLETED, STATUSES.CLOSED]);
  assert.equal(isArchivableStatus(STATUSES.COMPLETED), true);
  assert.equal(isArchivableStatus(STATUSES.CLOSED), true);
  assert.equal(isArchivableStatus(STATUSES.IN_PROGRESS), false);
  assert.equal(isArchivableStatus(STATUSES.DEFERRED), false);
  assert.equal(isArchivableStatus(STATUSES.NOT_APPROVED), false); // a live decision, never auto-archived
  assert.equal(isArchivableStatus(''), false);
});

test('completed request older than the window is archived; within the window it is not', () => {
  const old = { status: STATUSES.COMPLETED, completed_at: daysAgo(10) };
  const fresh = { status: STATUSES.COMPLETED, completed_at: daysAgo(3) };
  assert.equal(isArchived(old, NOW, 7), true);
  assert.equal(isArchived(fresh, NOW, 7), false);
});

test('the boundary is STRICTLY more than N days (exactly N stays on the board)', () => {
  const exactlyN = { status: STATUSES.CLOSED, completed_at: daysAgo(7) };
  const justOver = { status: STATUSES.CLOSED, completed_at: daysAgo(8) };
  assert.equal(isArchived(exactlyN, NOW, 7), false);
  assert.equal(isArchived(justOver, NOW, 7), true);
});

test('closed requests archive on the same completed_at basis as completed ones', () => {
  const closedOld = { status: STATUSES.CLOSED, completed_at: daysAgo(30) };
  assert.equal(isArchived(closedOld, NOW, 7), true);
});

test('a request with no parseable completion date is never archived (kept visible)', () => {
  assert.equal(isArchived({ status: STATUSES.COMPLETED, completed_at: '' }, NOW, 7), false);
  assert.equal(isArchived({ status: STATUSES.COMPLETED }, NOW, 7), false);
  assert.equal(isArchived({ status: STATUSES.CLOSED, completed_at: 'not-a-date' }, NOW, 7), false);
});

test('a missing / zero / negative window falls back to the default grace, never 0', () => {
  const sevenAgo = { status: STATUSES.COMPLETED, completed_at: daysAgo(7) };
  const eightAgo = { status: STATUSES.COMPLETED, completed_at: daysAgo(8) };
  for (const bad of [undefined, null, 0, -3, NaN, 'x']) {
    // default is 7 → exactly 7 stays, 8 archives (never hides same-day work with a 0 window)
    assert.equal(isArchived(sevenAgo, NOW, bad), false, `window=${bad}`);
    assert.equal(isArchived(eightAgo, NOW, bad), true, `window=${bad}`);
  }
  assert.equal(DEFAULT_ARCHIVE_AFTER_DAYS, 7);
});

test('a custom window is honored', () => {
  const req = { status: STATUSES.COMPLETED, completed_at: daysAgo(20) };
  assert.equal(isArchived(req, NOW, 30), false); // 20 <= 30 → still on the board
  assert.equal(isArchived(req, NOW, 14), true);  // 20 > 14 → archived
});

test('completionTime / daysSince helpers', () => {
  assert.equal(completionTime({ completed_at: NOW }), nowMs);
  assert.equal(completionTime({ completed_at: '' }), null);
  assert.equal(completionTime({}), null);
  assert.equal(daysSince(nowMs - 3 * 86400000, nowMs), 3);
  assert.equal(daysSince(nowMs + 86400000, nowMs), 0); // future completion → 0, not negative
});

test('partitionByArchive splits active vs archived, preserving order', () => {
  const reqs = [
    { id: 'A', status: STATUSES.IN_PROGRESS },
    { id: 'B', status: STATUSES.COMPLETED, completed_at: daysAgo(2) },  // recent → active
    { id: 'C', status: STATUSES.COMPLETED, completed_at: daysAgo(40) }, // old → archived
    { id: 'D', status: STATUSES.CLOSED, completed_at: daysAgo(90) },    // old → archived
  ];
  const { active, archived } = partitionByArchive(reqs, NOW, 7);
  assert.deepEqual(active.map(r => r.id), ['A', 'B']);
  assert.deepEqual(archived.map(r => r.id), ['C', 'D']);
});
