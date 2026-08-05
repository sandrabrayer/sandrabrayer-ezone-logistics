// management.js — pure aggregation for the /management screen (Olga's ניהול תפעולי רשת), role-gated
// to ops_manager + ceo. Built STRICTLY from data this repo owns (Requests, Houses, and two Logistics-
// owned checklists: OpeningChecklist, EmergencyReadiness). It reads nothing from another app.
//
// PR B cleanup: the screen was trimmed to what Logistics genuinely owns and can act on. Removed
// entirely — defect-closure-on-time, exceptional-events analysis, food shortages, training adherence,
// the 6-month trend, and the "no data source" placeholder section. Recurring issues are now derived
// from REQUESTS (not inspection findings), pre-opening readiness is a Logistics-owned checklist, and a
// new emergency-readiness checklist is added. Budget / preventive-maintenance / compliance stay and are
// computed server-side (Code.gs) — the browser only renders them.
//
// Dependency-free (pure JS, no Apps Script, no DOM) so node:test verifies it. management.html mirrors
// this logic inline for rendering (same pattern as the other pages).

import { STATUSES } from './schema.js';

// A request is "terminal" (no longer actionable) at הושלם / סגור / לא מאושר.
const TERMINAL = [STATUSES.COMPLETED, STATUSES.CLOSED, STATUSES.NOT_APPROVED];

function isOpenRequest(r) {
  return r && TERMINAL.indexOf(String(r.status)) === -1;
}

function toMs(now) {
  if (now instanceof Date) return now.getTime();
  const n = new Date(now);
  return isNaN(n.getTime()) ? Date.now() : n.getTime();
}

// TRUE when a checklist cell reads done (tolerant of boolean TRUE or the text 'TRUE'/'true'/'1').
export function isChecklistDone(v) {
  if (v === true || v === 1) return true;
  const s = String(v == null ? '' : v).trim().toUpperCase();
  return s === 'TRUE' || s === '1';
}

// ---- Panel: requests SLA / delays (הצפת עיכובים) ----
// Open requests, how many are overdue / blocked, by house, with a worst-first list of the overdue ones.
// isOverdue/isBlocked are passed in (from src/sla.js in the app) to keep this module dependency-light.
export function requestsPanel(requests, now, isOverdue, isBlocked) {
  const overdueFn = isOverdue || (() => false);
  const blockedFn = isBlocked || (() => false);
  const open = (requests || []).filter(isOpenRequest);
  const byHouse = {};
  open.forEach((r) => {
    const h = String(r.house || '');
    const b = byHouse[h] || (byHouse[h] = { house: h, open: 0, overdue: 0, blocked: 0 });
    b.open++;
    if (overdueFn(r.due_at, r.status, now)) b.overdue++;
    if (blockedFn(r.blocked)) b.blocked++;
  });
  const overdue = open.filter((r) => overdueFn(r.due_at, r.status, now));
  const blocked = open.filter((r) => blockedFn(r.blocked));
  const worst = overdue
    .map((r) => ({ id: r.id, house: r.house, description: r.description, urgency: r.urgency,
      days_overdue: Math.floor((toMs(now) - new Date(r.due_at).getTime()) / 86400000),
      blocked: blockedFn(r.blocked) }))
    .sort((a, b) => b.days_overdue - a.days_overdue);
  return {
    openCount: open.length,
    overdueCount: overdue.length,
    blockedCount: blocked.length,
    byHouse: Object.keys(byHouse).sort().map((k) => byHouse[k]),
    worst: worst,
  };
}

// ---- Panel: recurring issues from REQUESTS (רמת הבתים — אירועים חוזרים), SIMPLIFIED ----
// PR B: a single, simple list of recurring defects derived ONLY from Requests — the same house with the
// same category + description appearing ≥ RECUR_MIN times within RECUR_WINDOW_DAYS. No scores, no levels,
// no severities — just "this keeps coming back at this house." Sorted most-frequent first.
export const RECUR_MIN = 2;
export const RECUR_WINDOW_DAYS = 90;

function normText(s) {
  return String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toLowerCase();
}

export function recurringDefectsPanel(requests, now) {
  const cutoff = toMs(now) - RECUR_WINDOW_DAYS * 86400000;
  const groups = {};
  (requests || []).forEach((r) => {
    if (!r) return;
    const t = new Date(r.created_at).getTime();
    if (isNaN(t) || t < cutoff) return;                 // only the last RECUR_WINDOW_DAYS
    const house = String(r.house || '').trim();
    const category = String(r.category || '').trim();
    const description = String(r.description || '').trim();
    if (!house || (!category && !description)) return;
    const key = house + '||' + category + '||' + normText(description);
    const g = groups[key] || (groups[key] = { house, category, description, count: 0 });
    g.count++;
  });
  return Object.keys(groups)
    .map((k) => groups[k])
    .filter((g) => g.count >= RECUR_MIN)
    .sort((a, b) => b.count - a.count || a.house.localeCompare(b.house, 'he'));
}

// ---- Checklist readiness (shared shape for OpeningChecklist + EmergencyReadiness) ----
// Each checklist row: { house, item, done, date, by }. For the given houses, produce per-house progress
// (done/total) and the rows, so the UI shows exactly what is and isn't ready — never a fabricated number.
function checklistByHouse(houses, rows, houseNames) {
  const wanted = houseNames; // Set of house names to include
  const byHouse = {};
  (houses || []).forEach((h) => {
    if (!h || !h.name) return;
    if (wanted && !wanted.has(String(h.name))) return;
    byHouse[h.name] = { house: h.name, status: h.status || '', total: 0, done: 0, items: [] };
  });
  (rows || []).forEach((row) => {
    if (!row) return;
    const house = String(row.house || '');
    const b = byHouse[house];
    if (!b) return;                                     // a checklist row for an out-of-scope house is ignored
    const done = isChecklistDone(row.done);
    b.total++;
    if (done) b.done++;
    b.items.push({ item: String(row.item || ''), done, date: String(row.date || ''), by: String(row.by || '') });
  });
  return Object.keys(byHouse).map((k) => byHouse[k]);
}

// ---- Panel: pre-opening readiness (מוכנות בתים לפתיחה) — from the OpeningChecklist (Logistics-owned) ----
// Only pre-opening houses. Each shows its checklist progress; a house with no rows yet reads "טרם הוזנה"
// (total 0), never a fabricated ready/not-ready.
export function openingReadinessPanel(houses, openingChecklist) {
  const pre = new Set((houses || []).filter((h) => String(h.status) === 'pre-opening').map((h) => String(h.name)));
  return checklistByHouse(houses, openingChecklist, pre);
}

// ---- Panel: emergency readiness (בקרת מוכנות לזמן חירום) — from EmergencyReadiness (Logistics-owned) ----
// Every house (an emergency checklist applies open or pre-opening). Editable item list lives in the Sheet.
export function emergencyReadinessPanel(houses, emergencyReadiness) {
  return checklistByHouse(houses, emergencyReadiness, null);
}

// The whole owned-data screen payload, from the raw owned arrays. `now` is passed in (deterministic +
// testable). isOverdue/isBlocked are injected by the caller (the app passes src/sla.js). Budget /
// maintenance / compliance are computed SERVER-SIDE and merged by the client — not here.
export function buildManagementSummary(data, now, isOverdue, isBlocked) {
  const d = data || {};
  return {
    requests: requestsPanel(d.requests || [], now, isOverdue, isBlocked),
    recurringDefects: recurringDefectsPanel(d.requests || [], now),
    openingReadiness: openingReadinessPanel(d.houses || [], d.openingChecklist || []),
    emergencyReadiness: emergencyReadinessPanel(d.houses || [], d.emergencyReadiness || []),
  };
}
