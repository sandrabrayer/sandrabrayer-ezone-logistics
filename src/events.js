// events.js — exceptional-events register (אירועים חריגים — רישום, הפקת לקחים, מעקב אחר אירועים חוזרים).
//
// Olga's JD requires מעקב אחר אירועים חריגים, הפקת לקחים ויישום פעולות מתקנות; her success metric is a
// drop in RECURRING exceptional events. Events are reported from the FIELD (the /events entry UI), unlike
// the fill-in-Sheet modules. This module is the PURE logic — validation, permission, and the /management
// analysis (open events worst-first, recurrence over a rolling window, monthly trend, missing-lessons) —
// duplicated verbatim in apps-script/Code.gs behind the MIRROR:events fence (the drift guard asserts they
// stay identical). It reuses houseInScope (roles.js) + maintDateOnly / maintDaysBetween (maintenance.js),
// imported here outside the fence and already global in Code.gs.
//
// Discipline: operational fields ONLY — never any clinical/medical record content. A house with no events
// is a TRUE zero ("אין אירועים"), distinct from data-unavailable. created_by ALWAYS comes from the session
// token, never the client body. Closing an event REQUIRES root_cause AND lessons.

import { houseInScope } from './roles.js';
import { maintDateOnly, maintDaysBetween } from './maintenance.js';

// === MIRROR:events START ===
var EVENT_SEVERITIES = ['נמוך', 'בינוני', 'גבוה'];
var EVENT_STATUSES = ['פתוח', 'בטיפול', 'נסגר'];

// Parse the Config `event_types` spec (pipe-separated) → list of categories. Malformed / blank → the
// entry form falls back to אחר only (logged) — never a silently wrong category set.
function parseEventTypes(spec, log) {
  var s = String(spec == null ? '' : spec).replace(/^\s+|\s+$/g, '');
  var out = [];
  if (s !== '') {
    var parts = s.split('|');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].replace(/^\s+|\s+$/g, '');
      if (p !== '' && out.indexOf(p) === -1) out.push(p);
    }
  }
  if (out.length === 0) {
    if (log) log('events: event_types spec malformed/blank — falling back to אחר only');
    return ['אחר'];
  }
  return out;
}

// Severity → sortable rank (higher = worse). Unknown → 0.
function eventSeverityRank(sev) {
  var s = String(sev == null ? '' : sev).replace(/^\s+|\s+$/g, '');
  if (s === 'גבוה') return 3;
  if (s === 'בינוני') return 2;
  if (s === 'נמוך') return 1;
  return 0;
}

// May this actor CREATE (report) an event for houseName? maintenance CANNOT; a coordinator only for
// their OWN house (houseInScope); field_ops / ops_manager for any house. Unknown role → false.
function eventCreatePermitted(role, scope, houseName, cluster) {
  if (role === 'maintenance') return false;
  if (role === 'coordinator') return houseInScope(role, scope, houseName, cluster);
  if (role === 'field_ops' || role === 'ops_manager') return true;
  return false;
}

// Validate a create payload against the allowed types → error string, or '' when valid.
function eventCreateError(payload, types) {
  var p = payload || {};
  if (!String(p.house == null ? '' : p.house).replace(/^\s+|\s+$/g, '')) return 'חסר בית';
  if (!maintDateOnly(p.occurred_at)) return 'תאריך אירוע לא תקין';
  var type = String(p.event_type == null ? '' : p.event_type).replace(/^\s+|\s+$/g, '');
  if ((types || []).indexOf(type) === -1) return 'סוג אירוע לא חוקי';
  var sev = String(p.severity == null ? '' : p.severity).replace(/^\s+|\s+$/g, '');
  if (EVENT_SEVERITIES.indexOf(sev) === -1) return 'דרגת חומרה לא חוקית';
  if (!String(p.description == null ? '' : p.description).replace(/^\s+|\s+$/g, '')) return 'חסר תיאור';
  return '';
}

// Shape a validated create payload into a Events row. created_by comes from the ACTOR (session token),
// NEVER from the client body; a new event starts פתוח with no root_cause / lessons / corrective link.
function buildEventRow(payload, actor, id, nowIso) {
  var p = payload || {};
  return {
    id: id,
    created_at: nowIso,
    created_by: (actor && actor.name) || '',
    house: String(p.house == null ? '' : p.house).replace(/^\s+|\s+$/g, ''),
    occurred_at: maintDateOnly(p.occurred_at),
    event_type: String(p.event_type == null ? '' : p.event_type).replace(/^\s+|\s+$/g, ''),
    severity: String(p.severity == null ? '' : p.severity).replace(/^\s+|\s+$/g, ''),
    description: String(p.description == null ? '' : p.description),
    immediate_action: String(p.immediate_action == null ? '' : p.immediate_action),
    root_cause: '',
    lessons: '',
    corrective_request_id: '',
    status: 'פתוח',
    closed_at: '',
    notes: String(p.notes == null ? '' : p.notes)
  };
}

// Closing (status נסגר) REQUIRES root_cause AND lessons → error string, or '' otherwise (incl. non-close).
function eventCloseError(fields) {
  var f = fields || {};
  if (String(f.status == null ? '' : f.status).replace(/^\s+|\s+$/g, '') !== 'נסגר') return '';
  if (!String(f.root_cause == null ? '' : f.root_cause).replace(/^\s+|\s+$/g, '')) return 'לא ניתן לסגור אירוע ללא שורש הבעיה (root_cause)';
  if (!String(f.lessons == null ? '' : f.lessons).replace(/^\s+|\s+$/g, '')) return 'לא ניתן לסגור אירוע ללא הפקת לקחים (lessons)';
  return '';
}

// Validate an edit/close (the MERGED post-update fields) → error string, or ''. correctiveExists is the
// handler's answer to "does the linked Request id exist?" (true when no link is set).
function eventUpdateError(fields, correctiveExists) {
  var f = fields || {};
  var status = String(f.status == null ? '' : f.status).replace(/^\s+|\s+$/g, '');
  if (status !== '' && EVENT_STATUSES.indexOf(status) === -1) return 'סטטוס לא חוקי';
  var corr = String(f.corrective_request_id == null ? '' : f.corrective_request_id).replace(/^\s+|\s+$/g, '');
  if (corr !== '' && !correctiveExists) return 'דרישה מקושרת לא נמצאה';
  return eventCloseError(f);
}

// Parse one Events row for the analysis panel → normalized object, or null (malformed → logged, skipped).
function parseEventRow(row, idToName, log) {
  var idMap = idToName || {};
  var id = String(row && row.id != null ? row.id : '').replace(/^\s+|\s+$/g, '');
  var house = String(row && row.house != null ? row.house : '').replace(/^\s+|\s+$/g, '');
  if (!id) { if (log) log('events: row missing id — skipped'); return null; }
  if (!Object.prototype.hasOwnProperty.call(idMap, house)) {
    if (log) log('events: "' + id + '" unknown house "' + house + '" — skipped');
    return null;
  }
  var occ = maintDateOnly(row ? row.occurred_at : '');
  if (!occ) { if (log) log('events: "' + id + '" blank/unparseable occurred_at — skipped'); return null; }
  var sev = String(row && row.severity != null ? row.severity : '').replace(/^\s+|\s+$/g, '');
  var status = String(row && row.status != null ? row.status : '').replace(/^\s+|\s+$/g, '') || 'פתוח';
  var lessons = String(row && row.lessons != null ? row.lessons : '').replace(/^\s+|\s+$/g, '');
  return {
    id: id, house: house, houseName: idMap[house], occurred: occ,
    type: String(row && row.event_type != null ? row.event_type : '').replace(/^\s+|\s+$/g, ''),
    severity: sev, severityRank: eventSeverityRank(sev), status: status,
    description: String(row && row.description != null ? row.description : ''),
    lessons: lessons, missingLessons: lessons === '',
    correctiveRequestId: String(row && row.corrective_request_id != null ? row.corrective_request_id : '').replace(/^\s+|\s+$/g, '')
  };
}

// Recurrence: same event_type + house occurring 2+ times within the TRAILING windowDays (default 90) from
// nowDay → flagged חוזר with its count. Recent repeats only (a live "is this house repeating?" signal).
function detectRecurrence(events, nowDay, windowDays) {
  var win = windowDays || 90;
  var counts = {};
  for (var i = 0; i < (events || []).length; i++) {
    var occ = maintDateOnly(events[i] ? events[i].occurred_at : '');
    if (!occ) continue;
    var age = maintDaysBetween(occ, nowDay);
    if (age == null || age < 0 || age > win) continue;
    var type = String(events[i].event_type == null ? '' : events[i].event_type).replace(/^\s+|\s+$/g, '');
    var house = String(events[i].house == null ? '' : events[i].house).replace(/^\s+|\s+$/g, '');
    if (!type || !house) continue;
    var key = type + '|' + house;
    if (!counts[key]) counts[key] = { type: type, house: house, count: 0 };
    counts[key].count++;
  }
  var out = [];
  for (var k in counts) {
    if (!Object.prototype.hasOwnProperty.call(counts, k)) continue;
    if (counts[k].count >= 2) out.push({ type: counts[k].type, house: counts[k].house, count: counts[k].count, recurring: true });
  }
  out.sort(function (a, b) {
    if (a.count !== b.count) return b.count - a.count;
    return a.type < b.type ? -1 : a.type > b.type ? 1 : 0;
  });
  return out;
}

// Monthly counts for the last `months` months (including the current one), by occurred_at month.
function monthlyTrend(events, nowDay, months) {
  var m = String(nowDay).match(/^(\d{4})-(\d{2})/);
  if (!m) return [];
  var base = Number(m[1]) * 12 + (Number(m[2]) - 1);
  var labels = [], idx = {};
  for (var k = months - 1; k >= 0; k--) {
    var t = base - k;
    var yy = Math.floor(t / 12), mm = (t % 12) + 1;
    var label = yy + '-' + (mm < 10 ? '0' + mm : '' + mm);
    idx[label] = labels.length;
    labels.push({ month: label, count: 0 });
  }
  for (var i = 0; i < (events || []).length; i++) {
    var occ = maintDateOnly(events[i] ? events[i].occurred_at : '');
    if (!occ) continue;
    var mk = occ.slice(0, 7);
    if (Object.prototype.hasOwnProperty.call(idx, mk)) labels[idx[mk]].count++;
  }
  return labels;
}

// The /management analysis panel. available is ALWAYS true (the Events sheet is self-owned) — so a house
// with openCount 0 is a TRUE zero, not "unavailable". Per house: OPEN events worst-first (severity, then
// oldest). Plus recurrence, monthly trend, and a missing-lessons count. maps: { idToName }.
function eventsAnalysis(events, maps, openHouseIds, nowDay, log) {
  var idToName = (maps && maps.idToName) || {};
  var openIds = openHouseIds || [];
  var byHouse = {};
  function ensure(id) {
    if (!Object.prototype.hasOwnProperty.call(byHouse, id)) byHouse[id] = [];
    return byHouse[id];
  }
  for (var o = 0; o < openIds.length; o++) ensure(openIds[o]);
  var skipped = 0, missingLessonsCount = 0, openTotal = 0;
  for (var i = 0; i < (events || []).length; i++) {
    var ev = parseEventRow(events[i], idToName, log);
    if (!ev) { skipped++; continue; }
    if (ev.missingLessons) missingLessonsCount++;
    if (ev.status !== 'נסגר') { ensure(ev.house).push(ev); openTotal++; }
  }
  var houses = [];
  for (var id in byHouse) {
    if (!Object.prototype.hasOwnProperty.call(byHouse, id)) continue;
    var list = byHouse[id];
    list.sort(function (a, b) {
      if (a.severityRank !== b.severityRank) return b.severityRank - a.severityRank;
      return a.occurred < b.occurred ? -1 : a.occurred > b.occurred ? 1 : 0; // oldest open first
    });
    houses.push({ id: id, house: idToName[id] || id, openCount: list.length, hasEvents: list.length > 0, events: list });
  }
  houses.sort(function (a, b) {
    if (a.openCount !== b.openCount) return b.openCount - a.openCount;
    return a.house < b.house ? -1 : a.house > b.house ? 1 : 0;
  });
  var rec = detectRecurrence(events, nowDay, 90);
  for (var r = 0; r < rec.length; r++) rec[r].houseName = idToName[rec[r].house] || rec[r].house;
  return {
    available: true, houses: houses, openCount: openTotal,
    recurrence: rec, trend: monthlyTrend(events, nowDay, 6),
    missingLessonsCount: missingLessonsCount, skipped: skipped
  };
}
// === MIRROR:events END ===

export {
  EVENT_SEVERITIES, EVENT_STATUSES, parseEventTypes, eventSeverityRank, eventCreatePermitted,
  eventCreateError, buildEventRow, eventCloseError, eventUpdateError, parseEventRow,
  detectRecurrence, monthlyTrend, eventsAnalysis,
};
