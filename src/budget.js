// budget.js — budget adherence per house per month (עמידה בתקציב) for the /management screen.
//
// Budgets come from the Budgets sheet (one row per house-id per YYYY-MM). Actuals are derived from
// data this repo already owns — Requests cost — via ONE attribution rule (attributeRequest). All of
// this is PURE and unit-tested; the MIRROR:budget block is duplicated verbatim in apps-script/Code.gs
// (the mirror-drift guard asserts they stay identical), which is where it actually runs — inside the
// canManage-gated managementData handler. FINANCIAL DATA NEVER ENTERS ANY DIGEST.
//
// Discipline: a house/period with no budget row renders "not defined", NEVER 0 and never assumed; a
// malformed budget row (bad period / non-numeric amount) is skipped and logged, never miscounted; an
// unmapped house id (a typo in the Budgets tab) is SURFACED to the screen, never silently dropped.
//
// THE ONE spend definition (PR 4 — the page renders these rows as-is, no client recomputation):
//   every request that is not rejected (לא מאושר), attributed to the ISRAEL-TIME month of completed_at when
//   completed, else of created_at, with cost = actual_cost, else estimated_cost (flagged "כולל אומדנים").

// === MIRROR:budget START ===
// The one time zone every budget month is computed in — the 1st of the month is the 1st in ISRAEL, on the
// server (Code.gs) and on the client alike, never UTC.
var BUDGET_TZ = 'Asia/Jerusalem';

// A cell → a number, or null when blank/non-numeric (so blanks never coerce to 0).
function budgetNum(v) {
  if (v == null) return null;
  var s = String(v).replace(/^\s+|\s+$/g, '');
  if (s === '') return null;
  var n = Number(s);
  return isFinite(n) ? n : null;
}

// The calendar month (YYYY-MM) of a timestamp IN ISRAEL TIME (BUDGET_TZ). Accepts a Date, an ISO string or a
// date-only string. A value that is not a parseable date falls back to its own YYYY-MM prefix; a runtime
// without Intl falls back to the UTC month. '' when nothing usable.
function periodInJerusalem(value) {
  if (value == null) return '';
  var d = (value instanceof Date) ? value : null;
  var s = d ? '' : String(value).replace(/^\s+|\s+$/g, '');
  if (!d) {
    if (s === '') return '';
    d = new Date(s);
  }
  if (isNaN(d.getTime())) {
    var m = s.match(/^(\d{4})-(\d{2})/);
    return m ? (m[1] + '-' + m[2]) : '';
  }
  try {
    var parts = new Intl.DateTimeFormat('en-US', { timeZone: BUDGET_TZ, year: 'numeric', month: '2-digit' }).formatToParts(d);
    var y = '', mo = '';
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].type === 'year') y = parts[i].value;
      if (parts[i].type === 'month') mo = parts[i].value;
    }
    if (/^\d{4}$/.test(y) && /^\d{2}$/.test(mo)) return y + '-' + mo;
  } catch (e) {}
  return d.toISOString().slice(0, 7);
}

// THE SPEND MONTH RULE: a request's spend is attributed to the Israel-time month of completed_at once
// completed, else of created_at. '' when neither parses.
function requestPeriod(request) {
  var basis = (request && request.completed_at != null && String(request.completed_at).replace(/^\s+|\s+$/g, '') !== '')
    ? request.completed_at : (request ? request.created_at : '');
  return periodInJerusalem(basis);
}

// THE SPEND AMOUNT RULE: actual_cost if present, else a fallback to estimated_cost — and WHICH one was used.
// { amount:null, source:null } when neither is a number.
function requestActual(request) {
  var a = budgetNum(request ? request.actual_cost : null);
  if (a != null) return { amount: a, source: 'actual' };
  var e = budgetNum(request ? request.estimated_cost : null);
  if (e != null) return { amount: e, source: 'estimated' };
  return { amount: null, source: null };
}

// THE attribution rule: one request → one spend line { houseId, period, amount, source }, or null when
// it is not a spend line. Not spend: a rejected request (לא מאושר), a house that is not a canonical id
// (omitted, never guessed — surfaced by computeAdherence as unmappedRequestHouses), no attributable month,
// or no cost at all. Every OTHER status counts (open, approved, in progress, completed, closed).
function attributeRequest(request, nameToId) {
  if (!request) return null;
  if (String(request.status) === 'לא מאושר') return null;
  var name = String(request.house == null ? '' : request.house).replace(/^\s+|\s+$/g, '');
  var map = nameToId || {};
  if (!Object.prototype.hasOwnProperty.call(map, name)) return null;
  var period = requestPeriod(request);
  if (!period) return null;
  var act = requestActual(request);
  if (act.amount == null) return null;
  return { houseId: map[name], period: period, amount: act.amount, source: act.source };
}

// Parse + validate one Budgets row → { houseId, period, amount } or null (malformed → logged, skipped).
function parseBudgetRow(row, log) {
  var house = String(row && row.house != null ? row.house : '').replace(/^\s+|\s+$/g, '');
  var period = String(row && row.period != null ? row.period : '').replace(/^\s+|\s+$/g, '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    if (log) log('budget: bad period "' + period + '" for house "' + house + '" — row skipped');
    return null;
  }
  var amount = budgetNum(row ? row.amount : null);
  if (amount == null || amount < 0) {
    if (log) log('budget: non-numeric/negative amount for house "' + house + '" ' + period + ' — row skipped');
    return null;
  }
  if (!house) {
    if (log) log('budget: missing house for period ' + period + ' — row skipped');
    return null;
  }
  return { houseId: house, period: period, amount: amount };
}

// Adherence for ONE period. maps: { nameToId, idToName }. Returns per-house rows (worst-first) plus what the
// screen must SURFACE so nothing is silently dropped:
//   skipped               — count of malformed Budgets rows (bad period / amount / missing house), any period
//   unmappedHouses        — Budgets house ids (this period) that are not canonical ids (a typo in the tab)
//   unmappedRequestHouses — Requests house names (this period) that map to no canonical id
//   usedEstimated         — true when ANY row's spend includes an estimated_cost fallback
// A house with an actual but no budget row is shown with budgetDefined=false ("not defined") — never a
// fabricated 0 budget. A house with a budget but no spend shows actual 0.
function computeAdherence(budgets, requests, maps, period, log) {
  var nameToId = (maps && maps.nameToId) || {};
  var idToName = (maps && maps.idToName) || {};

  var budgetByHouse = {};
  var skipped = 0;
  var unmapped = {};
  for (var i = 0; i < (budgets || []).length; i++) {
    var b = parseBudgetRow(budgets[i], log);
    if (!b) { skipped++; continue; }
    if (b.period !== period) continue;
    if (!Object.prototype.hasOwnProperty.call(idToName, b.houseId)) {
      if (log) log('budget: unknown house id "' + b.houseId + '" — row not counted');
      unmapped[b.houseId] = true; continue;
    }
    budgetByHouse[b.houseId] = (budgetByHouse[b.houseId] || 0) + b.amount;
  }

  var actualByHouse = {};
  var usedEstimated = {};
  var unmappedReq = {};
  for (var j = 0; j < (requests || []).length; j++) {
    var req = requests[j];
    var a = attributeRequest(req, nameToId);
    if (!a) {
      // Surface a request of THIS period whose house maps to no canonical id (never guessed, never silent).
      if (req && String(req.status) !== 'לא מאושר' && requestPeriod(req) === period) {
        var hn = String(req.house == null ? '' : req.house).replace(/^\s+|\s+$/g, '');
        if (hn && !Object.prototype.hasOwnProperty.call(nameToId, hn)) unmappedReq[hn] = true;
      }
      continue;
    }
    if (a.period !== period) continue;
    actualByHouse[a.houseId] = (actualByHouse[a.houseId] || 0) + a.amount;
    if (a.source === 'estimated') usedEstimated[a.houseId] = true;
  }

  var ids = {};
  var k;
  for (k in budgetByHouse) if (Object.prototype.hasOwnProperty.call(budgetByHouse, k)) ids[k] = true;
  for (k in actualByHouse) if (Object.prototype.hasOwnProperty.call(actualByHouse, k)) ids[k] = true;

  var rows = [];
  var anyEstimated = false;
  for (var id in ids) {
    if (!Object.prototype.hasOwnProperty.call(ids, id)) continue;
    var hasBudget = Object.prototype.hasOwnProperty.call(budgetByHouse, id);
    var actual = actualByHouse[id] || 0;
    var row = { id: id, house: idToName[id] || id, actual: actual, usedEstimated: !!usedEstimated[id], budgetDefined: hasBudget };
    if (row.usedEstimated) anyEstimated = true;
    if (hasBudget) {
      var budget = budgetByHouse[id];
      row.budget = budget;
      row.remaining = budget - actual;
      row.percentUsed = budget > 0 ? Math.round((100 * actual) / budget) : null;
      row.over = actual > budget;
    } else {
      row.over = false;
    }
    rows.push(row);
  }

  rows.sort(function (x, y) {
    if ((x.over ? 1 : 0) !== (y.over ? 1 : 0)) return (y.over ? 1 : 0) - (x.over ? 1 : 0);
    var xp = x.budgetDefined ? (x.percentUsed == null ? -1 : x.percentUsed) : -2;
    var yp = y.budgetDefined ? (y.percentUsed == null ? -1 : y.percentUsed) : -2;
    if (xp !== yp) return yp - xp;
    return x.house < y.house ? -1 : x.house > y.house ? 1 : 0;
  });

  var unmappedList = [];
  for (k in unmapped) if (Object.prototype.hasOwnProperty.call(unmapped, k)) unmappedList.push(k);
  var unmappedReqList = [];
  for (k in unmappedReq) if (Object.prototype.hasOwnProperty.call(unmappedReq, k)) unmappedReqList.push(k);
  unmappedList.sort();
  unmappedReqList.sort();

  return { period: period, houses: rows, skipped: skipped, unmappedHouses: unmappedList, unmappedRequestHouses: unmappedReqList, usedEstimated: anyEstimated };
}

// Periods offered by the month selector: ONLY months that have a (valid, mapped) Budgets row or an
// attributable request under the same rule — most-recent first. The current month is NOT added by itself.
function budgetPeriods(budgets, requests, maps) {
  var nameToId = (maps && maps.nameToId) || {};
  var idToName = (maps && maps.idToName) || {};
  var set = {};
  for (var i = 0; i < (budgets || []).length; i++) {
    var b = parseBudgetRow(budgets[i], null);
    if (b && Object.prototype.hasOwnProperty.call(idToName, b.houseId)) set[b.period] = true;
  }
  for (var j = 0; j < (requests || []).length; j++) {
    var a = attributeRequest(requests[j], nameToId);
    if (a) set[a.period] = true;
  }
  var out = [];
  for (var p in set) if (Object.prototype.hasOwnProperty.call(set, p)) out.push(p);
  out.sort(function (x, y) { return x < y ? 1 : x > y ? -1 : 0; }); // most-recent first
  return out;
}
// === MIRROR:budget END ===

export {
  BUDGET_TZ, budgetNum, periodInJerusalem, requestPeriod, requestActual, attributeRequest, parseBudgetRow, computeAdherence, budgetPeriods,
};
