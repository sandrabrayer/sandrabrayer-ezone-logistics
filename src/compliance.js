// compliance.js — compliance tracker (עמידה ברגולציה — תעודות, רישיונות, תוקף ותזכורות) for the
// /management screen.
//
// Olga tracks per-house certificates/licenses/inspections in the Compliance sheet (id, house, item,
// expires_at, reminder_days, doc_url, notes, active). house is a CANONICAL id (HOUSE-IDS.md) OR the
// literal 'all' (every OPEN house). Each item has an expiry; days_to_expiry / status are DERIVED here
// and NEVER stored. A scheduled pass (the SAME daily trigger as תחזוקה מונעת) turns an item that has
// entered its reminder window (or expired) into a NORMAL Request (category תיקון; urgency דחוף if
// expired, else רגיל; created_by "מערכת - רגולציה") linked by compliance_id. On completion NOTHING is
// written back — the new expiry lives on the new certificate, so Olga updates expires_at by hand.
//
// The MIRROR:compliance block below is duplicated verbatim in apps-script/Code.gs (the mirror-drift
// guard asserts they stay identical). It reuses four date/house primitives from maintenance.js
// (maintDateOnly, maintDaysBetween, maintActive, expandHouses) — imported here (outside the fence),
// already global in Code.gs — so the two features share ONE implementation of each.
//
// Discipline: a house with no compliance rows renders "not defined", NEVER 0; a malformed row (missing
// id/item, blank/unparseable expires_at, unknown house id) is skipped and logged; a duplicate OPEN
// renewal request for the same compliance id + house is never created twice.

import { maintDateOnly, maintDaysBetween, maintActive, expandHouses } from './maintenance.js';

// === MIRROR:compliance START ===
// A cell → a NON-NEGATIVE integer, or null when blank / non-numeric / negative / fractional (so a bad
// reminder_days never coerces to a silent value — the caller falls back to the Config default).
function complianceNum(v) {
  if (v == null) return null;
  var s = String(v).replace(/^\s+|\s+$/g, '');
  if (s === '') return null;
  var n = Number(s);
  if (!isFinite(n) || n < 0 || Math.floor(n) !== n) return null;
  return n;
}

// Derived status of ONE item as of nowDay ('YYYY-MM-DD'): { expires, daysToExpiry, status, expiring,
// expired }. reminderDays is the effective window (row override or Config default).
//   - daysToExpiry < 0          → 'פג תוקף'  (expired)   — past the expiry date.
//   - 0 <= daysToExpiry <= win  → 'פג בקרוב' (expiring)  — inside the reminder window (0 = expires today).
//   - else                      → 'בתוקף'    (valid).
function complianceStatus(expiresAt, reminderDays, nowDay) {
  var expires = maintDateOnly(expiresAt);
  var days = maintDaysBetween(nowDay, expires);
  if (expires === '' || days == null) return { expires: '', daysToExpiry: null, status: 'לא ידוע', expiring: false, expired: false };
  if (days < 0) return { expires: expires, daysToExpiry: days, status: 'פג תוקף', expiring: false, expired: true };
  if (days <= reminderDays) return { expires: expires, daysToExpiry: days, status: 'פג בקרוב', expiring: true, expired: false };
  return { expires: expires, daysToExpiry: days, status: 'בתוקף', expiring: false, expired: false };
}

// Parse + validate one Compliance row → normalized object, or null (malformed → logged, skipped).
// idToName is the canonical-id → name map; house must be 'all' or one of its keys. reminder_days blank
// → defaultReminderDays; a NON-blank but invalid reminder_days is logged and also falls back to it.
function parseComplianceRow(row, idToName, defaultReminderDays, log) {
  var idMap = idToName || {};
  var id = String(row && row.id != null ? row.id : '').replace(/^\s+|\s+$/g, '');
  var house = String(row && row.house != null ? row.house : '').replace(/^\s+|\s+$/g, '');
  var item = String(row && row.item != null ? row.item : '').replace(/^\s+|\s+$/g, '');
  if (!id) { if (log) log('compliance: row missing id — skipped'); return null; }
  if (!item) { if (log) log('compliance: item "' + id + '" missing name — skipped'); return null; }
  var expires = maintDateOnly(row ? row.expires_at : '');
  if (!expires) { if (log) log('compliance: item "' + id + '" blank/unparseable expires_at — skipped'); return null; }
  if (house !== 'all' && !Object.prototype.hasOwnProperty.call(idMap, house)) {
    if (log) log('compliance: item "' + id + '" unknown house "' + house + '" — skipped');
    return null;
  }
  var rawReminder = String(row && row.reminder_days != null ? row.reminder_days : '').replace(/^\s+|\s+$/g, '');
  var reminder = complianceNum(rawReminder);
  if (reminder == null) {
    if (rawReminder !== '' && log) log('compliance: item "' + id + '" bad reminder_days "' + rawReminder + '" — using default');
    reminder = defaultReminderDays;
  }
  return {
    id: id, house: house, item: item, expires: expires, reminderDays: reminder,
    docUrl: String(row && row.doc_url != null ? row.doc_url : '').replace(/^\s+|\s+$/g, ''),
    notes: String(row && row.notes != null ? row.notes : ''),
    active: maintActive(row ? row.active : '')
  };
}

// The request-input for a generated renewal. A NORMAL request — it flows through the same approval
// chain + SLA as any request. urgency is דחוף when the item is already expired, else רגיל.
// compliance_id links it back to its Compliance row.
function complianceRequestInput(target) {
  return {
    house: target.houseName,
    category: 'תיקון',
    urgency: target.expired ? 'דחוף' : 'רגיל',
    description: 'חידוש: ' + target.item + ' — ' + target.houseName + ' (עמידה ברגולציה)',
    location_in_house: '',
    estimated_cost: '',
    created_by: 'מערכת - רגולציה',
    compliance_id: target.complianceId
  };
}

// Statuses that mean a generated renewal request is CLOSED-OUT and no longer blocks a re-generation.
var COMPLIANCE_TERMINAL_ = { 'הושלם': 1, 'סגור': 1, 'לא מאושר': 1 };

// Decide what to generate this pass. Returns { toCreate:[{complianceId,houseId,houseName,item,expired}],
// skippedDuplicate, skippedMalformed, skippedInactive }. An item generates when it is expiring OR
// expired (a valid item does not). It is SKIPPED when a non-terminal (still-open) request already
// exists for the same compliance_id + house — no duplicate open request is ever created. maps:
// { idToName }. defaultReminderDays is the Config default for rows that leave reminder_days blank.
function complianceGenerationPlan(items, requests, openHouseIds, maps, defaultReminderDays, nowDay, log) {
  var idToName = (maps && maps.idToName) || {};
  var openKeys = {};
  for (var r = 0; r < (requests || []).length; r++) {
    var req = requests[r];
    var cid = String(req && req.compliance_id != null ? req.compliance_id : '').replace(/^\s+|\s+$/g, '');
    if (!cid) continue;
    var st = String(req && req.status != null ? req.status : '').replace(/^\s+|\s+$/g, '');
    if (Object.prototype.hasOwnProperty.call(COMPLIANCE_TERMINAL_, st)) continue;
    var hn = String(req && req.house != null ? req.house : '').replace(/^\s+|\s+$/g, '');
    openKeys[cid + '|' + hn] = true;
  }
  var toCreate = [], skippedDuplicate = 0, skippedMalformed = 0, skippedInactive = 0;
  for (var i = 0; i < (items || []).length; i++) {
    var it = parseComplianceRow(items[i], idToName, defaultReminderDays, log);
    if (!it) { skippedMalformed++; continue; }
    if (!it.active) { skippedInactive++; continue; }
    var status = complianceStatus(it.expires, it.reminderDays, nowDay);
    if (!status.expiring && !status.expired) continue;
    var houseIds = expandHouses(it.house, openHouseIds);
    for (var h = 0; h < houseIds.length; h++) {
      var houseId = houseIds[h];
      var houseName = idToName[houseId] || houseId;
      var key = it.id + '|' + houseName;
      if (openKeys[key]) { skippedDuplicate++; continue; }
      toCreate.push({ complianceId: it.id, houseId: houseId, houseName: houseName, item: it.item, expired: status.expired });
      openKeys[key] = true; // guard two rows for the same compliance+house within one pass
    }
  }
  return {
    toCreate: toCreate, skippedDuplicate: skippedDuplicate,
    skippedMalformed: skippedMalformed, skippedInactive: skippedInactive
  };
}

// Compliance-adherence panel data: per-house items (worst-first: expired first, then soonest-to-expire)
// as of nowDay, plus a skipped (malformed) count. Open houses are ALWAYS listed (a house with no active
// compliance row → defined:false → "not defined", never a fabricated 0). maps: { idToName }.
function complianceAdherence(items, maps, openHouseIds, defaultReminderDays, nowDay, log) {
  var idToName = (maps && maps.idToName) || {};
  var openIds = openHouseIds || [];
  var itemsByHouse = {};
  var skipped = 0;
  function ensure(id) {
    if (!Object.prototype.hasOwnProperty.call(itemsByHouse, id)) itemsByHouse[id] = [];
    return itemsByHouse[id];
  }
  for (var o = 0; o < openIds.length; o++) ensure(openIds[o]);
  for (var i = 0; i < (items || []).length; i++) {
    var it = parseComplianceRow(items[i], idToName, defaultReminderDays, log);
    if (!it) { skipped++; continue; }
    if (!it.active) continue;
    var status = complianceStatus(it.expires, it.reminderDays, nowDay);
    var houseIds = expandHouses(it.house, openIds);
    for (var h = 0; h < houseIds.length; h++) {
      ensure(houseIds[h]).push({
        item: it.item, expires: it.expires, reminderDays: it.reminderDays, docUrl: it.docUrl,
        daysToExpiry: status.daysToExpiry, status: status.status, expiring: status.expiring, expired: status.expired
      });
    }
  }
  var houses = [];
  for (var id in itemsByHouse) {
    if (!Object.prototype.hasOwnProperty.call(itemsByHouse, id)) continue;
    var list = itemsByHouse[id];
    list.sort(function (a, b) {
      var ad = a.daysToExpiry == null ? 1e9 : a.daysToExpiry;
      var bd = b.daysToExpiry == null ? 1e9 : b.daysToExpiry;
      if (ad !== bd) return ad - bd; // most-negative (expired worst) first, then soonest
      return a.item < b.item ? -1 : a.item > b.item ? 1 : 0;
    });
    var expiredCount = 0, expiringCount = 0;
    for (var t = 0; t < list.length; t++) {
      if (list[t].expired) expiredCount++;
      else if (list[t].expiring) expiringCount++;
    }
    houses.push({
      id: id, house: idToName[id] || id, defined: list.length > 0,
      items: list, expiredCount: expiredCount, expiringCount: expiringCount
    });
  }
  houses.sort(function (a, b) {
    if (a.expiredCount !== b.expiredCount) return b.expiredCount - a.expiredCount;
    if (a.expiringCount !== b.expiringCount) return b.expiringCount - a.expiringCount;
    return a.house < b.house ? -1 : a.house > b.house ? 1 : 0;
  });
  return { houses: houses, skipped: skipped };
}
// === MIRROR:compliance END ===

export {
  complianceNum, complianceStatus, parseComplianceRow, complianceRequestInput,
  complianceGenerationPlan, complianceAdherence,
};
