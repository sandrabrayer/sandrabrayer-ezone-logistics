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
  Inspections: [
    'id', 'house', 'inspection_date', 'inspector', 'started_at',
    'patient_count', 'staff_present', 'start_time', 'cleaner_present',
    'domain_treatment_summary', 'domain_cleanliness_summary', 'domain_kitchen_summary',
    'general_notes', 'status',
  ],
  InspectionFindings: [
    'id', 'inspection_id', 'domain', 'location_in_house', 'finding_text',
    'finding_type', 'severity', 'suggested_category',
    'linked_request_id', 'confirmed_by', 'confirmed_at',
  ],
  ChecklistItems: ['domain', 'item_text', 'active'],
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
  seedIfEmpty_(ss.getSheetByName('Config'), SEED_CONFIG);
  seedIfEmpty_(ss.getSheetByName('ChecklistItems'), SEED_CHECKLIST);

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
