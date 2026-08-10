// test/digest-lifecycle-contract.test.js — the FROZEN lifecycle contract for OpenTickets inclusion.
//
// This is a change-detector: it walks EVERY status × dated/undated × in-window/past-window and asserts
// the EXACT `isDigestTicket` verdict, so any future edit to the inclusion rule that changes observable
// behavior fails loudly here (separately from mirror-drift.test.js, which only checks that the two
// implementations AGREE — this file pins WHAT they must agree on).
//
// The contract (see DIGEST-CONTRACT.md):
//   - active work — דרישה / ממתין לאישור / מאושר / נדחה לתאריך / בביצוע — is ALWAYS included, any age.
//   - rejected (לא מאושר) ages off Requests.rejected_at: within archive_after_days → shown, past → dropped.
//   - completed/closed (הושלם / סגור) age off Requests.completed_at: within → shown, past → dropped.
//   - an undateable resolution (blank / unparseable) is KEPT (we do not hide what we cannot age).
//   - a rejected ticket ages off rejected_at ONLY (a stray completed_at never ages it), and vice-versa.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDigestTicket } from '../src/digest.js';
import { STATUSES } from '../src/schema.js';

const NOW = '2026-08-09T12:00:00.000Z';
const NOW_MS = new Date(NOW).getTime();
const WIN = 7;                                   // the window under test (archive_after_days default)
const at = (daysAgo) => new Date(NOW_MS - daysAgo * 86400000).toISOString();

const ACTIVE = [
  STATUSES.REQUEST, STATUSES.PENDING_APPROVAL, STATUSES.APPROVED, STATUSES.DEFERRED, STATUSES.IN_PROGRESS,
];
const TERMINAL = [STATUSES.COMPLETED, STATUSES.CLOSED];
const REJECTED = STATUSES.NOT_APPROVED;

// Independent statement of the contract (NOT a copy of the implementation's control flow): given a status
// and the two timestamp fields, what SHOULD OpenTickets show?
function shouldShow(status, { rejected_at, completed_at }, nowMs, window) {
  if (status !== REJECTED && !TERMINAL.includes(status)) return true;   // active → always
  const raw = status === REJECTED ? rejected_at : completed_at;         // each class ages off its own field
  if (raw == null || String(raw).trim() === '') return true;           // undateable → kept
  const finished = new Date(raw).getTime();
  if (Number.isNaN(finished)) return true;                             // unparseable → kept
  return Math.floor((nowMs - finished) / 86400000) <= window;          // inclusive at exactly `window` days
}

test('lifecycle matrix: every status × dated/undated × in/past window → exact inclusion', () => {
  const allStatuses = [...ACTIVE, REJECTED, ...TERMINAL];
  const offsets = ['undated-blank', 'undated-missing', 'undated-bad', 0, 3, WIN, WIN + 1, 30];
  const toStamp = (o) => (o === 'undated-blank' ? '' : o === 'undated-missing' ? undefined
    : o === 'undated-bad' ? 'not-a-date' : at(o));

  let cases = 0;
  for (const status of allStatuses) {
    // Vary BOTH timestamp fields independently so the "ages off its OWN field" rule is exercised, incl.
    // the cross cells (rejected with a stray completed_at; completed with a stray rejected_at).
    for (const rOff of offsets) {
      for (const cOff of offsets) {
        const req = { status, rejected_at: toStamp(rOff), completed_at: toStamp(cOff) };
        const expected = shouldShow(status, req, NOW_MS, WIN);
        assert.equal(isDigestTicket(req, NOW, WIN), expected,
          `status=${status} rejected_at=${rOff} completed_at=${cOff}`);
        cases++;
      }
    }
  }
  assert.ok(cases >= 8 * 8 * 8, `matrix ran (${cases} cases)`);
});

// ---- Legible spot-checks: the contract in plain literals (so intent survives a refactor of the loop) ----

test('active work is always shown, regardless of age or stray timestamps', () => {
  for (const status of ACTIVE) {
    assert.equal(isDigestTicket({ status, rejected_at: at(999), completed_at: at(999) }, NOW, WIN), true, status);
    assert.equal(isDigestTicket({ status }, NOW, WIN), true, status);
  }
});

test('rejected ages off rejected_at: in-window shown, past-window dropped, boundary inclusive', () => {
  assert.equal(isDigestTicket({ status: REJECTED, rejected_at: at(0) }, NOW, WIN), true);
  assert.equal(isDigestTicket({ status: REJECTED, rejected_at: at(WIN) }, NOW, WIN), true);       // exactly 7 → shown
  assert.equal(isDigestTicket({ status: REJECTED, rejected_at: at(WIN + 1) }, NOW, WIN), false);  // 8 → dropped
  assert.equal(isDigestTicket({ status: REJECTED, rejected_at: at(30) }, NOW, WIN), false);
});

test('rejected is kept when its rejection date is undateable (never hidden without an age)', () => {
  assert.equal(isDigestTicket({ status: REJECTED, rejected_at: '' }, NOW, WIN), true);
  assert.equal(isDigestTicket({ status: REJECTED }, NOW, WIN), true);
  assert.equal(isDigestTicket({ status: REJECTED, rejected_at: 'not-a-date' }, NOW, WIN), true);
});

test('rejected ages off rejected_at ONLY — a stray completed_at never ages it, and vice-versa', () => {
  // old completed_at but no rejected_at → still shown (rejection is undateable)
  assert.equal(isDigestTicket({ status: REJECTED, completed_at: at(30), rejected_at: '' }, NOW, WIN), true);
  // old rejected_at but recent completed_at → dropped (aged by rejection, completed_at ignored)
  assert.equal(isDigestTicket({ status: REJECTED, rejected_at: at(30), completed_at: at(0) }, NOW, WIN), false);
  // completed ticket: old rejected_at is irrelevant, recent completion → shown
  assert.equal(isDigestTicket({ status: STATUSES.COMPLETED, completed_at: at(0), rejected_at: at(30) }, NOW, WIN), true);
  // completed ticket: recent rejected_at is irrelevant, old completion → dropped
  assert.equal(isDigestTicket({ status: STATUSES.COMPLETED, completed_at: at(30), rejected_at: at(0) }, NOW, WIN), false);
});

test('completed/closed age off completed_at: in-window shown, past-window dropped, boundary inclusive', () => {
  for (const status of TERMINAL) {
    assert.equal(isDigestTicket({ status, completed_at: at(0) }, NOW, WIN), true, status);
    assert.equal(isDigestTicket({ status, completed_at: at(WIN) }, NOW, WIN), true, status);       // exactly 7 → shown
    assert.equal(isDigestTicket({ status, completed_at: at(WIN + 1) }, NOW, WIN), false, status);  // 8 → dropped
    assert.equal(isDigestTicket({ status, completed_at: '' }, NOW, WIN), true, status);            // undateable → kept
  }
});
