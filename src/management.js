// management.js — pure aggregation for the /management screen (ops_manager), built STRICTLY from
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

// ---- Budget adherence (עמידה בתקציב) ----
// Actual spend per house = sum of actual_cost over COMPLETED/CLOSED requests (money actually spent). Budget
// per house comes from the Budgets sheet (passed as {house: amount}, derived server-side). Only houses with
// a positive budget appear. percentUsed rounded; over = spend past budget. Worst (highest %) first.
const COMPLETED_STATUSES = [STATUSES.COMPLETED, STATUSES.CLOSED];
export function budgetAdherenceByHouse(requests, budgetByHouse) {
  const spend = {};
  (requests || []).forEach((r) => {
    if (!r || COMPLETED_STATUSES.indexOf(String(r.status)) === -1) return;
    const a = Number(r.actual_cost);
    if (!isFinite(a) || a <= 0) return;
    const h = String(r.house || ''); if (!h) return;
    spend[h] = (spend[h] || 0) + a;
  });
  const out = [];
  Object.keys(budgetByHouse || {}).forEach((house) => {
    const budget = Number(budgetByHouse[house]);
    if (!isFinite(budget) || budget <= 0) return;
    const actual = spend[house] || 0;
    out.push({ house, budget, actual, remaining: budget - actual, percentUsed: Math.round((100 * actual) / budget), over: actual > budget });
  });
  out.sort((a, b) => b.percentUsed - a.percentUsed || String(a.house).localeCompare(String(b.house), 'he'));
  return out;
}

// Aggregate budget utilization across houses (the hub KPI). null when no positive budget is defined.
export function budgetTotalPercent(rows) {
  let b = 0, a = 0;
  (rows || []).forEach((r) => { b += Number(r.budget) || 0; a += Number(r.actual) || 0; });
  return b > 0 ? Math.round((100 * a) / b) : null;
}

// Completion % of a readiness group ({ total, doneCount }); null when there are no items.
export function readinessPercent(group) {
  return group && group.total > 0 ? Math.round((100 * group.doneCount) / group.total) : null;
}

// Average readiness % across houses (hub KPI); null when no house has any items.
export function readinessAveragePercent(groups) {
  const pcts = (groups || []).map((g) => readinessPercent(g)).filter((p) => p != null);
  if (!pcts.length) return null;
  return Math.round(pcts.reduce((s, p) => s + p, 0) / pcts.length);
}

// PreventiveDaily completion: per house, per date, how many distinct template items were done. total is the
// template length. `dates` is the list of YYYY-MM-DD to report (e.g. the last 7 days). Rows for unmapped
// houses are ignored.
export function preventiveCompletion(rows, template, houses, dates) {
  const total = (template || []).length;
  const done = {}; // 'house|date' -> Set(items)
  (rows || []).forEach((r) => {
    if (!r || !r.house || !r.date || !isDoneCell(r.done)) return;
    const k = String(r.house) + '|' + String(r.date).slice(0, 10);
    (done[k] || (done[k] = new Set())).add(String(r.item));
  });
  return (houses || []).map((h) => ({
    house: h.name,
    days: (dates || []).map((d) => ({ date: d, doneCount: (done[String(h.name) + '|' + d] || new Set()).size, total })),
  }));
}

// Trainings (מעקב הדרכות) grouped by house, newest-first. Rows whose house is not in `houses` are omitted.
export function trainingsByHouse(rows, houses) {
  const byHouse = {}, order = [];
  (houses || []).forEach((h) => { if (h && h.name && !byHouse[h.name]) { byHouse[h.name] = { house: h.name, items: [] }; order.push(h.name); } });
  (rows || []).forEach((r) => {
    if (!r || !r.house) return;
    const b = byHouse[r.house]; if (!b) return;
    b.items.push({ id: r.id, topic: r.topic || '', date: r.date || '', attended: r.attended || '', by: r.by || '' });
  });
  order.forEach((k) => byHouse[k].items.sort((a, b) => String(b.date).localeCompare(String(a.date))));
  return order.map((k) => byHouse[k]);
}

// The whole screen payload built from owned arrays. `now` is passed in (deterministic + testable).
// budget / maintenance are computed server-side and merged by the caller — not here.
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
