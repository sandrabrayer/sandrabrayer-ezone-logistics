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
    // Rejection retention — rejected_at APPENDED at the end (existing sheets gain it via the append
    // branch in setupSheet()). ISO when the request was rejected; blank until then.
    'rejected_at',
  ],
  Houses: ['name', 'technician', 'cluster', 'status'],
  Config: ['key', 'value'],
  // People + their role/scope (increment 30). Mirror of src/schema.js HEADERS.Users.
  // Increment 31: pin_hash APPENDED at the end (never reorder). Existing sheets gain it via the
  // append branch in setupSheet(); managers' hashes are written later by setUserPin().
  Users: ['name', 'role', 'house', 'active', 'pin_hash'],
  Technicians: ['name', 'type', 'cluster', 'trade', 'phone', 'rate', 'notes'],
  AuditLog: ['request_id', 'from_status', 'to_status', 'by', 'timestamp', 'note'],
  // NotifyLog (PR 5) — append-only e-mail dedupe ledger (request_id | event | sent_at). Mirror of schema.js.
  NotifyLog: ['request_id', 'event', 'sent_at'],
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
  // OpeningChecklist (PR B; template-seeded in the hub redesign) — a LOGISTICS-owned pre-opening readiness
  // checklist, one row per (house, item). Feeds the /management "מוכנות בתים לפתיחה" panel (read-only %) and
  // the ENTRY tab in Roy's /workorders view (field_ops edits done/date/by). setupSheet() SEEDS a FIXED
  // template per PRE-OPENING house (idempotent — only when empty). house = canonical display name.
  OpeningChecklist: ['id', 'house', 'item', 'done', 'date', 'by'],
  // EmergencyReadiness (PR B) — a per-house emergency-preparedness checklist (generator/gas/water/first-aid/
  // …). Feeds the /management "מוכנות לשעת חירום" panel (% ready) and is editable by field_ops + ops_manager.
  // setupSheet() SEEDS a default item set per house (idempotent — only when empty). Same shape as opening.
  EmergencyReadiness: ['id', 'house', 'item', 'done', 'date', 'by'],
  // PreventiveDaily (hub redesign) — a DAILY preventive-maintenance checklist for the maintenance leads
  // (רמי / צחי). One row per (house, date, item) COMPLETION — written from the /workorders "בדיקה יומית" tab,
  // scoped to the lead's own houses and today's date (server-stamped). The daily TEMPLATE is a short fixed
  // list (PREVENTIVE_DAILY_TEMPLATE, mirrored in Code.gs); this sheet stores only completions. Olga's hub
  // shows completion per house per day (last 7 days). Created EMPTY (completions accrue). done TRUE/FALSE.
  PreventiveDaily: ['house', 'date', 'item', 'done', 'by'],
  // Trainings (hub redesign — "מעקב הדרכות", the rename of עמידה באמות מידה) — a training-tracking log:
  // one row per training session. MANUAL entry in the Sheet for now; a later increment feeds it from the
  // Coordinators app via digest (NOT wired here). The /management panel lists rows per house and supports
  // delete (with confirm, audit-logged). Created EMPTY. attended = free text (who attended); by = recorder.
  Trainings: ['id', 'topic', 'house', 'date', 'attended', 'by'],
};

// Default emergency-preparedness items seeded per house (editable from the screen afterwards).
var DEFAULT_EMERGENCY_ITEMS = ['גנרטור', 'גז', 'מים', 'ערכת עזרה ראשונה', 'מטפי כיבוי אש', 'תאורת חירום'];

// Fixed pre-opening checklist template, seeded once per PRE-OPENING house (status 'pre-opening'). Editable
// in-sheet + toggled from Roy's /workorders entry tab. Mirrored (as validation) by Code.gs OPENING_TEMPLATE.
var OPENING_TEMPLATE = ['ריהוט', 'מכשירי חשמל', 'חיבור תשתיות (מים/חשמל/גז)', 'ציוד בטיחות', 'מסמכי רישוי', 'ניקיון', 'מפתחות'];

// Fixed daily preventive-maintenance template (kept short; editable later). Mirrored by Code.gs
// PREVENTIVE_DAILY_TEMPLATE, which validates every write against it.
var PREVENTIVE_DAILY_TEMPLATE = ['בדיקת דוד/גז', 'סבב מפגעים', 'תאורה', 'מים'];

// Build the OpeningChecklist seed: one row per (pre-opening house, template item). ids 'OPN-SEED-####'.
function buildOpeningChecklistSeed_() {
  var rows = [];
  var n = 0;
  for (var h = 0; h < SEED_HOUSES.length; h++) {
    if (String(SEED_HOUSES[h][3]) !== 'pre-opening') continue; // status column
    var houseName = SEED_HOUSES[h][0];
    for (var i = 0; i < OPENING_TEMPLATE.length; i++) {
      n++;
      rows.push(['OPN-SEED-' + String(n).padStart(4, '0'), houseName, OPENING_TEMPLATE[i], 'FALSE', '', '']);
    }
  }
  return rows;
}

// Build the EmergencyReadiness seed: one row per (house, default item), across every seeded house.
// ids are stable + collision-free with runtime genId_ (which stamps a 14-digit time) — 'EMR-SEED-####'.
function buildEmergencyReadinessSeed_() {
  var rows = [];
  var n = 0;
  for (var h = 0; h < SEED_HOUSES.length; h++) {
    var houseName = SEED_HOUSES[h][0];
    for (var i = 0; i < DEFAULT_EMERGENCY_ITEMS.length; i++) {
      n++;
      rows.push(['EMR-SEED-' + String(n).padStart(4, '0'), houseName, DEFAULT_EMERGENCY_ITEMS[i], 'FALSE', '', '']);
    }
  }
  return rows;
}

// Canonical display names from HOUSE-IDS.md (increment 33) — must match that file exactly.
// רעננה הפרדס OPENED (Aug 2026) — status 'open'; שדה אליעזר is the only pre-opening house left.
// NOTE: this seed applies to a FRESH sheet only (seedIfEmpty_). On the LIVE sheet the same change is
// one data edit: Houses tab → רעננה הפרדס row → status cell 'pre-opening' → 'open' (see PR notes).
var SEED_HOUSES = [
  ['רעננה אשר',     'רמי', 'sharon',   'open'],
  ['רמות השבים',    'רמי', 'sharon',   'open'],
  ['רעננה הפרדס',   'רמי', 'sharon',   'open'],
  ['קיסריה עפרוני', 'צחי', 'caesarea', 'open'],
  ['קיסריה ריהאב',  'צחי', 'caesarea', 'open'],
  ['שדה אליעזר',    'צחי', 'north',    'pre-opening'],
];

var SEED_TECHNICIANS = [
  ['רמי', 'internal', 'sharon',   'general', '', '', 'אחראי תחזוקה – שרון'],
  ['צחי', 'internal', 'caesarea', 'general', '', '', 'אחראי תחזוקה – קיסריה וצפון'],
];

var SEED_CONFIG = [
  // approval_threshold — LEGACY since PR 2 (chain B v3 routes every non-emergency request to ops_manager;
  // nothing reads it). Kept so an existing sheet keeps its row; still coerced to a number.
  ['approval_threshold', '3000'],
  ['emergency_bypasses_approval', 'TRUE'],
  // ceo_ceiling — REMOVED from the seed in PR 2 (the ceo role is gone). An existing row is harmless.
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
  // archive_after_days — completed (הושלם) / closed (סגור) requests whose completion is older than this
  // many days leave the main dashboard board for the read-only ארכיון tab (still searchable). Tunable in
  // the Sheet with no deploy; coerced to a number. Upserted by key. Blank/malformed → the UI default (7).
  ['archive_after_days', '7'],
  // E-mail notifications (PR 5) — mirror of src/schema.js SEED_CONFIG. Recipients seeded BLANK (fill in the
  // Sheet); notify_enabled = TRUE is the master switch; notify_app_url is the deep-link base. Upserted by key.
  ['notify_enabled', 'TRUE'],
  ['notify_email_approver', ''],
  ['notify_email_field_ops', ''],
  ['notify_app_url', 'https://ezone-logistics.up.railway.app'],
];

// Roster (active = TRUE). Upserted by `name` — a re-run never duplicates a row and never overwrites
// an edited one. Mirror of src/schema.js SEED_USERS. The 5th column (pin_hash) is LEGACY, append-only:
// seeds BLANK, nothing writes it any more (setUserPin is retired), login never reads it.
var SEED_USERS = [
  ['רועי',  'field_ops',   '',               'TRUE', ''],
  ['אולגה', 'ops_manager', '',               'TRUE', ''],
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
  // OpeningChecklist is seeded with the FIXED pre-opening template per pre-opening house; EmergencyReadiness
  // with the default item set per house. Both are seed-if-empty → idempotent (a re-run never duplicates).
  // PreventiveDaily + Trainings stay EMPTY (completions / manual log accrue at runtime).
  seedIfEmpty_(ss.getSheetByName('OpeningChecklist'), buildOpeningChecklistSeed_());
  seedIfEmpty_(ss.getSheetByName('EmergencyReadiness'), buildEmergencyReadinessSeed_());

  // Config + Users are upserted by key/name (NOT seed-if-empty) so re-running setupSheet() after
  // this increment ADDS the new ceo_ceiling key and the Users roster to already-populated sheets,
  // without duplicating or overwriting anything an operator has edited.
  upsertByKeyColumn_(ss.getSheetByName('Config'), SEED_CONFIG, 0);   // match on column 0 = key
  upsertByKeyColumn_(ss.getSheetByName('Users'), SEED_USERS, 0);     // match on column 0 = name
  // PR 2: retired roster members (סנדרה / ceo) are set active=FALSE if their row exists — NEVER deleted,
  // so AuditLog / historic rows keep resolving the name. A re-run is idempotent (already FALSE → no write).
  deactivateUsers_(ss.getSheetByName('Users'), RETIRED_USERS);

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

// Roster members retired from the app (PR 2: the ceo role is gone). setupSheet() flips an existing row to
// active=FALSE and never seeds it again; the row itself stays (append-only data, historic references).
var RETIRED_USERS = ['סנדרה'];

/** Set active=FALSE on every Users row whose name is in `names`. Never deletes; idempotent. */
function deactivateUsers_(sheet, names) {
  if (!sheet || !names || names.length === 0) return;
  if (sheet.getLastRow() < 2) return;
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var nameCol = headers.indexOf('name');
  var activeCol = headers.indexOf('active');
  if (nameCol === -1 || activeCol === -1) return;
  for (var r = 1; r < data.length; r++) {
    var name = String(data[r][nameCol] == null ? '' : data[r][nameCol]).replace(/^\s+|\s+$/g, '');
    if (names.indexOf(name) === -1) continue;
    var cur = String(data[r][activeCol]).toUpperCase();
    if (cur === 'FALSE') continue; // already retired — no write
    sheet.getRange(r + 1, activeCol + 1).setValue('FALSE');
    Logger.log('Users: "' + name + '" set active=FALSE (retired role)');
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

// ===== Per-user password helper — RETIRED (PR 2) =====
//
// Login is ONE password (Railway SHARED_ACCESS_CODE, PR 1) and approvals use the APPROVER_CODE; nothing reads
// Users.pin_hash any more. The column stays (headers are append-only) but is never written. setUserPin()
// is kept only so an old editor bookmark fails loudly instead of silently writing a hash nobody uses.
function setUserPin(name, plaintext) {
  throw new Error('setUserPin is retired: login uses the single SHARED_ACCESS_CODE and approvals the ' +
    'APPROVER_CODE (Railway env + Script Property). Users.pin_hash is a legacy column and is no longer written.');
}
