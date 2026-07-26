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
var DIGEST_OPEN_HEADERS_ = ['house', 'ticketId', 'title', 'status', 'openedDate', 'updatedAt'];
var DIGEST_WEEKLY_HEADERS_ = ['house', 'weekStart', 'status', 'shortagesSummary', 'updatedAt'];

// Weekly-count status vocabulary (Hebrew display values are the stored values).
var DIGEST_DONE_ = 'בוצעה';
var DIGEST_NOT_DONE_ = 'לא בוצעה';

// ---- Pure helpers (mirror of src/digest.js) ----

// House id map — the four OPEN houses with a coordinator. הפרדס / שדה אליעזר are pre-opening
// (excluded). Any house that does not map is OMITTED, never guessed. IDs use the SHARED
// ezone-kitchen vocabulary (contract v2); the mapping applies at the digest boundary ONLY —
// Logistics still keys on the Hebrew house NAME internally.
var DIGEST_HOUSE_IDS_ = {
  'רעננה': 'raanana-asher',
  'רמות השבים': 'ramot-hashavim',
  'קיסריה עפרוני': 'caesarea-ofroni',
  'ריהאב': 'caesarea-rehab',
};
var DIGEST_HOUSE_ID_ORDER_ = ['raanana-asher', 'ramot-hashavim', 'caesarea-ofroni', 'caesarea-rehab'];

function digestHouseId_(name) {
  if (name == null) return null;
  var key = String(name).trim();
  return Object.prototype.hasOwnProperty.call(DIGEST_HOUSE_IDS_, key) ? DIGEST_HOUSE_IDS_[key] : null;
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

  var rows = [];
  requests.forEach(function (req) {
    var house = digestHouseId_(req.house);
    if (!house) return;                          // unmapped house → omitted
    if (!digestIsActiveTicket_(req.status)) return;
    var id = String(req.id);
    var updatedAt = latestAudit[id] || digestIso_(req.created_at);
    rows.push([
      house,
      id,
      digestFormatTitle_(req.description),
      String(req.status == null ? '' : req.status),
      digestDateOnly_(req.created_at),
      updatedAt,
    ]);
  });
  return rows;
}

/**
 * WeeklyCounts rows — always 4 houses × last 8 weeks (32 rows) so gaps surface as 'לא בוצעה'.
 *
 * Increment 26: inventory is WEEKLY and rows carry `week_start` + `source`. status is 'בוצעה'
 * ONLY when a source='coordinator' row exists for that house+week — a kitchen-only count does
 * NOT satisfy it (the coordinator is the confirming human). shortagesSummary draws from BOTH
 * sources (items at qty 0, with any note), so a kitchen count still surfaces shortages even
 * before the coordinator confirms. A blank source reads as 'coordinator' (backfill rule).
 *
 * We still read week_start defensively: if the column is absent (pre-migration sheet), every
 * row emits 'לא בוצעה' with an empty shortagesSummary — we never fabricate weekly data.
 */
function buildWeeklyCountRows_() {
  var weeks = digestRecentWeekStarts_(new Date(), DIGEST_WEEKS_);
  var nowIso = new Date().toISOString();

  var counts = readObjects_('InventoryCounts');
  var hasWeek = counts.length > 0 && Object.prototype.hasOwnProperty.call(counts[0], 'week_start');
  var byKey = {}; // 'houseId|weekStart' -> { updatedAt, hasCoordinator, shortages[] }

  if (hasWeek) {
    counts.forEach(function (c) {
      var house = digestHouseId_(c.house);
      if (!house) return;
      var wk = digestDateOnly_(c.week_start);
      if (!wk) return;
      var key = house + '|' + wk;
      var bucket = byKey[key] || (byKey[key] = { updatedAt: '', hasCoordinator: false, shortages: [] });
      if (digestResolveSource_(c.source) === 'coordinator') bucket.hasCoordinator = true;
      var ts = digestIso_(c.counted_at);
      if (ts && ts > bucket.updatedAt) bucket.updatedAt = ts;
      // A shortage = an item counted at qty 0; carry any note alongside it. Both sources count.
      var qtyZero = (c.quantity === 0 || String(c.quantity).trim() === '0');
      if (qtyZero) {
        var label = String(c.item || '');
        var note = String(c.notes || '').trim();
        bucket.shortages.push(note ? (label + ' (' + note + ')') : label);
      }
    });
  }

  var rows = [];
  DIGEST_HOUSE_ID_ORDER_.forEach(function (house) {
    weeks.forEach(function (wk) {
      var bucket = hasWeek ? byKey[house + '|' + wk] : null;
      if (bucket && bucket.hasCoordinator) {
        // Coordinator confirmed → 'בוצעה', shortages from both sources.
        rows.push([
          house, wk, DIGEST_DONE_,
          digestScrubMoney_(bucket.shortages.join('; ')),
          bucket.updatedAt || nowIso,
        ]);
      } else if (bucket) {
        // Kitchen-only (or non-coordinator) count → NOT 'בוצעה', but its shortages still surface.
        rows.push([
          house, wk, DIGEST_NOT_DONE_,
          digestScrubMoney_(bucket.shortages.join('; ')),
          bucket.updatedAt || nowIso,
        ]);
      } else {
        // No count at all for this house/week → not-done, no shortages.
        rows.push([house, wk, DIGEST_NOT_DONE_, '', nowIso]);
      }
    });
  });
  return rows;
}

// Resolve a count row's source; a blank cell reads as 'coordinator' (mirror of resolveSource).
function digestResolveSource_(v) {
  var s = v == null ? '' : String(v).trim();
  return s === '' ? 'coordinator' : s;
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
