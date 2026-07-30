// sla.js — SLA due-date derivation + aging predicates (increment 36).
//
// PURE, dependency-free. Mirrored VERBATIM (logic-for-logic) inside apps-script/Code.gs so the SAME
// rules run on the public /exec endpoint and the digest — the Node layer is never trusted. A guard
// test (test/mirror-drift.test.js) asserts the two copies stay in sync.
//
// due_at is DERIVED from urgency at creation using the Config `sla_days` spec, so the SLA is tunable
// in the Sheet with no deploy. days_open / overdue / days_overdue are DERIVED AT READ TIME — never
// stored. `now` is always passed in (never read from the clock inside these functions) so the logic
// is deterministic and testable, and identical on both sides of the mirror.

// === MIRROR:sla START ===
// Parse a "label:days|label:days" spec (e.g. "חירום:1|דחוף:3|רגיל:14") into { label: days }, or null
// when empty or ANY pair is malformed — empty label, missing colon, or days not a whole number > 0.
// null means "do not trust this spec"; the caller derives no due date rather than guessing one.
function parseSlaSpec(spec) {
  if (typeof spec !== 'string' || spec.replace(/^\s+|\s+$/g, '') === '') return null;
  var parts = spec.split('|');
  var out = {};
  var n = 0;
  for (var i = 0; i < parts.length; i++) {
    var seg = parts[i].replace(/^\s+|\s+$/g, '');
    if (seg === '') return null;
    var idx = seg.lastIndexOf(':');
    if (idx <= 0 || idx === seg.length - 1) return null;
    var label = seg.slice(0, idx).replace(/^\s+|\s+$/g, '');
    var days = Number(seg.slice(idx + 1).replace(/^\s+|\s+$/g, ''));
    if (!label || !isFinite(days) || days <= 0 || Math.floor(days) !== days) return null;
    out[label] = days;
    n++;
  }
  return n ? out : null;
}

// The SLA days for an urgency, or null (malformed spec OR unknown urgency → null; caller logs and
// derives no due date — never a silently wrong default).
function slaDaysFor(spec, urgency) {
  var map = parseSlaSpec(spec);
  if (!map) return null;
  return Object.prototype.hasOwnProperty.call(map, urgency) ? map[urgency] : null;
}

// due_at = fromIso + (days for urgency), in ISO. '' when no due date can be derived (malformed spec,
// unknown urgency, or unparseable fromIso). `log`, if given, is called with the reason it was blank.
function deriveDueAt(fromIso, urgency, spec, log) {
  var days = slaDaysFor(spec, urgency);
  if (days == null) {
    if (log) log('sla: no due date for urgency "' + urgency + '" (spec "' + spec + '") — left blank');
    return '';
  }
  var base = new Date(fromIso);
  if (isNaN(base.getTime())) {
    if (log) log('sla: unparseable base date "' + fromIso + '" — due date left blank');
    return '';
  }
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString();
}

// Whole days a request has been open: created_at → completed_at once completed, else created_at → now.
// FREEZES at completion. null on unparseable input; never negative.
function daysOpen(createdAt, completedAt, now) {
  var start = new Date(createdAt);
  var endRaw = (completedAt != null && String(completedAt) !== '') ? completedAt : now;
  var end = endRaw instanceof Date ? endRaw : new Date(endRaw);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;
  var ms = end.getTime() - start.getTime();
  if (ms < 0) ms = 0;
  return Math.floor(ms / 86400000);
}

// Overdue = due_at set AND now strictly past it AND the request is still ageing: NOT completed/closed,
// and NOT deferred (a deferral parks the SLA — while נדחה לתאריך a request is never overdue). `blocked`
// is deliberately NOT consulted: a blocked request still ages and can still be overdue.
function isOverdue(dueAt, status, now) {
  if (dueAt == null || String(dueAt) === '') return false;
  if (status === 'הושלם' || status === 'סגור') return false;
  if (status === 'נדחה לתאריך') return false;
  var due = new Date(dueAt);
  var n = now instanceof Date ? now : new Date(now);
  if (isNaN(due.getTime()) || isNaN(n.getTime())) return false;
  return n.getTime() > due.getTime();
}

// Whole days past due_at, or 0 when not overdue.
function daysOverdue(dueAt, status, now) {
  if (!isOverdue(dueAt, status, now)) return 0;
  var due = new Date(dueAt);
  var n = now instanceof Date ? now : new Date(now);
  return Math.floor((n.getTime() - due.getTime()) / 86400000);
}

// A request's `blocked` cell (stored 'TRUE'/'FALSE') as a boolean.
function isBlocked(v) {
  return String(v == null ? '' : v).toUpperCase() === 'TRUE';
}

// Validate a block/unblock request. Returns an error string, or null when OK. Blocking REQUIRES a
// non-empty reason; unblocking needs none. (Role gating is separate — see canBlock in roles.)
function blockValidation(blocked, reason) {
  var block = (blocked === true || String(blocked).toUpperCase() === 'TRUE');
  if (block && String(reason == null ? '' : reason).replace(/^\s+|\s+$/g, '') === '') {
    return 'חסימה מחייבת סיבה';
  }
  return null;
}

// All read-time aging facts for a request row, in one call (used by the UI list + the digest).
function ticketAging(req, now) {
  var status = req && req.status != null ? String(req.status) : '';
  var dueAt = req && req.due_at != null ? req.due_at : '';
  return {
    days_open: daysOpen(req ? req.created_at : '', req ? req.completed_at : '', now),
    overdue: isOverdue(dueAt, status, now),
    days_overdue: daysOverdue(dueAt, status, now),
    blocked: isBlocked(req ? req.blocked : ''),
  };
}
// === MIRROR:sla END ===

export {
  parseSlaSpec, slaDaysFor, deriveDueAt, daysOpen, isOverdue, daysOverdue, isBlocked, ticketAging,
  blockValidation,
};
