// digest.js — the OpenTickets digest inclusion rule.
//
// PURE module (no Apps Script APIs) so node:test verifies every rule directly. Code.gs mirrors
// `digestIncludeTicket_` and reads Config for `archive_after_days`, then serves the filtered list.
//
// WHAT THE DIGEST IS: the outbound "OpenTickets" summary a coordinator sees — every request that
// still deserves attention. Live requests are always in it. Terminal requests linger for a short
// grace window (so the outcome is actually seen), then drop out and become archive-only.
//
// CONTRACT: this file is the single source of truth for that rule. Keep it in sync with
// apps-script/Code.gs and DIGEST-CONTRACT.md — a mismatch silently breaks every consumer.

import { STATUSES } from './schema.js';

const S = STATUSES;

// Live statuses — a request still in flight. Always in the digest, no aging.
export const DIGEST_ACTIVE_STATUSES = new Set([
  S.REQUEST,
  S.PENDING_APPROVAL,
  S.APPROVED,
  S.DEFERRED,
  S.IN_PROGRESS,
]);

// Terminal statuses that linger for `archive_after_days` days, then drop out.
// `NOT_APPROVED` (rejected, לא מאושר) joined this set: a coordinator must SEE that a request was
// denied, not have it silently vanish. It ages out on the same window as completed/closed.
export const DIGEST_ARCHIVING_STATUSES = new Set([
  S.COMPLETED,
  S.CLOSED,
  S.NOT_APPROVED,
]);

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The timestamp aging starts from, per status.
 *  - rejected  → rejection time (`rejected_at`), falling back to `updated_at` then `created_at`
 *  - completed / closed → completion time (`completed_at`), same fallbacks
 * The fallbacks keep rows written before a dedicated field existed from vanishing.
 * @param {object} req a request row
 * @returns {string} an ISO timestamp, or '' if none is available
 */
export function digestArchiveAnchor(req) {
  if (req.status === S.NOT_APPROVED) {
    return req.rejected_at || req.updated_at || req.created_at || '';
  }
  if (req.status === S.COMPLETED || req.status === S.CLOSED) {
    return req.completed_at || req.updated_at || req.created_at || '';
  }
  return '';
}

/**
 * Should this request appear in the OpenTickets digest right now?
 *
 * @param {object} req              a request row (needs at least `status`)
 * @param {Date|string} [now]       the reference time (defaults to now)
 * @param {number} [archiveAfterDays=7] grace window for terminal statuses
 * @returns {boolean}
 */
export function isDigestTicket(req, now = new Date(), archiveAfterDays = 7) {
  if (!req || !req.status) return false;

  // Live requests are always in the digest.
  if (DIGEST_ACTIVE_STATUSES.has(req.status)) return true;

  // Anything that is neither live nor archiving (unknown status) is out.
  if (!DIGEST_ARCHIVING_STATUSES.has(req.status)) return false;

  // Terminal: visible only inside the grace window measured from its aging anchor.
  const anchor = digestArchiveAnchor(req);
  if (!anchor) return true; // no anchor yet → keep visible rather than vanish (fail-safe)

  const anchorMs = new Date(anchor).getTime();
  if (Number.isNaN(anchorMs)) return true; // unparseable → fail-safe visible

  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const ageDays = (nowMs - anchorMs) / DAY_MS;

  // Visible FOR archive_after_days days, then drops (age === window drops out).
  return ageDays < Number(archiveAfterDays);
}

// Back-compat alias for the Apps Script naming used across the E-ZONE repos.
export const digestIncludeTicket = isDigestTicket;

// ---- Display tone (for rendering the digest) ----
//
// Each status carries a tone the digest renders with. Rejected is RED so a denied request reads
// as denied at a glance while it lingers in its grace window. Tokens mirror the dashboard palette
// (--red / --amber / --go). See DIGEST-CONTRACT.md.
const DIGEST_TONE = {
  [S.REQUEST]: 'neutral',
  [S.PENDING_APPROVAL]: 'neutral',
  [S.APPROVED]: 'neutral',
  [S.DEFERRED]: 'amber',
  [S.IN_PROGRESS]: 'neutral',
  [S.COMPLETED]: 'green',
  [S.CLOSED]: 'green',
  [S.NOT_APPROVED]: 'red',
};

/**
 * The display tone for a status in the digest. Rejected → 'red'.
 * @param {string} status
 * @returns {'red'|'amber'|'green'|'neutral'}
 */
export function digestStatusTone(status) {
  return DIGEST_TONE[status] || 'neutral';
}

/**
 * Filter a list of request rows to the digest set.
 * @param {object[]} requests
 * @param {Date|string} [now]
 * @param {number} [archiveAfterDays=7]
 * @returns {object[]}
 */
export function selectDigestTickets(requests, now = new Date(), archiveAfterDays = 7) {
  return (requests || []).filter((r) => isDigestTicket(r, now, archiveAfterDays));
}
