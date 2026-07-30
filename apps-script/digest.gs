/**
 * digest.gs — read-only digest export for the coordinators app.
 *
 * WHY A SEPARATE FILE (not tabs in the main Logistics sheet):
 *   Google Sheets sharing is per-FILE, not per-tab. Adding digest tabs to the main sheet
 *   would expose estimated_cost / actual_cost to anyone granted the digest. So the digest
 *   lives in its OWN spreadsheet, holding EXACTLY two tabs (OpenTickets, WeeklyCounts) and
 *   nothing else. brayersandra@gmail.com gets Viewer on that file only.
 *
 * INVARIANTS (see DIGEST-CONTRACT.md — the frozen schema):
 *   - No financial fields, ever. The money scrubber below guarantees no price leaks through
 *     a free-text field (title / shortagesSummary).
 *   - Columns are append-only — never reorder or remove. Consumers read by header name.
 *   - This app is the SOLE writer of these tabs. Do NOT touch the coordinators repo.
 *
 * The pure logic here is mirrored verbatim from src/digest.js, which is unit-tested under
 * `node --test`. Keep the two in sync.
 */

// ---- Constants ----
var DIGEST_PROP_ = 'DIGEST_SHEET_ID';
var DIGEST_VIEWER_EMAIL_ = 'brayersandra@gmail.com';
var DIGEST_FILE_NAME_ = 'EZone Digest (Coordinators, read-only)';
var DIGEST_TAB_OPEN_ = 'OpenTickets';
var DIGEST_TAB_WEEKLY_ = 'WeeklyCounts';
var DIGEST_WEEKS_ = 8;

// Header rows — EXACT order, append-only (see contract). Consumers read by header name.
// daysOpen / overdue / blocked APPENDED (increment 36) — never reorder/remove (consumers read by
// header name). No financial fields. Mirror of DIGEST_OPEN_HEADERS in src/digest.js.
var DIGEST_OPEN_HEADERS_ = ['house', 'ticketId', 'title', 'status', 'openedDate', 'updatedAt', 'daysOpen', 'overdue', 'blocked'];
var DIGEST_WEEKLY_HEADERS_ = ['house', 'weekStart', 'status', 'shortagesSummary', 'updatedAt'];

// Weekly-count status vocabulary (Hebrew display values are the stored values).
var DIGEST_DONE_ = 'בוצעה';
var DIGEST_NOT_DONE_ = 'לא בוצעה';

// ---- Pure helpers (mirror of src/digest.js) ----

// House id map — ALL SIX houses (increment 33). הפרדס (pardes) / שדה אליעזר (sde-eliezer)
// are pre-opening but already have activity, so a gap now shows as 'לא בוצעה' instead of the house
// being invisible. Any house that does not map is OMITTED, never guessed. Keys are the CANONICAL
// Hebrew display names (HOUSE-IDS.md); values are the FROZEN ids, shared with ezone-kitchen. The
// mapping applies at the digest boundary ONLY — Logistics keys on the house name internally.
var DIGEST_HOUSE_IDS_ = {
  'רמות השבים': 'ramot-hashavim',
  'רעננה אשר': 'raanana-asher',
  'רעננה הפרדס': 'pardes',
  'קיסריה עפרוני': 'caesarea-ofroni',
  'קיסריה ריהאב': 'caesarea-rehab',
  'שדה אליעזר': 'sde-eliezer',
};
var DIGEST_HOUSE_ID_ORDER_ = [
  'ramot-hashavim', 'raanana-asher', 'pardes', 'caesarea-ofroni', 'caesarea-rehab', 'sde-eliezer',
];

function digestHouseId_(name) {
  if (name == null) return null;
  var key = String(name).trim();
  return Object.prototype.hasOwnProperty.call(DIGEST_HOUSE_IDS_, key) ? DIGEST_HOUSE_IDS_[key] : null;
}

// ---- Shortage = below par (increment 33) — mirror of src/digest.js ----
// A shortage is par_base SET and quantity_base strictly below it (the same meaning ezone-kitchen
// uses — below-par, early warning — not "already at zero"). Counted 0 with a par → shortage;
// counted 0 with no par → not; never counted → no row, never asked.
function digestIsShortage_(quantityBase, parBase) {
  if (parBase == null || parBase === '') return false;
  var p = Number(parBase);
  if (!isFinite(p)) return false;
  // Blank base qty is "not counted in base terms", NOT a zero (Number('') is 0) — guard before coercing.
  if (quantityBase == null || quantityBase === '') return false;
  var q = Number(quantityBase);
  if (!isFinite(q)) return false;
  return q < p;
}

// One shortage's text, base unit included so the number reads — "שקיות אשפה: 40/200 unit (הערה)".
function digestShortageLabel_(item, quantityBase, parBase, baseUnit, note) {
  var unit = baseUnit ? ' ' + baseUnit : '';
  var s = String(item == null ? '' : item) + ': ' + quantityBase + '/' + parBase + unit;
  var n = String(note == null ? '' : note).trim();
  if (n) s += ' (' + n + ')';
  return s;
}

// Emit every house × week (gaps surface, never hide). bucketByKey: 'houseId|weekStart' →
// {shortagesSummary, updatedAt}; missing keys emit a not-done row.
function digestBuildWeeklyGrid_(bucketByKey, weeks, nowIso, doneLabel, notDoneLabel) {
  var rows = [];
  for (var h = 0; h < DIGEST_HOUSE_ID_ORDER_.length; h++) {
    var house = DIGEST_HOUSE_ID_ORDER_[h];
    for (var w = 0; w < (weeks || []).length; w++) {
      var wk = weeks[w];
      var b = bucketByKey ? bucketByKey[house + '|' + wk] : null;
      if (b) rows.push([house, wk, doneLabel, b.shortagesSummary || '', b.updatedAt || nowIso]);
      else rows.push([house, wk, notDoneLabel, '', nowIso]);
    }
  }
  return rows;
}

// item_text → { par_base (number|null), base_unit (string) } from the InventoryItems catalog.
function digestItemParMap_() {
  var rows = readObjects_('InventoryItems');
  var out = {};
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!r || !r.item_text) continue;
    var rawPar = r.par_base != null ? String(r.par_base).trim() : '';
    var par = null;
    if (rawPar !== '') { var p = Number(rawPar); if (isFinite(p) && p >= 0) par = p; }
    var base = r.base_unit != null ? String(r.base_unit).trim() : '';
    if (['kg', 'g', 'l', 'ml', 'unit'].indexOf(base) === -1) base = '';
    out[String(r.item_text)] = { par_base: par, base_unit: base };
  }
  return out;
}

var DIGEST_EXCLUDED_STATUSES_ = ['סגור', 'לא מאושר'];

function digestIsActiveTicket_(status) {
  return DIGEST_EXCLUDED_STATUSES_.indexOf(String(status == null ? '' : status).trim()) === -1;
}

// Currency markers + adjacent digit groups. Word tokens (שח / NIS / ILS) are boundary-guarded
// so they are never stripped from inside a real word (משחק, TENNIS). Bare counts stay.
var DIGEST_MONEY_RE_ = new RegExp(
  '(?:\\d+(?:[.,]\\d+)*\\s*)?' +
  '(?:₪|ש"ח|ש״ח|(?<![א-ת])שח(?![א-ת])|(?<![A-Za-z])(?:NIS|ILS)(?![A-Za-z]))' +
  '(?:\\s*\\d+(?:[.,]\\d+)*)?',
  'gi');

function digestScrubMoney_(text) {
  if (text == null) return '';
  return String(text).replace(DIGEST_MONEY_RE_, ' ').replace(/\s{2,}/g, ' ').trim();
}

var DIGEST_TITLE_MAX_ = 80;

function digestTruncateTitle_(text, maxLen) {
  var max = maxLen == null ? DIGEST_TITLE_MAX_ : maxLen;
  var oneLine = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, Math.max(0, max - 1)) + '…';
}

/** OpenTickets `title`: description, money-scrubbed, single line, <=80 chars. */
function digestFormatTitle_(description) {
  return digestTruncateTitle_(digestScrubMoney_(description), DIGEST_TITLE_MAX_);
}

function digestWeekStart_(date) {
  var d = date instanceof Date ? new Date(date.getTime()) : new Date(date);
  if (isNaN(d.getTime())) return '';
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}

/** Last n Sunday week-starts up to the week of `now`, most-recent first. */
function digestRecentWeekStarts_(now, n) {
  var count = Number(n) || 0;
  var base = digestWeekStart_(now);
  if (!base || count <= 0) return [];
  var out = [];
  var d = new Date(base + 'T00:00:00Z');
  for (var i = 0; i < count; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 7);
  }
  return out;
}

// ---- Date coercion (sheet cells may hand back a Date OR a string) ----

/** Best-effort YYYY-MM-DD from a cell value (Date or ISO/parseable string). '' when unusable. */
function digestDateOnly_(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  var s = String(v);
  var m = s.match(/^(\d{4}-\d{2}-\d{2})/); // already ISO-ish
  if (m) return m[1];
  var d = new Date(s);
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/** Best-effort ISO 8601 UTC from a cell value (Date or parseable string). '' when unusable. */
function digestIso_(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString();
  var d = new Date(String(v));
  return isNaN(d.getTime()) ? '' : d.toISOString();
}

// ===== One-time setup =====

/**
 * setupDigest() — run ONCE manually from the Apps Script editor.
 * Creates the digest spreadsheet (or reuses it if DIGEST_SHEET_ID is already set), writes both
 * header rows, grants Viewer to the coordinator, stores the id in Script Property
 * DIGEST_SHEET_ID, and Logger.log()s the id. Idempotent — safe to re-run.
 */
function setupDigest() {
  var props = PropertiesService.getScriptProperties();
  var existing = props.getProperty(DIGEST_PROP_);
  var ss = null;
  if (existing) {
    try { ss = SpreadsheetApp.openById(existing); } catch (err) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create(DIGEST_FILE_NAME_);
    props.setProperty(DIGEST_PROP_, ss.getId());
  }

  // Ensure exactly the two tabs, with headers.
  digestEnsureTab_(ss, DIGEST_TAB_OPEN_, DIGEST_OPEN_HEADERS_);
  digestEnsureTab_(ss, DIGEST_TAB_WEEKLY_, DIGEST_WEEKLY_HEADERS_);

  // Remove any other tab (e.g. the auto-created "Sheet1") — the digest holds ONLY these two.
  ss.getSheets().slice().forEach(function (sh) {
    var n = sh.getName();
    if (n !== DIGEST_TAB_OPEN_ && n !== DIGEST_TAB_WEEKLY_ && ss.getSheets().length > 1) {
      ss.deleteSheet(sh);
    }
  });

  // Grant read-only access to the coordinator (Viewer, not Editor).
  ss.addViewer(DIGEST_VIEWER_EMAIL_);

  // Populate immediately so the file is usable right after setup.
  rebuildDigest();

  Logger.log('DIGEST_SHEET_ID = ' + ss.getId());
  return ss.getId();
}

function digestEnsureTab_(ss, name, headers) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sh.setFrozenRows(1);
  return sh;
}

// ===== Rebuild =====

/**
 * rebuildDigest() — wipe and rewrite BOTH tabs from Requests / AuditLog / Houses /
 * InventoryCounts. Fully idempotent. Wrapped in LockService so concurrent writes (each write
 * handler calls this) never interleave. No-op if the digest has not been set up yet, and any
 * error is logged (never thrown) so a digest hiccup can't break a staff write — the 15-minute
 * trigger is the catch-up backstop.
 */
function rebuildDigest() {
  var id = PropertiesService.getScriptProperties().getProperty(DIGEST_PROP_);
  if (!id) return; // not provisioned yet — nothing to do

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return; // another rebuild is running; the trigger will catch up
  try {
    var ss = SpreadsheetApp.openById(id);
    digestWriteRows_(ss, DIGEST_TAB_OPEN_, DIGEST_OPEN_HEADERS_, buildOpenTicketRows_());
    digestWriteRows_(ss, DIGEST_TAB_WEEKLY_, DIGEST_WEEKLY_HEADERS_, buildWeeklyCountRows_());
  } catch (err) {
    Logger.log('rebuildDigest failed: ' + (err && err.message ? err.message : err));
  } finally {
    lock.releaseLock();
  }
}

function digestWriteRows_(ss, tabName, headers, rows) {
  var sh = ss.getSheetByName(tabName) || ss.insertSheet(tabName);
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sh.setFrozenRows(1);
  var lastRow = sh.getLastRow();
  if (lastRow > 1) sh.getRange(2, 1, lastRow - 1, Math.max(sh.getLastColumn(), headers.length)).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
}

/**
 * OpenTickets rows. One row per active ticket whose house maps to a coordinator house id.
 * Included when status is NOT 'סגור' and NOT 'לא מאושר'. Title is money-scrubbed.
 */
function buildOpenTicketRows_() {
  var requests = readObjects_('Requests');
  var audit = readObjects_('AuditLog');

  // Latest AuditLog timestamp per request_id (ISO strings compare lexicographically).
  var latestAudit = {};
  audit.forEach(function (row) {
    var rid = String(row.request_id);
    var ts = digestIso_(row.timestamp);
    if (!ts) return;
    if (!latestAudit[rid] || ts > latestAudit[rid]) latestAudit[rid] = ts;
  });

  var now = new Date();
  var rows = [];
  requests.forEach(function (req) {
    var house = digestHouseId_(req.house);
    if (!house) return;                          // unmapped house → omitted
    if (!digestIsActiveTicket_(req.status)) return;
    var id = String(req.id);
    var updatedAt = latestAudit[id] || digestIso_(req.created_at);
    // Aging facts for the coordinators app (increment 36) — non-financial. ticketAging is the shared
    // SLA logic (defined in Code.gs, same Apps Script project).
    var aging = ticketAging(req, now);
    rows.push([
      house,
      id,
      digestFormatTitle_(req.description),
      String(req.status == null ? '' : req.status),
      digestDateOnly_(req.created_at),
      updatedAt,
      aging.days_open == null ? '' : aging.days_open,
      aging.overdue,
      aging.blocked,
    ]);
  });
  return rows;
}

/**
 * WeeklyCounts rows — always 6 houses × last 8 weeks (48 rows) so gaps surface as 'לא בוצעה'.
 *
 * Increment 26: inventory is WEEKLY and rows carry `week_start`. status is 'בוצעה' whenever a
 * Logistics count row exists for that house+week; otherwise 'לא בוצעה'.
 *
 * Increment 33: a shortage is BELOW PAR (par_base set on the item AND the latest counted
 * quantity_base strictly below it) — the same meaning ezone-kitchen uses, so the word means one
 * thing across the two apps Olga reads side by side. Only the LATEST count per house+week is
 * compared (re-submissions supersede). shortagesSummary includes the base unit so the number reads.
 *
 * NOTE / TODO (food shortages): Logistics no longer counts מזון — ezone-kitchen owns food. Food
 * shortages will arrive in a LATER increment from the kitchen digest and be merged in here. This
 * is intentionally NOT stubbed or faked — until that increment lands, shortagesSummary reflects
 * Logistics categories only.
 *
 * We still read week_start defensively: if the column is absent (pre-migration sheet), every
 * row emits 'לא בוצעה' with an empty shortagesSummary — we never fabricate weekly data.
 */
function buildWeeklyCountRows_() {
  var weeks = digestRecentWeekStarts_(new Date(), DIGEST_WEEKS_);
  var nowIso = new Date().toISOString();
  var parMap = digestItemParMap_();

  var counts = readObjects_('InventoryCounts');

  // Group every count row by houseId|weekStart (each mapped, dated row).
  var rowsByKey = {};
  counts.forEach(function (c) {
    var house = digestHouseId_(c.house);
    if (!house) return;
    var wk = digestDateOnly_(c.week_start);
    if (!wk) return;
    var key = house + '|' + wk;
    (rowsByKey[key] || (rowsByKey[key] = [])).push(c);
  });

  // For each house+week, compare ONLY the latest submission (by counted_at) against par.
  var byKey = {};
  Object.keys(rowsByKey).forEach(function (key) {
    var group = rowsByKey[key];
    var latestId = '', latestAt = '';
    group.forEach(function (c) {
      var ts = digestIso_(c.counted_at);
      if (ts >= latestAt) { latestAt = ts; latestId = String(c.count_id); }
    });
    var updatedAt = '';
    var shortages = [];
    group.forEach(function (c) {
      if (String(c.count_id) !== latestId) return;   // superseded submission — ignore
      var ts = digestIso_(c.counted_at);
      if (ts && ts > updatedAt) updatedAt = ts;
      var par = parMap[String(c.item)];
      if (par && par.par_base != null && digestIsShortage_(c.quantity_base, par.par_base)) {
        shortages.push(digestShortageLabel_(c.item, c.quantity_base, par.par_base, par.base_unit, c.notes));
      }
    });
    byKey[key] = { updatedAt: updatedAt, shortagesSummary: digestScrubMoney_(shortages.join('; ')) };
  });

  return digestBuildWeeklyGrid_(byKey, weeks, nowIso, DIGEST_DONE_, DIGEST_NOT_DONE_);
}

// ===== Trigger =====

/**
 * installDigestTrigger() — run ONCE manually. Installs a 15-minute time-driven backstop so the
 * digest stays fresh even if a write-handler rebuild was skipped (lock contention) or failed.
 * Idempotent: removes any existing rebuildDigest trigger before adding one.
 */
function installDigestTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'rebuildDigest') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('rebuildDigest').timeBased().everyMinutes(15).create();
}
