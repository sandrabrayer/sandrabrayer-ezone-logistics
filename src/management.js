// management.js — pure aggregation for the /management screen (increment 37), role-gated to
// ops_manager + ceo. Built STRICTLY from data this repo owns (Requests, Inspections,
// InspectionFindings, Houses, InventoryItems/Counts). It reads nothing from another app.
//
// HONESTY RULE (the whole point of this screen): never render absent data as zero. A metric with no
// underlying data returns { available: false, reason } via unavailable(), and the UI shows it as
// "לא זמין", NOT as 0. Anything that would need the kitchen/coordinator digest, a budget source, a
// training/adoption source, or clinical records is listed in UNAVAILABLE_CAPABILITIES — those
// sources are not wired in this repo, so we report them rather than invent a number.
//
// Dependency-free except for sibling PURE modules; unit-tested under node:test. management.html
// mirrors this logic inline for rendering (same pattern as the other pages).

import { isOverdue, isBlocked } from './sla.js';
import { STATUSES } from './schema.js';

// A request is "closed" (no longer actionable) at הושלם / סגור; terminal also includes לא מאושר.
const CLOSED = [STATUSES.COMPLETED, STATUSES.CLOSED];
const TERMINAL = [STATUSES.COMPLETED, STATUSES.CLOSED, STATUSES.NOT_APPROVED];

/** Marker for a metric that has no data source wired — rendered as "לא זמין", never as 0. */
export function unavailable(reason) {
  return { available: false, reason: reason };
}
function value(v) {
  return { available: true, value: v };
}

function isOpenRequest(r) {
  return r && TERMINAL.indexOf(String(r.status)) === -1;
}

// JD capabilities that map to data NOT available anywhere in this repo (category (c)). Each is shown
// explicitly as unavailable, with what would need to be built — never faked with a placeholder number.
export const UNAVAILABLE_CAPABILITIES = [
  { key: 'budget_adherence', label: 'עמידה בתקציב', reason: 'אין מקור נתוני תקציב — נדרש גיליון/מקור תקציבים לכל בית להשוואה מול ההוצאה בפועל.' },
  { key: 'food_quality', label: 'איכות ובטיחות מזון', reason: 'בבעלות אפליקציית המטבח (ezone-kitchen); נדרשת קריאת דייג׳סט המטבח (טרם חוברה).' },
  { key: 'preventive_maintenance', label: 'עמידה בתוכנית תחזוקה מונעת', reason: 'אין מקור לתוכנית תחזוקה מונעת/תקופתית — הדרישות כיום תגובתיות בלבד.' },
  { key: 'training_adherence', label: 'עמידה בתוכנית הדרכה', reason: 'אין מקור נתוני הדרכת מדריכים.' },
  { key: 'systems_adoption', label: 'הטמעת מערכות', reason: 'אין מקור נתוני הטמעת תוכנות/אפליקציות.' },
  { key: 'record_quality', label: 'איכות הרשומה המקצועית ועמידה בדרישות משרד הבריאות', reason: 'בבעלות האפליקציות הקליניות (outpatient/therapists); אינו בתחום הלוגיסטיקה.' },
];

// ---- Panel: requests SLA / delays (Roy's הצפת עיכובים) ----
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

// ---- Panel: defect closure on time (Olga's סגירת ליקויים במועד) ----
// A "defect" is a physical_defect finding. Its corrective action is the linked request. Closure is
// on time when that request completed on or before its due_at. Findings with no linked request, or a
// still-open one, are OPEN. The on-time RATE is unavailable (not 0%) until some defect has closed
// against a due date to measure.
export function defectClosurePanel(findings, requests, now) {
  const reqById = {};
  (requests || []).forEach((r) => { reqById[String(r.id)] = r; });
  const defects = (findings || []).filter((f) => f && f.finding_type === 'physical_defect');
  let open = 0, onTime = 0, late = 0, closedNoDue = 0;
  defects.forEach((f) => {
    const rid = f.linked_request_id ? String(f.linked_request_id) : '';
    const r = rid ? reqById[rid] : null;
    if (!r || CLOSED.indexOf(String(r.status)) === -1) { open++; return; }  // unlinked or still open
    if (r.due_at && r.completed_at) {
      if (new Date(r.completed_at).getTime() <= new Date(r.due_at).getTime()) onTime++;
      else late++;
    } else {
      closedNoDue++;   // closed, but no due date to judge against — not counted in the rate
    }
  });
  const measured = onTime + late;
  return {
    totalDefects: defects.length,
    open: open,
    closedOnTime: onTime,
    closedLate: late,
    closedNoDueDate: closedNoDue,
    onTimeRate: measured > 0 ? value(Math.round((100 * onTime) / measured)) : unavailable('טרם נסגר ליקוי עם תאריך יעד למדידה'),
  };
}

// ---- Panel: house quality (רמת הבתים) + recurring defects (אירועים חריגים חוזרים) ----
// Per house: last inspection date, count of OPEN defects (physical_defect not yet turned into a
// request) by severity, and how many distinct defects RECUR (same text seen ≥2× at that house).
export function houseQualityPanel(houses, inspections, findings, now) {
  const insById = {};
  (inspections || []).forEach((i) => { if (i && i.id != null) insById[String(i.id)] = i; });

  const rows = {};
  (houses || []).forEach((h) => {
    rows[h.name] = {
      house: h.name, status: h.status || '',
      lastInspection: '', openFindings: { low: 0, medium: 0, high: 0 }, recurringDefects: 0,
    };
  });
  (inspections || []).forEach((i) => {
    const b = rows[i.house]; if (!b) return;
    const d = String(i.inspection_date || '');
    if (d && d > b.lastInspection) b.lastInspection = d;
  });

  // Open defects by severity + recurrence text tally, joined to house via the finding's inspection.
  const textTally = {};   // house -> normalized text -> count
  (findings || []).forEach((f) => {
    if (!f || f.finding_type !== 'physical_defect') return;
    const ins = insById[String(f.inspection_id)];
    const house = ins ? ins.house : '';
    const b = rows[house]; if (!b) return;
    if (!f.linked_request_id) {
      const sev = String(f.severity || '').toLowerCase();
      if (sev === 'low' || sev === 'medium' || sev === 'high') b.openFindings[sev]++;
      else b.openFindings.low++;   // unknown severity counts as low, never dropped
    }
    const key = String(f.finding_text || '').trim().replace(/\s+/g, ' ').toLowerCase();
    if (key) {
      const t = textTally[house] || (textTally[house] = {});
      t[key] = (t[key] || 0) + 1;
    }
  });
  Object.keys(textTally).forEach((house) => {
    const t = textTally[house];
    const recurring = Object.keys(t).filter((k) => t[k] >= 2).length;
    if (rows[house]) rows[house].recurringDefects = recurring;
  });

  return Object.keys(rows).map((k) => rows[k]);
}

// ---- Panel: spend monitoring (הוצאות / רכש — Logistics owns cost) ----
// Sums estimated + actual cost by house and by category. Budget ADHERENCE is deliberately NOT
// computed — there is no budget source — so it is reported as unavailable, not as 0.
export function spendPanel(requests) {
  const byHouse = {};
  const byCategory = {};
  let estimatedTotal = 0, actualTotal = 0;
  (requests || []).forEach((r) => {
    const est = Number(r.estimated_cost); const act = Number(r.actual_cost);
    const e = isFinite(est) ? est : 0; const a = isFinite(act) ? act : 0;
    estimatedTotal += e; actualTotal += a;
    const h = String(r.house || '');
    const bh = byHouse[h] || (byHouse[h] = { house: h, estimated: 0, actual: 0 });
    bh.estimated += e; bh.actual += a;
    const c = String(r.category || '');
    const bc = byCategory[c] || (byCategory[c] = { category: c, estimated: 0, actual: 0 });
    bc.estimated += e; bc.actual += a;
  });
  return {
    estimatedTotal: estimatedTotal,
    actualTotal: actualTotal,
    byHouse: Object.keys(byHouse).sort().map((k) => byHouse[k]),
    byCategory: Object.keys(byCategory).sort().map((k) => byCategory[k]),
    budgetAdherence: unavailable('אין יעד תקציב להשוואה — מוצגת ההוצאה בפועל בלבד'),
  };
}

// ---- Panel: pre-opening readiness (פתיחת בתים חדשים) ----
// For each pre-opening house: open requests, open defects, and whether a stock count was ever taken.
export function preOpeningPanel(houses, requests, inspections, findings, inventoryCounts) {
  const insById = {};
  (inspections || []).forEach((i) => { if (i && i.id != null) insById[String(i.id)] = i; });
  const counted = {};
  (inventoryCounts || []).forEach((c) => { if (c && c.house) counted[String(c.house)] = true; });

  const pre = (houses || []).filter((h) => String(h.status) === 'pre-opening');
  return pre.map((h) => {
    const openReqs = (requests || []).filter((r) => String(r.house) === String(h.name) && isOpenRequest(r)).length;
    const openDefects = (findings || []).filter((f) => {
      if (!f || f.finding_type !== 'physical_defect' || f.linked_request_id) return false;
      const ins = insById[String(f.inspection_id)];
      return ins && String(ins.house) === String(h.name);
    }).length;
    return {
      house: h.name,
      openRequests: openReqs,
      openDefects: openDefects,
      inventoryCounted: !!counted[String(h.name)],
    };
  });
}

// The whole screen payload, from the raw owned arrays. `now` is passed in (deterministic + testable).
export function buildManagementSummary(data, now) {
  const d = data || {};
  return {
    requests: requestsPanel(d.requests || [], now),
    defectClosure: defectClosurePanel(d.findings || [], d.requests || [], now),
    houseQuality: houseQualityPanel(d.houses || [], d.inspections || [], d.findings || [], now),
    spend: spendPanel(d.requests || []),
    preOpening: preOpeningPanel(d.houses || [], d.requests || [], d.inspections || [], d.findings || [], d.inventoryCounts || []),
    unavailable: UNAVAILABLE_CAPABILITIES,
  };
}

function toMs(now) {
  if (now instanceof Date) return now.getTime();
  const n = new Date(now);
  return isNaN(n.getTime()) ? Date.now() : n.getTime();
}
