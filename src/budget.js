// budget.js — budget adherence per house per month (עמידה בתקציב) for the /management screen.
//
// Budgets come from the Budgets sheet (one row per house-id per YYYY-MM). Actuals are derived from
// data this repo already owns — Requests cost — via ONE attribution rule (attributeRequest). All of
// this is PURE and unit-tested; the MIRROR:budget block is duplicated verbatim in apps-script/Code.gs
// (the mirror-drift guard asserts they stay identical), which is where it actually runs — inside the
// canManage-gated managementData handler. FINANCIAL DATA NEVER ENTERS ANY DIGEST.
//
// Discipline: a house/period with no budget row renders "not defined", NEVER 0 and never assumed; a
// malformed budget row (bad period / non-numeric amount) is skipped and logged, never miscounted.

// === MIRROR:budget START ===
// A cell → a number, or null when blank/non-numeric (so blanks never coerce to 0).
function budgetNum(v) {
  if (v == null) return null;
  var s = String(v).replace(/^\s+|\s+$/g, '');
  if (s === '') return null;
  var n = Number(s);
  return isFinite(n) ? n : null;
}

// The month (YYYY-MM) a request's spend is attributed to: the month of completed_at once completed,
// else the month of created_at. '' when neither parses.
function requestPeriod(request) {
  var basis = (request && request.completed_at != null && String(request.completed_at).replace(/^\s+|\s+$/g, '') !== '')
    ? request.completed_at : (request ? request.created_at : '');
  var m = String(basis == null ? '' : basis).match(/^(\d{4})-(\d{2})/);
  return m ? (m[1] + '-' + m[2]) : '';
}

// The spend amount for a request and WHICH field it came from: actual_cost if present, else a fallback
// to estimated_cost. { amount:null, source:null } when neither is a number.
function requestActual(request) {
  var a = budgetNum(request ? request.actual_cost : null);
  if (a != null) return { amount: a, source: 'actual' };
  var e = budgetNum(request ? request.estimated_cost : null);
  if (e != null) return { amount: e, source: 'estimated' };
  return { amount: null, source: null };
}

// THE attribution rule: one request → one spend line { houseId, period, amount, source }, or null when
// it is not a spend line. Not spend: a rejected request (לא מאושר), a house that is not a canonical id
// (omitted, never guessed), no attributable month, or no cost at all.
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

// Adherence for ONE period. maps: { nameToId, idToName }. Returns per-house rows (worst-first) plus a
// skipped count. A house with an actual but no budget row is shown with budgetDefined=false ("not
// defined") — never a fabricated 0 budget. A house with a budget but no spend shows actual 0.
function computeAdherence(budgets, requests, maps, period, log) {
  var nameToId = (maps && maps.nameToId) || {};
  var idToName = (maps && maps.idToName) || {};

  var budgetByHouse = {};
  var skipped = 0;
  for (var i = 0; i < (budgets || []).length; i++) {
    var b = parseBudgetRow(budgets[i], log);
    if (!b) { skipped++; continue; }
    if (b.period !== period) continue;
    if (!Object.prototype.hasOwnProperty.call(idToName, b.houseId)) {
      if (log) log('budget: unknown house id "' + b.houseId + '" — row skipped');
      skipped++; continue;
    }
    budgetByHouse[b.houseId] = (budgetByHouse[b.houseId] || 0) + b.amount;
  }

  var actualByHouse = {};
  var usedEstimated = {};
  for (var j = 0; j < (requests || []).length; j++) {
    var a = attributeRequest(requests[j], nameToId);
    if (!a || a.period !== period) continue;
    actualByHouse[a.houseId] = (actualByHouse[a.houseId] || 0) + a.amount;
    if (a.source === 'estimated') usedEstimated[a.houseId] = true;
  }

  var ids = {};
  var k;
  for (k in budgetByHouse) if (Object.prototype.hasOwnProperty.call(budgetByHouse, k)) ids[k] = true;
  for (k in actualByHouse) if (Object.prototype.hasOwnProperty.call(actualByHouse, k)) ids[k] = true;

  var rows = [];
  for (var id in ids) {
    if (!Object.prototype.hasOwnProperty.call(ids, id)) continue;
    var hasBudget = Object.prototype.hasOwnProperty.call(budgetByHouse, id);
    var actual = actualByHouse[id] || 0;
    var row = { id: id, house: idToName[id] || id, actual: actual, usedEstimated: !!usedEstimated[id], budgetDefined: hasBudget };
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

  return { period: period, houses: rows, skipped: skipped };
}

// Periods offered by the month selector: every period that has a budget row or an attributable
// request, plus the current period, most-recent first.
function budgetPeriods(budgets, requests, maps, currentPeriod) {
  var nameToId = (maps && maps.nameToId) || {};
  var set = {};
  if (currentPeriod) set[currentPeriod] = true;
  for (var i = 0; i < (budgets || []).length; i++) {
    var b = parseBudgetRow(budgets[i], null);
    if (b) set[b.period] = true;
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
  budgetNum, requestPeriod, requestActual, attributeRequest, parseBudgetRow, computeAdherence, budgetPeriods,
};
