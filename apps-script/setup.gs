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
  InventoryItems: ['category', 'item_text', 'active'],
  // week_start APPENDED at the end (increment 26). Existing sheets gain it via the append branch
  // in setupSheet() — no reorder, no data loss.
  InventoryCounts: [
    'count_id', 'house', 'month', 'counted_by', 'counted_at',
    'category', 'item', 'quantity', 'notes',
    'week_start',
  ],
};

var SEED_HOUSES = [
  ['רעננה',         'רמי', 'sharon',   'open'],
  ['רמות השבים',    'רמי', 'sharon',   'open'],
  ['הפרדס',         'רמי', 'sharon',   'pre-opening'],
  ['קיסריה עפרוני', 'צחי', 'caesarea', 'open'],
  ['ריהאב',         'צחי', 'caesarea', 'open'],
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
  ['יעקב',  'coordinator', 'ריהאב',           'TRUE', ''],
  ['אורן',  'coordinator', 'רעננה',           'TRUE', ''],
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
// new rows extend the list). Increment 26: the מזון rows are seeded active=FALSE — food moved to
// ezone-kitchen, but the rows stay so increment-25 historical counts still resolve. Do NOT delete
// them (setupSheet only writes seeds on a FRESH sheet; this preserves the retired-but-kept intent).
var SEED_INVENTORY_ITEMS = [
  ['טואלטיקה', 'נייר טואלט', 'TRUE'],
  ['טואלטיקה', 'מגבות נייר', 'TRUE'],
  ['טואלטיקה', 'טישו', 'TRUE'],
  ['טואלטיקה', 'סבון ידיים', 'TRUE'],
  ['טואלטיקה', 'שמפו', 'TRUE'],
  ['טואלטיקה', 'סבון רחצה', 'TRUE'],
  ['טואלטיקה', 'משחת שיניים', 'TRUE'],
  ['טואלטיקה', 'מברשות שיניים', 'TRUE'],
  ['חומרי ניקוי', 'אקונומיקה', 'TRUE'],
  ['חומרי ניקוי', 'נוזל רצפות', 'TRUE'],
  ['חומרי ניקוי', 'נוזל כלים', 'TRUE'],
  ['חומרי ניקוי', 'ספוגים', 'TRUE'],
  ['חומרי ניקוי', 'מטליות', 'TRUE'],
  ['חומרי ניקוי', 'שקיות אשפה', 'TRUE'],
  ['חומרי ניקוי', 'תרסיס חיטוי', 'TRUE'],
  ['חומרי ניקוי', 'אבקת/ג׳ל כביסה', 'TRUE'],
  ['חומרי ניקוי', 'מרכך כביסה', 'TRUE'],
  // מזון RETIRED (increment 26) — kept as active=FALSE so increment-25 history resolves.
  ['מזון', 'אורז', 'FALSE'],
  ['מזון', 'פסטה', 'FALSE'],
  ['מזון', 'קמח', 'FALSE'],
  ['מזון', 'סוכר', 'FALSE'],
  ['מזון', 'מלח', 'FALSE'],
  ['מזון', 'שמן', 'FALSE'],
  ['מזון', 'קפה', 'FALSE'],
  ['מזון', 'תה', 'FALSE'],
  ['מזון', 'שימורים', 'FALSE'],
  ['מזון', 'דגני בוקר', 'FALSE'],
];

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
// verifies it directly. A Node parity test (test/auth.test.js) proves this PBKDF2 matches
// crypto.pbkdf2Sync byte-for-byte.
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
function pbkdf2Sha256_(password, saltBytes, iterations) {
  var block = saltBytes.concat([0, 0, 0, 1]);        // INT_32_BE(1)
  var u = Utilities.computeHmacSha256Signature(block, password);  // U1 (signed bytes)
  var t = [];
  for (var k = 0; k < u.length; k++) t[k] = u[k] & 0xff;          // accumulator, unsigned
  for (var i = 1; i < iterations; i++) {
    u = Utilities.computeHmacSha256Signature(u, password);        // Ui = HMAC(password, U_{i-1})
    for (var j = 0; j < t.length; j++) t[j] = (t[j] ^ u[j]) & 0xff;
  }
  return t;                                            // 32 unsigned bytes
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
