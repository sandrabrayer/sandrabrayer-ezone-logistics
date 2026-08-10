// maintenance.js — preventive-maintenance scheduler (תחזוקה מונעת) for the /management screen.
//
// Olga defines recurring tasks per house in the MaintenancePlan sheet (id, house, task,
// frequency_months, last_done, active, notes). house is a CANONICAL id (HOUSE-IDS.md) OR the literal
// 'all' (every OPEN house). last_done blank = never done → due immediately. next_due / days_until /
// overdue are DERIVED here and NEVER stored. A scheduled pass turns a due task into a NORMAL Request
// (category תיקון, urgency רגיל, created_by "מערכת - תחזוקה מונעת") linked by plan_id; when that
// request reaches הושלם, the plan row's last_done is written back (the one write to the plan sheet).
//
// All of this is PURE and unit-tested; the MIRROR:maintenance block below is duplicated verbatim in
// apps-script/Code.gs (the mirror-drift guard asserts they stay identical), which is where it runs
// inside the canManage-gated managementData handler and the time-based scan trigger.
//
// Discipline: a house with no plan rows renders "not defined", NEVER 0; a malformed plan row (missing
// id/task, bad frequency, unknown house id) is skipped and logged, never miscounted; a duplicate OPEN
// request for the same plan+house is never created twice.

// === MIRROR:maintenance START ===
// Two-digit zero-pad for a month/day number.
function maintPad2(n) { return n < 10 ? '0' + n : '' + n; }

// A cell → a POSITIVE integer, or null when blank / non-numeric / not a positive whole number (so a
// bad frequency never coerces to a silent default).
function maintNum(v) {
  if (v == null) return null;
  var s = String(v).replace(/^\s+|\s+$/g, '');
  if (s === '') return null;
  var n = Number(s);
  if (!isFinite(n) || n <= 0 || Math.floor(n) !== n) return null;
  return n;
}

// TRUE/FALSE cell → boolean. Only the explicit 'TRUE' (any case) is active; blank / anything else is
// inactive (an inactive plan never generates a request and is not tracked in the panel).
function maintActive(v) {
  return String(v == null ? '' : v).replace(/^\s+|\s+$/g, '').toUpperCase() === 'TRUE';
}

// Any date-ish cell → 'YYYY-MM-DD', or '' when blank / unparseable. Handles (a) a real Date object —
// Apps Script hands one back for a cell the sheet already parsed (e.g. spreadsheet locale = Israel),
// trusted as-is; (b) an ISO string yyyy-mm-dd (optionally with a time suffix); and (c) an Israeli
// DAY-FIRST text date d/m/y or d.m.y (12/7/2026, 12.7.26, 12/07/2026) — ALWAYS day-first, NEVER
// month-first; a 2-digit year is 20xx. An impossible date (13/13/2026, 31/2/2026) → '' (the caller
// skips + logs). The day-first branch is the safety net for cells stored as TEXT; with the spreadsheet
// locale set to Israel, Sheets already returns a Date object and branch (a) trusts it.
function maintDateOnly(v) {
  if (v == null) return '';
  if (typeof v === 'object' && typeof v.getFullYear === 'function' && isFinite(v.getTime())) {
    return v.getFullYear() + '-' + maintPad2(v.getMonth() + 1) + '-' + maintPad2(v.getDate());
  }
  var s = String(v).replace(/^\s+|\s+$/g, '');
  var iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3];
  var dmy = s.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{2}|\d{4})$/);
  if (dmy) {
    var day = Number(dmy[1]), mon = Number(dmy[2]), yr = Number(dmy[3]);
    if (dmy[3].length === 2) yr += 2000;
    if (mon < 1 || mon > 12 || day < 1 || day > 31) return '';
    var dt = new Date(Date.UTC(yr, mon - 1, day));
    if (dt.getUTCFullYear() !== yr || dt.getUTCMonth() !== mon - 1 || dt.getUTCDate() !== day) return '';
    return yr + '-' + maintPad2(mon) + '-' + maintPad2(day);
  }
  return '';
}

// 'YYYY-MM-DD' → UTC epoch ms at midnight, or null when unparseable.
function ymdToUTC(ymd) {
  var m = String(ymd).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// Days in a (UTC) month; mZeroBased is 0..11.
function daysInMonthUTC_(y, mZeroBased) {
  return new Date(Date.UTC(y, mZeroBased + 1, 0)).getUTCDate();
}

// Add whole months to a 'YYYY-MM-DD' (clamping the day to the target month's length, so
// 2026-01-31 + 1 month = 2026-02-28). Returns '' when the input is unparseable.
function addMonthsToDate(ymd, months) {
  var m = String(ymd).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  var y = Number(m[1]);
  var mo = Number(m[2]) - 1;
  var d = Number(m[3]);
  var total = mo + months;
  var ny = y + Math.floor(total / 12);
  var nm = total % 12;
  if (nm < 0) { nm += 12; ny -= 1; }
  var dim = daysInMonthUTC_(ny, nm);
  var nd = d > dim ? dim : d;
  return ny + '-' + maintPad2(nm + 1) + '-' + maintPad2(nd);
}

// Whole days from fromYmd to toYmd (to - from), or null when either is unparseable.
function maintDaysBetween(fromYmd, toYmd) {
  var a = ymdToUTC(fromYmd), b = ymdToUTC(toYmd);
  if (a == null || b == null) return null;
  return Math.round((b - a) / 86400000);
}

// Derived status of ONE task as of nowDay ('YYYY-MM-DD'): { nextDue, daysUntil, overdue }.
//   - blank last_done (never done) OR bad frequency → due immediately: { nextDue:'', daysUntil:0, overdue:true }.
//   - else nextDue = last_done + frequency months; daysUntil = nextDue - now; overdue = daysUntil <= 0.
function planTaskStatus(lastDone, frequencyMonths, nowDay) {
  var last = maintDateOnly(lastDone);
  var freq = maintNum(frequencyMonths);
  if (!last || freq == null) return { nextDue: '', daysUntil: 0, overdue: true };
  var nextDue = addMonthsToDate(last, freq);
  var daysUntil = maintDaysBetween(nowDay, nextDue);
  if (daysUntil == null) return { nextDue: nextDue, daysUntil: 0, overdue: true };
  return { nextDue: nextDue, daysUntil: daysUntil, overdue: daysUntil <= 0 };
}

// Parse + validate one MaintenancePlan row → normalized object, or null (malformed → logged, skipped).
// idToName is the canonical-id → name map; house must be 'all' or one of its keys.
function parsePlanRow(row, idToName, log) {
  var idMap = idToName || {};
  var id = String(row && row.id != null ? row.id : '').replace(/^\s+|\s+$/g, '');
  var house = String(row && row.house != null ? row.house : '').replace(/^\s+|\s+$/g, '');
  var task = String(row && row.task != null ? row.task : '').replace(/^\s+|\s+$/g, '');
  if (!id) { if (log) log('maintenance: plan row missing id — skipped'); return null; }
  if (!task) { if (log) log('maintenance: plan "' + id + '" missing task — skipped'); return null; }
  var freq = maintNum(row ? row.frequency_months : null);
  if (freq == null) { if (log) log('maintenance: plan "' + id + '" bad frequency_months — skipped'); return null; }
  if (house !== 'all' && !Object.prototype.hasOwnProperty.call(idMap, house)) {
    if (log) log('maintenance: plan "' + id + '" unknown house "' + house + '" — skipped');
    return null;
  }
  return {
    id: id, house: house, task: task, frequency: freq,
    lastDone: maintDateOnly(row ? row.last_done : ''),
    active: maintActive(row ? row.active : ''),
    notes: String(row && row.notes != null ? row.notes : '')
  };
}

// A plan's target house(s) → array of canonical ids. 'all' → every OPEN house; a specific id → itself.
function expandHouses(house, openHouseIds) {
  if (house === 'all') return (openHouseIds || []).slice();
  return [house];
}

// The request-input for a generated maintenance task. A NORMAL request (תיקון / רגיל) — it flows
// through the same approval chain + SLA as any request. plan_id links it back to its plan row.
function maintenanceRequestInput(target) {
  return {
    house: target.houseName,
    category: 'תיקון',
    urgency: 'רגיל',
    description: target.task + ' (תחזוקה מונעת)',
    location_in_house: '',
    estimated_cost: '',
    created_by: 'מערכת - תחזוקה מונעת',
    plan_id: target.planId
  };
}

// A completed request → { planId, day } to write back to its plan's last_done, or null when the
// request is not plan-linked or has no completion date. Idempotent to compute (pure).
function planLastDoneOnComplete(request) {
  if (!request) return null;
  var planId = String(request.plan_id == null ? '' : request.plan_id).replace(/^\s+|\s+$/g, '');
  if (!planId) return null;
  var day = maintDateOnly(request.completed_at);
  if (!day) return null;
  return { planId: planId, day: day };
}

// The set of statuses that mean a generated request is CLOSED-OUT and no longer blocks a re-generation.
var MAINT_TERMINAL_ = { 'הושלם': 1, 'סגור': 1, 'לא מאושר': 1 };

// Decide what to generate this pass. Returns { toCreate:[{planId,houseId,houseName,task}],
// skippedDuplicate, skippedMalformed, skippedInactive }. A task generates only when it is due
// (overdue==true). It is SKIPPED when a non-terminal (still-open) request already exists for the same
// plan_id + house — no duplicate open request is ever created. maps: { idToName }.
function planGenerationPlan(plans, requests, openHouseIds, maps, nowDay, log) {
  var idToName = (maps && maps.idToName) || {};
  var openKeys = {};
  for (var r = 0; r < (requests || []).length; r++) {
    var req = requests[r];
    var pid = String(req && req.plan_id != null ? req.plan_id : '').replace(/^\s+|\s+$/g, '');
    if (!pid) continue;
    var st = String(req && req.status != null ? req.status : '').replace(/^\s+|\s+$/g, '');
    if (Object.prototype.hasOwnProperty.call(MAINT_TERMINAL_, st)) continue;
    var hn = String(req && req.house != null ? req.house : '').replace(/^\s+|\s+$/g, '');
    openKeys[pid + '|' + hn] = true;
  }
  var toCreate = [], skippedDuplicate = 0, skippedMalformed = 0, skippedInactive = 0;
  for (var i = 0; i < (plans || []).length; i++) {
    var plan = parsePlanRow(plans[i], idToName, log);
    if (!plan) { skippedMalformed++; continue; }
    if (!plan.active) { skippedInactive++; continue; }
    var status = planTaskStatus(plan.lastDone, plan.frequency, nowDay);
    if (!status.overdue) continue;
    var houseIds = expandHouses(plan.house, openHouseIds);
    for (var h = 0; h < houseIds.length; h++) {
      var houseId = houseIds[h];
      var houseName = idToName[houseId] || houseId;
      var key = plan.id + '|' + houseName;
      if (openKeys[key]) { skippedDuplicate++; continue; }
      toCreate.push({ planId: plan.id, houseId: houseId, houseName: houseName, task: plan.task });
      openKeys[key] = true; // guard two plan rows for the same plan+house within one pass
    }
  }
  return {
    toCreate: toCreate, skippedDuplicate: skippedDuplicate,
    skippedMalformed: skippedMalformed, skippedInactive: skippedInactive
  };
}

// Plan-adherence panel data: per-house tasks (worst-first) as of nowDay, plus a skipped (malformed)
// count. Open houses are ALWAYS listed (a house with no active plan row → planDefined:false →
// "not defined", never a fabricated 0). maps: { idToName }.
function planAdherence(plans, maps, openHouseIds, nowDay, log) {
  var idToName = (maps && maps.idToName) || {};
  var openIds = openHouseIds || [];
  var tasksByHouse = {};
  var skipped = 0;
  function ensure(id) {
    if (!Object.prototype.hasOwnProperty.call(tasksByHouse, id)) tasksByHouse[id] = [];
    return tasksByHouse[id];
  }
  for (var o = 0; o < openIds.length; o++) ensure(openIds[o]);
  for (var i = 0; i < (plans || []).length; i++) {
    var plan = parsePlanRow(plans[i], idToName, log);
    if (!plan) { skipped++; continue; }
    if (!plan.active) continue;
    var status = planTaskStatus(plan.lastDone, plan.frequency, nowDay);
    var houseIds = expandHouses(plan.house, openIds);
    for (var h = 0; h < houseIds.length; h++) {
      ensure(houseIds[h]).push({
        task: plan.task, lastDone: plan.lastDone, frequency: plan.frequency,
        nextDue: status.nextDue, daysUntil: status.daysUntil, overdue: status.overdue
      });
    }
  }
  var houses = [];
  for (var id in tasksByHouse) {
    if (!Object.prototype.hasOwnProperty.call(tasksByHouse, id)) continue;
    var tasks = tasksByHouse[id];
    tasks.sort(function (a, b) {
      if ((a.overdue ? 1 : 0) !== (b.overdue ? 1 : 0)) return (b.overdue ? 1 : 0) - (a.overdue ? 1 : 0);
      if (a.daysUntil !== b.daysUntil) return a.daysUntil - b.daysUntil;
      return a.task < b.task ? -1 : a.task > b.task ? 1 : 0;
    });
    var overdueCount = 0;
    for (var t = 0; t < tasks.length; t++) if (tasks[t].overdue) overdueCount++;
    houses.push({
      id: id, house: idToName[id] || id, planDefined: tasks.length > 0,
      tasks: tasks, overdueCount: overdueCount
    });
  }
  houses.sort(function (a, b) {
    if (a.overdueCount !== b.overdueCount) return b.overdueCount - a.overdueCount;
    return a.house < b.house ? -1 : a.house > b.house ? 1 : 0;
  });
  return { houses: houses, skipped: skipped };
}
// === MIRROR:maintenance END ===

export {
  maintPad2, maintNum, maintActive, maintDateOnly, ymdToUTC, daysInMonthUTC_,
  addMonthsToDate, maintDaysBetween, planTaskStatus, parsePlanRow, expandHouses,
  maintenanceRequestInput, planLastDoneOnComplete, planGenerationPlan, planAdherence,
};
