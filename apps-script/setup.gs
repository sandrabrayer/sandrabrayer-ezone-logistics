/**
 * setup.gs — one-time provisioning for this app's own Google Sheet.
 *
 * Run setupSheet() once from the Apps Script editor against a FRESH spreadsheet
 * (this app's own — never the Dashboard/Managers spreadsheet).
 *
 * Idempotent: creates any missing tab, writes headers if absent, and seeds Houses /
 * Technicians / Config only when those tabs are empty (won't duplicate on re-run).
 *
 * Header and seed definitions are mirrored from src/schema.js. That file is the source of
 * truth; keep the two in sync (a test verifies the JS side).
 */

var HEADERS = {
  Requests: [
    'id', 'created_at', 'created_by', 'house', 'category', 'description', 'location_in_house',
    'urgency', 'estimated_cost', 'attachment_url', 'status', 'approval_required', 'approved_by',
    'approved_at', 'rejection_reason', 'deferred_until', 'assigned_to', 'assignment_type',
    'trade', 'batch_id', 'completed_at', 'actual_cost', 'completion_notes',
    'execution_status',
    // SLA + aging (increment 36) — APPENDED at the end (existing sheets gain them via setupSheet()).
    'due_at', 'blocked', 'blocked_reason', 'blocked_at',
    // Preventive maintenance (תחזוקה מונעת) — plan_id APPENDED at the end (existing sheets gain it
    // via the append branch in setupSheet()). Blank for normal requests.
    'plan_id',
    // Compliance (עמידה באמות מידה) — compliance_id APPENDED at the end (existing sheets gain it via the
    // append branch in setupSheet()). Blank for normal requests.
    'compliance_id',
  ],
  Houses: ['name', 'technician', 'cluster', 'status'],
  Config: ['key', 'value'],
  // People + their role/scope (increment 30). Mirror of src/schema.js HEADERS.Users.
  // Increment 31: pin_hash APPENDED at the end (never reorder). Existing sheets gain it via the
  // append branch in setupSheet(); managers' hashes are written later by setUserPin().
  Users: ['name', 'role', 'house', 'active', 'pin_hash'],
  Technicians: ['name', 'type', 'cluster', 'trade', 'phone', 'rate', 'notes'],
  AuditLog: ['request_id', 'from_status', 'to_status', 'by', 'timestamp', 'note'],
  Inspections: [
    'id', 'house', 'inspection_date', 'inspector', 'started_at',
    'patient_count', 'staff_present', 'start_time', 'cleaner_present',
    'domain_treatment_summary', 'domain_cleanliness_summary', 'domain_kitchen_summary',
    'general_notes', 'reinspect_date', 'status',
  ],
  InspectionFindings: [
    'id', 'inspection_id', 'domain', 'location_in_house', 'finding_text',
    'finding_type', 'severity', 'suggested_category',
    'linked_request_id', 'confirmed_by', 'confirmed_at',
  ],
  ChecklistItems: ['domain', 'item_text', 'active'],
  // base_unit / allowed_units / par_base APPENDED at the end (increment 33) — units + par, all edited
  // in the SHEET (no deploy). Existing sheets gain them via the append branch in setupSheet().
  InventoryItems: ['category', 'item_text', 'active', 'base_unit', 'allowed_units', 'par_base'],
  // week_start APPENDED at the end (increment 26); unit_label / unit_factor / quantity_base APPENDED
  // (increment 33). Existing sheets gain them via the append branch in setupSheet() — no reorder, no
  // data loss. quantity_base = quantity × unit_factor; the factor is frozen at count time.
  InventoryCounts: [
    'count_id', 'house', 'month', 'counted_by', 'counted_at',
    'category', 'item', 'quantity', 'notes',
    'week_start',
    'unit_label', 'unit_factor', 'quantity_base',
  ],
  // Budgets — one row per house (canonical id) per month (YYYY-MM), amount in NIS. Created empty by
  // setupSheet(); Olga fills rows in the Sheet. Financial — never written to any digest. Append-only.
  Budgets: ['house', 'period', 'amount', 'notes'],
  // Preventive-maintenance plan (תחזוקה מונעת) — one row per recurring task; Olga fills rows in the
  // Sheet (no entry UI). Created empty by setupSheet(). house = canonical id (HOUSE-IDS.md) OR 'all'.
  // frequency_months = positive int; last_done = date (blank = never → due now); active = TRUE/FALSE.
  // next_due / overdue are DERIVED, never stored. Append-only. Only last_done is written back (on הושלם).
  MaintenancePlan: ['id', 'house', 'task', 'frequency_months', 'last_done', 'active', 'notes'],
  // Compliance (עמידה באמות מידה) — one row per certificate/license/inspection with an expiry; Olga fills
  // rows in the Sheet (no entry UI). Created empty by setupSheet(). house = canonical id (HOUSE-IDS.md)
  // OR 'all'. item = Hebrew name; expires_at = date; reminder_days = int (blank = Config default); doc_url
  // optional; active = TRUE/FALSE. days_to_expiry / status are DERIVED, never stored. Append-only. Nothing
  // is written back on completion — Olga updates expires_at from the new certificate by hand.
  Compliance: ['id', 'house', 'item', 'expires_at', 'reminder_days', 'doc_url', 'notes', 'active'],
  // Exceptional-events register (אירועים חריגים) — reported from the FIELD via the /events UI (not a
  // fill-in-Sheet module). Created empty by setupSheet(). created_by = session identity (never client);
  // house = canonical id; occurred_at = date; event_type from Config event_types; severity נמוך/בינוני/גבוה;
  // status פתוח/בטיפול/נסגר; corrective_request_id optionally links a Request. Operational fields ONLY —
  // never clinical content. Append-only. Recurrence/trend are DERIVED for /management, never stored.
  Events: [
    'id', 'created_at', 'created_by', 'house', 'occurred_at', 'event_type', 'severity',
    'description', 'immediate_action', 'root_cause', 'lessons', 'corrective_request_id',
    'status', 'closed_at', 'notes',
  ],
  // Pre-opening readiness checklist (מוכנות בתים לפתיחה) — Logistics-owned (PR B). One row per checklist
  // item per pre-opening house. done = TRUE/FALSE; date + by filled on completion. Created + seeded empty
  // (unchecked) idempotently by setupSheet() for the pre-opening houses; edited in the Sheet, no entry UI.
  OpeningChecklist: ['house', 'item', 'done', 'date', 'by'],
  // Emergency-readiness checklist (בקרת מוכנות לזמן חירום) — Logistics-owned (PR B). One row per control
  // item per house (generator/gas/water/first-aid/…). Editable list in the Sheet. Created + seeded empty
  // idempotently by setupSheet(); read READ-ONLY by /management.
  EmergencyReadiness: ['house', 'item', 'done', 'date', 'by'],
};

// Canonical display names from HOUSE-IDS.md (increment 33) — must match that file exactly.
var SEED_HOUSES = [
  ['רעננה אשר',     'רמי', 'sharon',   'open'],
  ['רמות השבים',    'רמי', 'sharon',   'open'],
  ['רעננה הפרדס',   'רמי', 'sharon',   'pre-opening'],
  ['קיסריה עפרוני', 'צחי', 'caesarea', 'open'],
  ['קיסריה ריהאב',  'צחי', 'caesarea', 'open'],
  ['שדה אליעזר',    'צחי', 'north',    'pre-opening'],
];

var SEED_TECHNICIANS = [
  ['רמי', 'internal', 'sharon',   'general', '', '', 'אחראי תחזוקה – שרון'],
  ['צחי', 'internal', 'caesarea', 'general', '', '', 'אחראי תחזוקה – קיסריה וצפון'],
];

var SEED_CONFIG = [
  ['approval_threshold', '3000'],
  ['emergency_bypasses_approval', 'TRUE'],
  // ceo_ceiling — kept but DORMANT since increment 31 (chain B v2 does not read it). Upserted by
  // key so a re-run of setupSheet() ADDS it to existing sheets without overwriting approval_threshold.
  ['ceo_ceiling', ''],
  // sla_days (increment 36) — "urgency:days" spec, tunable in the Sheet with no deploy. Upserted by
  // key, so a re-run ADDS it to existing sheets without touching other Config rows.
  ['sla_days', 'חירום:1|דחוף:3|רגיל:14'],
  // Foreign digest ids the /management screen reads READ-ONLY. Upserted by key. Blank = panel "לא זמין".
  // Grant the Logistics Apps Script account VIEWER access to the kitchen spreadsheet for the read to work.
  ['kitchen_digest_id', '1sJ62lUfgyaes_Ippv1CH3acLmExju3aZXAfk12g0zfE'],
  ['coordinators_digest_id', ''],
  // training_digest_id — the coordinators-PUBLISHED digest (tab TrainingCompliance) read READ-ONLY by the
  // /management "עמידה בתוכנית הדרכה" panel. Upserted by key. Blank = panel "לא זמין". Grant VIEWER access.
  ['training_digest_id', '1RgLLrvymIhRh0sN6jOuCcgr5VT8hQL8wofhjUUt1CCI'],
  // compliance_reminder_days (compliance tracker) — days before a certificate expiry to start warning +
  // generating a renewal request, when a Compliance row leaves reminder_days blank. Upserted by key. A
  // malformed value is logged and falls back to this seeded default (30) — never a silent number beyond it.
  ['compliance_reminder_days', '30'],
  // event_types (exceptional-events register) — pipe-separated allowed categories, tunable in the Sheet
  // with no deploy. Upserted by key. Malformed/blank → the entry form falls back to אחר only (logged).
  ['event_types', 'בטיחות|תרופות|התנהגות|תשתיות|תברואה|אחר'],
];

// Roster (active = TRUE). Upserted by `name` — a re-run never duplicates a row and never overwrites
// an edited one (so a manager's set pin_hash survives). Mirror of src/schema.js SEED_USERS. The 5th
// column (pin_hash) seeds BLANK for everyone — managers' hashes are set later via setUserPin(),
// never seeded as plaintext.
var SEED_USERS = [
  ['רועי',  'field_ops',   '',               'TRUE', ''],
  ['אולגה', 'ops_manager', '',               'TRUE', ''],
  ['סנדרה', 'ceo',         '',               'TRUE', ''],
  ['רמי',   'maintenance', 'sharon',         'TRUE', ''],
  ['צחי',   'maintenance', 'caesarea,north', 'TRUE', ''],
  ['שירה',  'coordinator', 'קיסריה עפרוני',   'TRUE', ''],
  ['יעקב',  'coordinator', 'קיסריה ריהאב',    'TRUE', ''],
  ['אורן',  'coordinator', 'רעננה אשר',       'TRUE', ''],
  ['אביב',  'coordinator', 'רמות השבים',      'TRUE', ''],
];

var SEED_CHECKLIST = [
  ['treatment', 'תיקים ממוחשבים מסודרים ומעודכנים', 'TRUE'],
  ['treatment', 'אינטייקים סרוקים ומצורפים', 'TRUE'],
  ['treatment', 'כל המטופלים רשומים במערכת', 'TRUE'],
  ['treatment', 'סטנדרטים טיפוליים נשמרים', 'TRUE'],
  ['cleanliness', 'נראות כללית וניקיון שטחים ציבוריים', 'TRUE'],
  ['cleanliness', 'ברזים, מקלחונים ומראות נקיים מאבנית', 'TRUE'],
  ['cleanliness', 'חדרי שינה נקיים ומאווררים', 'TRUE'],
  ['cleanliness', 'מסילות חלונות, מעקות ודלתות נקיים', 'TRUE'],
  ['cleanliness', 'חדר כביסה נקי ונעול', 'TRUE'],
  ['cleanliness', 'תאורה תקינה בכל החדרים', 'TRUE'],
  ['cleanliness', 'חצר/בריכה נקיים ובטיחותיים', 'TRUE'],
  ['cleanliness', 'פערי תחזוקה (צבע, פאנלים, מזגנים)', 'TRUE'],
  ['kitchen', 'ניקיון מטבח וציוד מטבח', 'TRUE'],
  ['kitchen', 'מוצרי חשמל תקינים ובמקומם', 'TRUE'],
  ['kitchen', 'אחסון מזון תקין ובטיחותי', 'TRUE'],
  ['kitchen', 'בדיקת מחסן ומלאים', 'TRUE'],
];

// Inventory catalog seed — edit in the Sheet, no code change needed (active=FALSE hides an item,
// new rows extend the list). Columns: category, item_text, active, base_unit, allowed_units, par_base.
// base_unit / allowed_units / par_base are STARTING POINTS (increment 33) — labels, options and par
// are all edited in the sheet afterward with NO deploy. par_base is a flat weekly par per house.
// Increment 26: the מזון rows are seeded active=FALSE — food moved to ezone-kitchen, but the rows
// stay so increment-25 historical counts still resolve. Do NOT delete them (setupSheet only writes
// seeds on a FRESH sheet; this preserves the retired-but-kept intent). Retired rows carry no units.
// Increment 33 SPLIT: 'אבקת/ג׳ל כביסה' retired → אבקת כביסה (kg) + ג׳ל כביסה (l); no rows to migrate.
// Every row has the SAME width (6) — seedIfEmpty_ writes a rectangular range.
var SEED_INVENTORY_ITEMS = [
  ['טואלטיקה', 'נייר טואלט', 'TRUE', 'unit', 'גליל:1|חבילה 8:8|חבילה 24:24', 48],
  ['טואלטיקה', 'מגבות נייר', 'TRUE', 'unit', 'גליל:1|חבילה 4:4', 24],
  ['טואלטיקה', 'טישו', 'TRUE', 'unit', 'קופסה:1|חבילה 6:6', 12],
  ['טואלטיקה', 'סבון ידיים', 'TRUE', 'ml', 'בקבוק 500מל:500|ליטר:1000|גלון 4ל:4000', 5000],
  ['טואלטיקה', 'שמפו', 'TRUE', 'ml', 'בקבוק 750מל:750|ליטר:1000|גלון 4ל:4000', 5000],
  ['טואלטיקה', 'סבון רחצה', 'TRUE', 'unit', "יח':1|חבילה 6:6", 20],
  ['טואלטיקה', 'משחת שיניים', 'TRUE', 'unit', "יח':1", 10],
  ['טואלטיקה', 'מברשות שיניים', 'TRUE', 'unit', "יח':1|חבילה 4:4", 10],
  ['חומרי ניקוי', 'אקונומיקה', 'TRUE', 'l', 'בקבוק 1ל:1|בקבוק 2ל:2|בקבוק 4ל:4', 10],
  ['חומרי ניקוי', 'נוזל רצפות', 'TRUE', 'l', 'בקבוק 1ל:1|בקבוק 2ל:2|גלון 4ל:4', 10],
  ['חומרי ניקוי', 'נוזל כלים', 'TRUE', 'l', 'בקבוק 750מל:0.75|בקבוק 1ל:1|גלון 4ל:4', 6],
  ['חומרי ניקוי', 'ספוגים', 'TRUE', 'unit', "יח':1|חבילה 10:10", 20],
  ['חומרי ניקוי', 'מטליות', 'TRUE', 'unit', "יח':1|חבילה 10:10", 20],
  ['חומרי ניקוי', 'שקיות אשפה', 'TRUE', 'unit', "גליל 20:20|גליל 50:50|יח':1", 200],
  ['חומרי ניקוי', 'תרסיס חיטוי', 'TRUE', 'unit', 'בקבוק:1|חבילה 3:3', 6],
  ['חומרי ניקוי', 'אבקת/ג׳ל כביסה', 'FALSE', '', '', ''],
  ['חומרי ניקוי', 'אבקת כביסה', 'TRUE', 'kg', 'שקית 5 ק"ג:5|שקית 10 ק"ג:10', 10],
  ['חומרי ניקוי', 'ג׳ל כביסה', 'TRUE', 'l', 'בקבוק 3ל:3|בקבוק 5ל:5', 5],
  ['חומרי ניקוי', 'מרכך כביסה', 'TRUE', 'l', 'בקבוק 1ל:1|בקבוק 2ל:2|בקבוק 4ל:4', 5],
  // מזון RETIRED (increment 26) — active=FALSE, no units (never counted).
  ['מזון', 'אורז', 'FALSE', '', '', ''],
  ['מזון', 'פסטה', 'FALSE', '', '', ''],
  ['מזון', 'קמח', 'FALSE', '', '', ''],
  ['מזון', 'סוכר', 'FALSE', '', '', ''],
  ['מזון', 'מלח', 'FALSE', '', '', ''],
  ['מזון', 'שמן', 'FALSE', '', '', ''],
  ['מזון', 'קפה', 'FALSE', '', '', ''],
  ['מזון', 'תה', 'FALSE', '', '', ''],
  ['מזון', 'שימורים', 'FALSE', '', '', ''],
  ['מזון', 'דגני בוקר', 'FALSE', '', '', ''],
];

// Pre-opening + emergency readiness checklists (PR B). Mirror of src/schema.js. Seeded UNCHECKED
// (done=FALSE, date/by blank) so the panels show real "not yet done" state, never a fabricated ready.
// Every row is the SAME width (5) — seedIfEmpty_ writes a rectangular range.
var PRE_OPENING_HOUSES = ['רעננה הפרדס', 'שדה אליעזר'];
var OPENING_CHECKLIST_ITEMS = [
  'חשמל, מים וגז מחוברים ותקינים',
  'ריהוט וציוד בסיסי הותקן',
  'ניקיון מסירה בוצע',
  'בטיחות: מטפים וגילוי אש תקינים',
  'מלאי פתיחה ראשוני הוזמן',
];
var SEED_OPENING_CHECKLIST = (function () {
  var rows = [];
  PRE_OPENING_HOUSES.forEach(function (house) {
    OPENING_CHECKLIST_ITEMS.forEach(function (item) { rows.push([house, item, 'FALSE', '', '']); });
  });
  return rows;
})();
var EMERGENCY_READINESS_ITEMS = [
  'גנרטור חירום תקין',
  'מלאי גז / דלק',
  'מים לשעת חירום (מכל רזרבה)',
  'ערכת עזרה ראשונה מלאה',
  'מטפי כיבוי אש בתוקף',
];
var SEED_EMERGENCY_READINESS = (function () {
  var rows = [];
  SEED_HOUSES.forEach(function (h) {
    EMERGENCY_READINESS_ITEMS.forEach(function (item) { rows.push([h[0], item, 'FALSE', '', '']); });
  });
  return rows;
})();

function setupSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  Object.keys(HEADERS).forEach(function (name) {
    var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
    var headers = HEADERS[name];

    // Write headers if the first row is empty...
    var firstCell = sheet.getRange(1, 1).getValue();
    if (firstCell === '' || firstCell === null) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
      sheet.setFrozenRows(1);
    } else {
      // ...otherwise, APPEND any new columns that were added to the schema later
      // (e.g. inspection background fields), so existing sheets gain them without data loss.
      var existing = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      headers.forEach(function (h) {
        if (existing.indexOf(h) === -1) {
          var newCol = sheet.getLastColumn() + 1;
          sheet.getRange(1, newCol).setValue(h).setFontWeight('bold');
          existing.push(h);
        }
      });
    }
  });

  seedIfEmpty_(ss.getSheetByName('Houses'), SEED_HOUSES);
  seedIfEmpty_(ss.getSheetByName('Technicians'), SEED_TECHNICIANS);
  seedIfEmpty_(ss.getSheetByName('ChecklistItems'), SEED_CHECKLIST);
  seedIfEmpty_(ss.getSheetByName('InventoryItems'), SEED_INVENTORY_ITEMS);
  // PR B: pre-opening + emergency readiness checklists — seeded UNCHECKED, idempotent (only on a fresh tab).
  seedIfEmpty_(ss.getSheetByName('OpeningChecklist'), SEED_OPENING_CHECKLIST);
  seedIfEmpty_(ss.getSheetByName('EmergencyReadiness'), SEED_EMERGENCY_READINESS);

  // Config + Users are upserted by key/name (NOT seed-if-empty) so re-running setupSheet() after
  // this increment ADDS the new ceo_ceiling key and the Users roster to already-populated sheets,
  // without duplicating or overwriting anything an operator has edited.
  upsertByKeyColumn_(ss.getSheetByName('Config'), SEED_CONFIG, 0);   // match on column 0 = key
  upsertByKeyColumn_(ss.getSheetByName('Users'), SEED_USERS, 0);     // match on column 0 = name

  // Remove the default "Sheet1" if it was auto-created and is unused.
  var def = ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1 && def.getLastRow() === 0) {
    ss.deleteSheet(def);
  }

  // setupSheet() may have upserted Config/Houses rows — drop their reference caches so the running
  // deployment reads the fresh seeds immediately instead of waiting out the CacheService TTL. (Users is
  // read live, never cached — see getUsers — so there is nothing to invalidate for it.)
  invalidateReference_('Config');
  invalidateReference_('Houses');
}

/** Append seed rows only when the sheet has just its header row (last row === 1). */
function seedIfEmpty_(sheet, rows) {
  if (!sheet || rows.length === 0) return;
  if (sheet.getLastRow() > 1) return; // already has data
  sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}

/**
 * Idempotent upsert by a key column: append only the seed rows whose key (column `keyCol`) is not
 * already present. Existing rows are NEVER overwritten — an operator's edits survive a re-run, and
 * re-running never duplicates a seeded row. Used for Config (key) and Users (name).
 */
function upsertByKeyColumn_(sheet, rows, keyCol) {
  if (!sheet || !rows || rows.length === 0) return;
  var existing = {};
  var last = sheet.getLastRow();
  if (last > 1) {
    var vals = sheet.getRange(2, keyCol + 1, last - 1, 1).getValues();
    for (var i = 0; i < vals.length; i++) existing[String(vals[i][0])] = true;
  }
  var toAppend = rows.filter(function (row) { return !existing[String(row[keyCol])]; });
  if (toAppend.length === 0) return;
  sheet.getRange(sheet.getLastRow() + 1, 1, toAppend.length, toAppend[0].length).setValues(toAppend);
}

// ===== Per-user password helper (increment 31, tier A: רועי / אולגה) =====
//
// setUserPin(name, plaintext) hashes a password with salted PBKDF2-HMAC-SHA256 and writes it to the
// user's pin_hash cell. Run it ONCE from the Apps Script editor for each manager, e.g.
//   setUserPin('רועי', 'their-password');   setUserPin('אולגה', 'her-password');
// It NEVER logs or stores the plaintext. The stored format is identical to src/auth.js hashPin, so
// the Node login layer (which owns password verification — Code.gs trusts only the signed token)
// verifies it directly. Parity between THIS Apps Script PBKDF2 and Node's crypto.pbkdf2Sync (used by
// src/auth.js verifyPin) is confirmed by running verifyPinParity_() in the Apps Script editor and
// checking its logged hash equals the committed vector in test/auth.test.js — the node:test suite
// cannot run the Apps Script runtime, so it only pins the Node side to that same vector.
var PBKDF2_ITERS_ = 100000;   // stored in the hash string, so verification always uses this count

function setUserPin(name, plaintext) {
  if (!name || !plaintext) throw new Error('setUserPin(name, plaintext) — both are required');
  var sheet = getSheet_('Users');
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var nameCol = headers.indexOf('name');
  var hashCol = headers.indexOf('pin_hash');
  if (hashCol === -1) throw new Error('Users sheet has no pin_hash column — run setupSheet() first.');
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][nameCol]) === String(name)) {
      var stored = hashPin_(String(plaintext));   // salt generated inside; plaintext never kept
      sheet.getRange(r + 1, hashCol + 1).setValue(stored);
      // Users is read live (never cached) — the new pin_hash is visible to the very next login. No cache to drop.
      Logger.log('pin_hash set for user "' + name + '" (' + PBKDF2_ITERS_ + ' iterations)');  // NO plaintext
      return true;
    }
  }
  throw new Error('User not found: ' + name);
}

// Produce a "pbkdf2$sha256$<iters>$<saltHex>$<hashHex>" string. 16-byte random salt, 32-byte output.
function hashPin_(plaintext) {
  var salt = [];
  for (var i = 0; i < 16; i++) salt.push(Math.floor(Math.random() * 256));
  var dk = pbkdf2Sha256_(plaintext, salt, PBKDF2_ITERS_);
  return 'pbkdf2$sha256$' + PBKDF2_ITERS_ + '$' + bytesToHex_(salt) + '$' + bytesToHex_(dk);
}

// PBKDF2-HMAC-SHA256 for a single 32-byte block (dkLen = hLen), so DK = U1 xor U2 xor ... xor Uc.
// U1 = HMAC(password, salt || 0x00000001); Ui = HMAC(password, U_{i-1}). Matches crypto.pbkdf2Sync.
//
// Apps Script's Utilities.computeHmacSha256Signature accepts ONLY (String, String) or (Byte[],
// Byte[]) — NOT (Byte[], String). Increment 31 passed a byte-array message with a String key, so it
// threw on every call (increment 32 hotfix). We use the (Byte[], Byte[]) overload throughout:
//   - the password is converted to its UTF-8 bytes, so Hebrew / non-ASCII passwords hash correctly
//     (never char codes);
//   - every message byte we build from a salt, hex, or XOR is converted to Apps Script's SIGNED
//     byte range (-128..127) before being passed in (values > 127 → b - 256). HMAC output is already
//     signed, so it is fed straight back as the next message; we mask to unsigned (& 0xff) only when
//     accumulating and when hex-encoding the result.
function pbkdf2Sha256_(password, saltBytes, iterations) {
  var pwBytes = Utilities.newBlob(String(password)).getBytes();      // UTF-8, signed Byte[]
  var block = toSignedBytes_(saltBytes.concat([0, 0, 0, 1]));        // salt || INT_32_BE(1), signed
  var u = Utilities.computeHmacSha256Signature(block, pwBytes);      // U1 (signed Byte[])
  var t = [];
  for (var k = 0; k < u.length; k++) t[k] = u[k] & 0xff;            // accumulator, unsigned 0..255
  for (var i = 1; i < iterations; i++) {
    u = Utilities.computeHmacSha256Signature(u, pwBytes);           // Ui = HMAC(pw, U_{i-1}); u signed
    for (var j = 0; j < t.length; j++) t[j] = (t[j] ^ u[j]) & 0xff;
  }
  return t;                                            // 32 unsigned bytes (0..255)
}

// Convert byte values (possibly unsigned 0..255) to Apps Script's signed byte range (-128..127),
// so a Byte[] built from a salt or hex is accepted by computeHmacSha256Signature.
function toSignedBytes_(bytes) {
  var out = [];
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] & 0xff;
    out.push(b > 127 ? b - 256 : b);
  }
  return out;
}

function hexToBytes_(hex) {
  var out = [];
  for (var i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.substr(i, 2), 16)); // 0..255
  return out;
}

function bytesToHex_(bytes) {
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] & 0xff;
    var h = b.toString(16);
    if (h.length < 2) h = '0' + h;
    hex += h;
  }
  return hex;
}

// Diagnostic (increment 32): hash a FIXED test password with a FIXED salt — a TEST VECTOR, not a
// real credential — and log the resulting hash string. Writes NOTHING to any sheet and is safe to
// run repeatedly. Run it from the Apps Script editor and confirm the logged value is EXACTLY the
// EXPECTED_PARITY_HASH committed in test/auth.test.js. THAT is what proves the LIVE Apps Script
// PBKDF2 matches Node's crypto.pbkdf2Sync — the node:test suite cannot exercise the Apps Script
// runtime, so it can only pin the Node side to the same committed vector.
function verifyPinParity_() {
  var password = 'סיסמה-Test-1!';                     // fixed test vector (Hebrew + ASCII) — NOT a real password
  var saltHex = '0102030405060708090a0b0c0d0e0f10';   // fixed 16-byte salt
  var dk = pbkdf2Sha256_(password, hexToBytes_(saltHex), PBKDF2_ITERS_);
  var hash = 'pbkdf2$sha256$' + PBKDF2_ITERS_ + '$' + saltHex + '$' + bytesToHex_(dk);
  Logger.log(hash);   // only the fixed test vector is involved; safe to share
  return hash;
}
