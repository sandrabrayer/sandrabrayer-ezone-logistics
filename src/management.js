// management.js — pure aggregation for the /management screen (ops_manager + ceo), built STRICTLY from
// data this repo owns. It reads nothing from another app.
//
// PR B simplification (Olga's screen): the screen was trimmed to what has a real, owned data source —
//   • SLA / delays (requestsPanel)              — open/overdue/blocked requests, worst-first.
//   • recurring defects (from Requests ONLY)    — same house + same category/description ≥2 in 90 days.
//   • opening readiness (OpeningChecklist)      — a Logistics-owned pre-opening checklist per house.
//   • emergency readiness (EmergencyReadiness)  — a per-house emergency-preparedness checklist.
//   • עמידה בתקציב + עמידה באמות מידה + תחזוקה מונעת are computed SERVER-SIDE (Code.gs) and rendered as-is.
// Removed entirely: defect-closure rate, kitchen/coordinator digest cards, training compliance, the
// exceptional-events analysis, and the "no data source" placeholder metrics. No "לא זמין" placeholder
// panels remain — a source that isn't wired yet simply isn't shown (it returns via its own increment).
//
// Dependency-free except for sibling PURE modules; unit-tested under node:test. management.html mirrors
// this logic inline for rendering (same pattern as the other pages).

import { isOverdue, isBlocked } from './sla.js';
import { STATUSES } from './schema.js';

// A request is terminal (no longer actionable) at הושלם / סגור / לא מאושר.
const TERMINAL = [STATUSES.COMPLETED, STATUSES.CLOSED, STATUSES.NOT_APPROVED];

function isOpenRequest(r) {
  return r && TERMINAL.indexOf(String(r.status)) === -1;
}

function toMs(now) {
  if (now instanceof Date) return now.getTime();
  const n = new Date(now);
  return isNaN(n.getTime()) ? Date.now() : n.getTime();
}

// ---- Panel: requests SLA / delays (הצפת עיכובים) ----
// Open requests, how many are overdue / blocked, broken down by house. Worst-first list of the
// overdue ones so the biggest delays surface immediately.
export function requestsPanel(requests, now) {
  const open = (requests || []).filter(isOpenRequest);
  const byHouse = {};
  open.forEach((r) => {
    const h = String(r.house || '');
    const b = byHouse[h] || (byHouse[h] = { house: h, open: 0, overdue: 0, blocked: 0 });
    b.open++;
    if (isOverdue(r.due_at, r.status, now)) b.overdue++;
    if (isBlocked(r.blocked)) b.blocked++;
  });
  const overdue = open.filter((r) => isOverdue(r.due_at, r.status, now));
  const blocked = open.filter((r) => isBlocked(r.blocked));
  const worst = overdue
    .map((r) => ({ id: r.id, house: r.house, description: r.description, urgency: r.urgency,
      days_overdue: Math.floor((toMs(now) - new Date(r.due_at).getTime()) / 86400000),
      blocked: isBlocked(r.blocked) }))
    .sort((a, b) => b.days_overdue - a.days_overdue);
  return {
    openCount: open.length,
    overdueCount: overdue.length,
    blockedCount: blocked.length,
    byHouse: Object.keys(byHouse).sort().map((k) => byHouse[k]),
    worst: worst,
  };
}

// ---- Panel: recurring defects (אירועים חוזרים), from Requests ONLY ----
// A recurring defect = the SAME house with the SAME category + normalized description filed ≥2 times
// within the last `windowDays` (default 90). No scores, no levels — just the flat list of what keeps
// coming back, most-recurring first. Requests older than the window, or with no house, are ignored.
export const RECURRENCE_WINDOW_DAYS = 90;
export const RECURRENCE_MIN = 2;

function normText(v) {
  return String(v == null ? '' : v).trim().replace(/\s+/g, ' ').toLowerCase();
}

export function recurringDefectsFromRequests(requests, now, windowDays) {
  const win = (windowDays || RECURRENCE_WINDOW_DAYS) * 86400000;
  const nowMs = toMs(now);
  const groups = {};
  (requests || []).forEach((r) => {
    if (!r || !r.house) return;
    const t = new Date(r.created_at).getTime();
    if (isNaN(t) || (nowMs - t) > win || t > nowMs) return; // only within the trailing window
    const cat = String(r.category || '').trim();
    const descNorm = normText(r.description);
    if (!cat && !descNorm) return; // nothing to group on
    const label = String(r.description || '').trim() || cat; // human display: description, else category
    const key = String(r.house) + '|' + cat + '|' + descNorm;
    const g = groups[key] || (groups[key] = { house: String(r.house), category: cat, description: label, count: 0 });
    g.count++;
  });
  return Object.keys(groups)
    .map((k) => groups[k])
    .filter((g) => g.count >= RECURRENCE_MIN)
    .sort((a, b) => b.count - a.count || String(a.house).localeCompare(String(b.house), 'he'));
}

// ---- Readiness checklists (opening / emergency) ----
// A checklist row is { id, house, item, done, date, by }. Shape flat rows into per-house groups, but
// ONLY for the houses passed in (an unmapped house on a row is omitted, never guessed). `done` is
// tolerant of TRUE / 'TRUE' / '1' / boolean. Pure — the sheet read + writes live in Code.gs.
export function isDoneCell(v) {
  if (v === true || v === 1) return true;
  return ['TRUE', '1'].indexOf(String(v == null ? '' : v).trim().toUpperCase()) !== -1;
}

export function readinessByHouse(rows, houses) {
  const byHouse = {};
  const order = [];
  (houses || []).forEach((h) => {
    const name = h && h.name; if (!name || byHouse[name]) return;
    byHouse[name] = { house: name, items: [], doneCount: 0, total: 0 };
    order.push(name);
  });
  (rows || []).forEach((row) => {
    if (!row || !row.house) return;
    const b = byHouse[row.house]; if (!b) return; // unmapped house → omit
    const done = isDoneCell(row.done);
    b.items.push({ id: row.id, item: row.item, done: done, date: row.date || '', by: row.by || '' });
    b.total++; if (done) b.doneCount++;
  });
  return order.map((k) => byHouse[k]);
}

// The whole screen payload built from owned arrays. `now` is passed in (deterministic + testable).
// budget / compliance / maintenance are computed server-side and merged by the caller — not here.
export function buildManagementSummary(data, now) {
  const d = data || {};
  const houses = d.houses || [];
  const preOpening = houses.filter((h) => String(h.status) === 'pre-opening');
  return {
    requests: requestsPanel(d.requests || [], now),
    recurringDefects: recurringDefectsFromRequests(d.requests || [], now),
    openingReadiness: readinessByHouse(d.openingChecklist || [], preOpening),
    emergencyReadiness: readinessByHouse(d.emergencyReadiness || [], houses),
  };
}
