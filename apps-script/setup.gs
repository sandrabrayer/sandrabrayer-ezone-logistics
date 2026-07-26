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
    'batch_id', 'completed_at', 'actual_cost', 'completion_notes',
  ],
  Houses: ['name', 'technician', 'cluster', 'status'],
  Config: ['key', 'value'],
  Technicians: ['name', 'type', 'cluster', 'trade', 'phone', 'rate', 'notes'],
  AuditLog: ['request_id', 'from_status', 'to_status', 'by', 'timestamp', 'note'],
  Users: ['name', 'role', 'house', 'active'],
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
  ['ceo_ceiling', ''], // blank = disabled (see src/schema.js / src/approval.js)
];

// Users seed (increment 28). Mirrors SEED_USERS in src/schema.js. house encoding:
// '*' = all houses, 'cluster:a+b' = maintenance clusters, literal name = coordinator's own house.
var SEED_USERS = [
  ['רועי',  'field_ops',   '*',                    'TRUE'],
  ['אולגה', 'ops_manager', '*',                    'TRUE'],
  ['סנדרה', 'ceo',         '*',                    'TRUE'],
  ['רמי',   'maintenance', 'cluster:sharon',       'TRUE'],
  ['צחי',   'maintenance', 'cluster:caesarea+north', 'TRUE'],
  ['שירה',  'coordinator', 'קיסריה עפרוני',        'TRUE'],
  ['יעקב',  'coordinator', 'ריהאב',                'TRUE'],
  ['אורן',  'coordinator', 'רעננה',                'TRUE'],
  ['אביב',  'coordinator', 'רמות השבים',           'TRUE'],
];

function setupSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  Object.keys(HEADERS).forEach(function (name) {
    var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
    var headers = HEADERS[name];

    // Write headers only if the first row is empty (don't clobber existing data).
    var firstCell = sheet.getRange(1, 1).getValue();
    if (firstCell === '' || firstCell === null) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
  });

  seedIfEmpty_(ss.getSheetByName('Houses'), SEED_HOUSES);
  seedIfEmpty_(ss.getSheetByName('Technicians'), SEED_TECHNICIANS);

  // Config + Users seed by KEY/NAME so a rerun adds only missing rows (e.g. the new ceo_ceiling
  // key on an already-seeded Config) and never duplicates existing ones.
  ensureRowsByKey_(ss.getSheetByName('Config'), SEED_CONFIG, 0);
  ensureRowsByKey_(ss.getSheetByName('Users'), SEED_USERS, 0);

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
 * Idempotent key-aware seed: append only rows whose key (column `keyCol`) is not already present.
 * Never touches existing rows, never duplicates — safe to rerun. Used for Config and Users so
 * new keys/users can be added over time without wiping or double-seeding.
 */
function ensureRowsByKey_(sheet, rows, keyCol) {
  if (!sheet || !rows || rows.length === 0) return;
  var existing = {};
  var last = sheet.getLastRow();
  if (last >= 2) {
    var keys = sheet.getRange(2, keyCol + 1, last - 1, 1).getValues();
    for (var i = 0; i < keys.length; i++) existing[String(keys[i][0])] = true;
  }
  var toAppend = [];
  for (var r = 0; r < rows.length; r++) {
    if (!existing[String(rows[r][keyCol])]) toAppend.push(rows[r]);
  }
  if (toAppend.length) {
    sheet.getRange(last + 1, 1, toAppend.length, rows[0].length).setValues(toAppend);
  }
}
