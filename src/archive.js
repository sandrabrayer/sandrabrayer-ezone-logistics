// archive.js — pure rules for keeping the dashboard board uncluttered: completed (הושלם) / closed
// (סגור) requests that finished more than `archive_after_days` ago leave the main flow for a separate,
// read-only ארכיון view. They are never deleted — only moved out of the active board, so they stay
// searchable in the archive tab and in the AuditLog.
//
// This is pure JS (no Apps Script / DOM) so the aging boundary is unit-tested under node:test; the
// same rule is duplicated inline in src/dashboard.html (the board is the only place that partitions),
// mirroring how the dashboard duplicates the other shared logic.

import { STATUSES } from './schema.js';

// Only terminal, finished requests are ever archived. Everything else — pending, deferred, approved,
// in-progress, and even 'לא מאושר' (not approved is a live decision a manager may still revisit) — stays
// on the board regardless of age.
export const ARCHIVABLE_STATUSES = [STATUSES.COMPLETED, STATUSES.CLOSED];

export const DEFAULT_ARCHIVE_AFTER_DAYS = 7;

/** Is this status one that can ever be archived (completed / closed)? */
export function isArchivableStatus(status) {
  return ARCHIVABLE_STATUSES.indexOf(String(status == null ? '' : status).trim()) !== -1;
}

/**
 * The reference instant a request "finished". Both הושלם and סגור pass through COMPLETED (the only
 * transition into CLOSED is COMPLETED→CLOSED), so completed_at is the honest completion date for both.
 * Returns the ms timestamp, or null when there is no parseable completion date (an undateable request
 * is never archived — we do not hide what we cannot age, mirroring the digest's "gap shows" rule).
 */
export function completionTime(request) {
  const r = request || {};
  const raw = r.completed_at;
  if (raw == null || String(raw).trim() === '') return null;
  const t = new Date(raw).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Whole days between two ms instants (fromMs → nowMs), floored. Negative (a future completion) → 0.
 */
export function daysSince(fromMs, nowMs) {
  const diff = nowMs - fromMs;
  if (!(diff > 0)) return 0;
  return Math.floor(diff / 86400000); // 24*60*60*1000
}

/**
 * True when a request should leave the active board for the ארכיון: its status is completed/closed AND
 * it finished STRICTLY MORE than `archiveAfterDays` days ago. A completed/closed request within the
 * grace window is "recently completed" and stays on the board. A missing/zero/negative window means the
 * feature keeps the default grace of DEFAULT_ARCHIVE_AFTER_DAYS (never 0 — 0 would hide same-day work).
 * @param {object} request  request row (reads .status, .completed_at)
 * @param {number|string|Date} now  the current instant (Date, ms, or ISO string)
 * @param {number} archiveAfterDays  Config archive_after_days (coerced); default 7
 */
export function isArchived(request, now, archiveAfterDays) {
  if (!isArchivableStatus(request && request.status)) return false;
  const finished = completionTime(request);
  if (finished == null) return false; // undateable completion → keep visible, never archive
  const nowMs = now instanceof Date ? now.getTime() : (typeof now === 'number' ? now : new Date(now).getTime());
  if (Number.isNaN(nowMs)) return false;
  let n = Number(archiveAfterDays);
  if (!Number.isFinite(n) || n <= 0) n = DEFAULT_ARCHIVE_AFTER_DAYS;
  return daysSince(finished, nowMs) > n;
}

/**
 * Split a list of requests into { active, archived } by isArchived. `active` = the board (all
 * non-terminal work + recently completed); `archived` = the read-only ארכיון tab. Order is preserved
 * within each partition.
 */
export function partitionByArchive(requests, now, archiveAfterDays) {
  const active = [];
  const archived = [];
  for (const r of requests || []) {
    if (isArchived(r, now, archiveAfterDays)) archived.push(r);
    else active.push(r);
  }
  return { active, archived };
}
