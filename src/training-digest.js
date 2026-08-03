// training-digest.js — pure shaping for READ-ONLY consumption of the coordinators-published digest on
// the /management screen (tab TrainingCompliance). This app NEVER writes into the coordinators' digest;
// it only reads, per DIGEST-CONTRACT.md. The producer full-rewrites the tab hourly + on writes; we are
// read-only consumers.
//
// Discipline enforced here (same as MIRROR:digestconsume for the kitchen digest):
//   - columns are read BY HEADER NAME (rows are header-keyed objects), never by position;
//   - a house that does not map to a canonical HOUSE-IDS.md id is OMITTED, never guessed;
//   - a missing required header renders "unavailable" (available:false), NEVER a fabricated 0;
//   - the notRecorded status is kept DISTINCT and never counted as ok/green;
//   - every canonical house gets an entry: a house absent from the digest shows hasData:false
//     ("אין נתונים לבית זה"), which is DIFFERENT from the whole digest being unavailable.
//
// The MIRROR:trainingdigest block below is duplicated VERBATIM in apps-script/Code.gs; the mirror-drift
// guard test asserts they stay identical. The canonical id→name map is passed IN by the caller (built
// from each side's own house-id table), so the shaper stays generic and self-contained.

// === MIRROR:trainingdigest START ===
// Exact TrainingCompliance headers (contract v2), read BY NAME so column order never matters. All are
// required for the panel EXCEPT updatedAt (producer metadata) — a missing required header → unavailable.
var TRAINING_REQUIRED_HEADERS = ['house', 'guideName', 'firstAidStatus', 'firstAidDate', 'instructorStatus', 'instructorDate', 'overallStatus'];

// Worst-first rank for guide ordering: blocked, then notRecorded, then warn, then ok; unknown sorts last.
function trainingStatusRank(status) {
  var s = String(status == null ? '' : status);
  if (s === 'blocked') return 0;
  if (s === 'notRecorded') return 1;
  if (s === 'warn') return 2;
  if (s === 'ok') return 3;
  return 4;
}

// A raw date cell → dd/mm/yyyy for display, or '' when blank/unparseable (never a wrong date). Accepts a
// leading YYYY-MM-DD (optionally with a time suffix) — the digest publishes ISO-style dates.
function trainingFmtDate(v) {
  var s = String(v == null ? '' : v).replace(/^\s+|\s+$/g, '');
  if (s === '') return '';
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? (m[3] + '/' + m[2] + '/' + m[1]) : s;
}

// True only when EVERY required header key is present on the (first) row object.
function trainingHasHeaders(row, headers) {
  for (var i = 0; i < headers.length; i++) {
    if (!row || !Object.prototype.hasOwnProperty.call(row, headers[i])) return false;
  }
  return true;
}

// Shape TrainingCompliance rows → { available, reason?, houses:[...] }. Every canonical house in idToName
// gets an entry (so an absent house surfaces, never invisible): hasData:true with real numbers when the
// digest has rows for it, else hasData:false ("אין נתונים לבית זה"). Rows whose house id is not canonical
// are OMITTED (never guessed). rows empty → available with all houses hasData:false (NOT an error). A
// missing required header on a non-empty digest → available:false (we will not fabricate a shape or a 0).
function summarizeTrainingCompliance(rows, idToName) {
  var map = idToName || {};
  var byId = {};
  var ids = [];
  for (var cid in map) {
    if (Object.prototype.hasOwnProperty.call(map, cid)) {
      byId[cid] = { id: cid, house: map[cid], hasData: false, total: 0,
        counts: { ok: 0, warn: 0, blocked: 0, notRecorded: 0 }, compliancePercent: null, guides: [] };
      ids.push(cid);
    }
  }
  if (rows && rows.length) {
    if (!trainingHasHeaders(rows[0], TRAINING_REQUIRED_HEADERS)) {
      return { available: false, reason: 'כותרות TrainingCompliance אינן תואמות את החוזה' };
    }
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var id = String(row['house'] == null ? '' : row['house']).replace(/^\s+|\s+$/g, '');
      if (!id || !Object.prototype.hasOwnProperty.call(byId, id)) continue; // unmapped house → omit
      var h = byId[id];
      h.hasData = true;
      var overall = String(row['overallStatus'] == null ? '' : row['overallStatus']).replace(/^\s+|\s+$/g, '');
      var firstAid = String(row['firstAidStatus'] == null ? '' : row['firstAidStatus']).replace(/^\s+|\s+$/g, '');
      var instructor = String(row['instructorStatus'] == null ? '' : row['instructorStatus']).replace(/^\s+|\s+$/g, '');
      if (Object.prototype.hasOwnProperty.call(h.counts, overall)) h.counts[overall]++;
      h.total++;
      var lacking = [];
      if (firstAid !== 'ok') lacking.push('עזרה ראשונה');
      if (instructor !== 'ok') lacking.push('הדרכת מדריכים');
      h.guides.push({
        guideName: String(row['guideName'] == null ? '' : row['guideName']).replace(/^\s+|\s+$/g, ''),
        overallStatus: overall,
        firstAidStatus: firstAid,
        firstAidDate: trainingFmtDate(row['firstAidDate']),
        instructorStatus: instructor,
        instructorDate: trainingFmtDate(row['instructorDate']),
        lacking: lacking,
      });
    }
  }
  ids.sort(function (a, b) { var x = byId[a].house, y = byId[b].house; return x < y ? -1 : x > y ? 1 : 0; });
  var out = [];
  for (var i = 0; i < ids.length; i++) {
    var e = byId[ids[i]];
    if (e.hasData) {
      e.compliancePercent = e.total ? Math.round((e.counts.ok / e.total) * 100) : null;
      e.guides.sort(function (a, b) {
        var ra = trainingStatusRank(a.overallStatus), rb = trainingStatusRank(b.overallStatus);
        if (ra !== rb) return ra - rb;
        return a.guideName < b.guideName ? -1 : a.guideName > b.guideName ? 1 : 0;
      });
    }
    out.push(e);
  }
  return { available: true, houses: out };
}

// Turn a read context into a panel. Keeps every "unavailable" reason in ONE pure place so the Code.gs
// side only does the SpreadsheetApp read and hands the outcome here. Blank id → "לא זמין" (not an error);
// no access / missing tab → an explicit read-error reason. NEVER a silent empty state, never a 0.
//   ctx: { configured, readError, missingTab, rows }
function trainingCompliancePanel(ctx, idToName) {
  var c = ctx || {};
  if (!c.configured) return { available: false, reason: 'לא הוגדר מזהה דייג׳סט רכזים (Config: training_digest_id)' };
  if (c.readError) return { available: false, reason: 'שגיאת קריאה מדייג׳סט הרכזים — בדוק הרשאת צפייה לחשבון הלוגיסטיקה' };
  if (c.missingTab) return { available: false, reason: 'הטאב TrainingCompliance לא נמצא בדייג׳סט הרכזים' };
  return summarizeTrainingCompliance(c.rows || [], idToName);
}
// === MIRROR:trainingdigest END ===

export { TRAINING_REQUIRED_HEADERS, trainingStatusRank, trainingFmtDate, summarizeTrainingCompliance, trainingCompliancePanel };
