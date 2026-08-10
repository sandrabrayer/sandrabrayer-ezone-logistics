// test/digest-deferred-inclusion.test.js — regression guard: a deferred (נדחה לתאריך) request MUST appear
// in the OpenTickets digest with its deferred_date. Deferred tickets are alive, waiting for a date — the
// deferred_date column exists precisely to show that state. Also verifies the WHOLE status vocabulary so no
// status is silently dropped, and locks the rebuild's per-request isolation (a bad sibling row must not
// take the digest — and a live deferred ticket — down with it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isDigestTicket, openTicketRow, DIGEST_OPEN_HEADERS } from '../src/digest.js';
import { STATUSES } from '../src/schema.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = '2026-08-09T12:00:00.000Z';

// Expected digest membership per the intended rule: everything EXCEPT (a) rejected OLDER than
// archive_after_days and (b) completed/closed OLDER than archive_after_days. A rejected ticket within the
// window (aged off rejected_at) stays, exactly like a recently completed/closed one.
const RECENT = '2026-08-08T00:00:00.000Z'; // 1 day ago → rejected + completed/closed still shown
const OLD = '2026-06-01T00:00:00.000Z';    // >7 days ago → rejected + completed/closed dropped

test('a deferred request is INCLUDED in the digest, with its deferred_date', () => {
  const deferred = {
    id: 'R-DEF', house: 'קיסריה עפרוני', status: STATUSES.DEFERRED,
    description: 'מזגן לא עובד', deferred_until: '2026-08-19', completed_at: '',
  };
  assert.equal(isDigestTicket(deferred, NOW, 7), true, 'deferred must be in the digest');
  const row = openTicketRow(deferred, { house: 'caesarea-ofroni' });
  assert.equal(row[DIGEST_OPEN_HEADERS.indexOf('status')], STATUSES.DEFERRED);
  assert.equal(row[DIGEST_OPEN_HEADERS.indexOf('deferred_date')], '2026-08-19', 'the deferral date is shown');
});

test('the FULL status vocabulary: only aged rejected and aged completed/closed drop out', () => {
  // Every status shown when RECENT: active always, and rejected/completed/closed within the window.
  const expected = {
    [STATUSES.REQUEST]: true,
    [STATUSES.PENDING_APPROVAL]: true,
    [STATUSES.APPROVED]: true,
    [STATUSES.DEFERRED]: true,      // the regression: alive, waiting for a date → MUST be shown
    [STATUSES.IN_PROGRESS]: true,
    [STATUSES.COMPLETED]: true,     // recent completion → shown within the window
    [STATUSES.CLOSED]: true,        // recently closed → shown within the window
    [STATUSES.NOT_APPROVED]: true,  // recently rejected → now shown within the window (aged off rejected_at)
  };
  for (const [status, shown] of Object.entries(expected)) {
    const terminal = status === STATUSES.COMPLETED || status === STATUSES.CLOSED;
    const rejected = status === STATUSES.NOT_APPROVED;
    const req = { status, completed_at: terminal ? RECENT : '', rejected_at: rejected ? RECENT : '' };
    assert.equal(isDigestTicket(req, NOW, 7), shown, `${status} should be ${shown ? 'shown' : 'hidden'}`);
  }
  // and the self-cleaning half: OLD rejected + OLD completed/closed tickets drop out (but never the active ones)
  assert.equal(isDigestTicket({ status: STATUSES.NOT_APPROVED, rejected_at: OLD }, NOW, 7), false);
  assert.equal(isDigestTicket({ status: STATUSES.COMPLETED, completed_at: OLD }, NOW, 7), false);
  assert.equal(isDigestTicket({ status: STATUSES.CLOSED, completed_at: OLD }, NOW, 7), false);
  // a deferred ticket is NEVER age-gated, no matter how long ago it was created/deferred
  assert.equal(isDigestTicket({ status: STATUSES.DEFERRED, created_at: OLD, deferred_until: '2026-08-19' }, NOW, 7), true);
});

// ---- Apps Script writer guards (source-level; the writer runs in production) ----

const digest = readFileSync(join(root, 'apps-script/digest.gs'), 'utf8');

test('the rebuild isolates each request — one bad row cannot drop the digest (and its deferred tickets)', () => {
  const i = digest.indexOf('function buildOpenTicketRows_(');
  let depth = 0, j = digest.indexOf('{', i), body = '';
  for (; j < digest.length; j++) { if (digest[j] === '{') depth++; else if (digest[j] === '}' && --depth === 0) { j++; break; } }
  body = digest.slice(i, j);
  assert.match(body, /requests\.forEach\(function/, 'iterates the requests');
  assert.match(body, /try\s*\{/, 'each request is built inside a try');
  assert.match(body, /catch\s*\(/, 'a failing request is caught, not allowed to abort the rebuild');
  assert.match(body, /digestIncludeTicket_\(req,\s*now,\s*retentionDays\)/, 'inclusion via the retention-aware filter');
});

test('deferred is neither rejected nor terminal in the Apps Script filter (so it is always included)', () => {
  assert.match(digest, /DIGEST_REJECTED_STATUS_\s*=\s*['"]לא מאושר['"]/);
  assert.match(digest, /DIGEST_TERMINAL_STATUSES_\s*=\s*\[\s*['"]הושלם['"]\s*,\s*['"]סגור['"]\s*\]/);
  // the deferred status must NOT appear in either exclusion set
  assert.doesNotMatch(digest, /DIGEST_REJECTED_STATUS_\s*=\s*['"]נדחה לתאריך['"]/);
  assert.doesNotMatch(digest, /DIGEST_TERMINAL_STATUSES_\s*=\s*\[[^\]]*נדחה לתאריך/);
});

test('deferred_date is formatted in the script timezone (no UTC day-shift for a Sheet Date cell)', () => {
  const i = digest.indexOf('function digestDateOnly_(');
  const body = digest.slice(i, digest.indexOf('}', digest.indexOf('return', digest.indexOf('return', i) + 1)) + 1);
  assert.match(body, /Utilities\.formatDate\([^)]*Session\.getScriptTimeZone\(\)[^)]*['"]yyyy-MM-dd['"]\)/,
    'a Date is formatted in the script timezone, not reduced via UTC toISOString');
});
