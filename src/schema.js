// schema.js — single source of truth for the Google Sheet structure and seed data.
// Shared by apps-script/setup.gs (to provision the Sheet) and test/ (to verify it).
// Keep this file the ONE place sheet structure is defined so the two can't drift apart.

// ---- Column headers, per sheet (order = column order in the Sheet) ----

export const HEADERS = {
  // Core lifecycle table. One row per request. §8 of the spec.
  Requests: [
    'id',
    'created_at',
    'created_by',
    'house',
    'category',            // רכישה / תיקון / החלפה
    'description',
    'location_in_house',
    'urgency',             // רגיל / דחוף / חירום
    'estimated_cost',      // NIS; may be blank/unknown
    'attachment_url',
    'status',              // see STATUSES
    'approval_required',   // derived: cost > threshold AND urgency != emergency
    'approved_by',
    'approved_at',
    'rejection_reason',
    'deferred_until',
    'assigned_to',         // Rami / Tzachi / external technician
    'assignment_type',     // internal / external
    'trade',               // external work: חשמלאי / אינסטלטור / מזגנים / ... (drives batching)
    'batch_id',            // links requests grouped into one external visit
    'completed_at',
    'actual_cost',
    'completion_notes',
    'execution_status',    // סטטוס ביצוע: '' / בוצע / לא בוצע / אחר. בוצע also completes the request.
    // ---- SLA + aging (increment 36) — APPENDED at the end (never reorder the earlier columns) ----
    'due_at',              // ISO; derived from urgency at creation via Config sla_days. Blank = no SLA.
    'blocked',             // 'TRUE'/'FALSE'; a manual flag (field_ops/ops_manager/ceo). Still ages.
    'blocked_reason',      // required free text when blocked
    'blocked_at',          // ISO when the block was set
    // ---- Preventive maintenance (תחזוקה מונעת) — APPENDED at the end (never reorder earlier columns) ----
    'plan_id',             // MaintenancePlan.id that generated this request; blank for normal requests.
    // ---- Compliance (עמידה באמות מידה) — APPENDED at the end (never reorder earlier columns) ----
    'compliance_id',       // Compliance.id that generated this renewal request; blank for normal requests.
  ],

  // Self-owned house list (NOT fed from Dashboard). §4.
  Houses: ['name', 'technician', 'cluster', 'status'],

  // Key/value rules so logic changes without code edits. §6, §8.
  Config: ['key', 'value'],

  // People + their role/scope (increment 30). Identity + role drive approval chain B and the
  // server-side role enforcement. `house` = own house (coordinator), cluster(s) (maintenance), or
  // blank = all houses (field_ops / ops_manager / ceo). `active` gates login.
  //
  // Increment 31: `pin_hash` APPENDED at the end (never reorder existing columns). A salted PBKDF2
  // hash for tier-A managers (רועי, אולגה) — set via the setUserPin() Apps Script helper, NEVER a
  // plaintext. Blank for tier-B users (they log in with the shared APP_PIN) and for סנדרה (ceo, no
  // login).
  Users: ['name', 'role', 'house', 'active', 'pin_hash'],

  // Internal maintenance leads + reusable external suppliers. §8.
  Technicians: ['name', 'type', 'cluster', 'trade', 'phone', 'rate', 'notes'],

  // Every status transition, for full traceability. §8, §9.
  AuditLog: ['request_id', 'from_status', 'to_status', 'by', 'timestamp', 'note'],

  // ---- Inspections module (§13, increment 4) ----
  // One row per inspection visit (Olga's בקרה).
  Inspections: [
    'id', 'house', 'inspection_date', 'inspector', 'started_at',
    'patient_count', 'staff_present', 'start_time', 'cleaner_present',
    'domain_treatment_summary', 'domain_cleanliness_summary', 'domain_kitchen_summary',
    'general_notes', 'reinspect_date', 'status',   // reinspect_date = follow-up בקרה חוזרת
  ],

  // One row per finding within an inspection.
  InspectionFindings: [
    'id', 'inspection_id', 'domain',           // treatment / cleanliness / kitchen
    'location_in_house', 'finding_text',
    'finding_type',                            // process_note / physical_defect
    'severity',                                // low / medium / high
    'suggested_category',                      // תיקון / החלפה (for defects)
    'linked_request_id', 'confirmed_by', 'confirmed_at',
  ],

  // The fixed core checklist Olga fills per visit. Ad-hoc additions are stored as findings.
  ChecklistItems: ['domain', 'item_text', 'active'],

  // ---- Inventory module (increment 25) ----
  // Catalog of countable items, editable in the Sheet (set active=FALSE to hide, add rows to extend).
  //
  // Increment 33: units + par are APPENDED (never reorder/remove the first three — positional read
  // of existing rows must keep working; rows that predate these columns read as unitless, no par).
  //   base_unit     one of kg | g | l | ml | unit — the closed set ezone-kitchen uses.
  //   allowed_units pipe-separated "label:factor" pairs; factor = base units per ONE of that label.
  //                 First entry is the default selection. Edited in the SHEET — no deploy to change.
  //   par_base      weekly par in base_unit (a flat per-house par). Blank = no par → never a shortage.
  InventoryItems: ['category', 'item_text', 'active', 'base_unit', 'allowed_units', 'par_base'],

  // One row PER ITEM per submitted count. count_id groups one submission (house × week × counter);
  // re-submitting the same house+week appends a new count_id — the LATEST counted_at wins on display.
  //
  // Increment 26: counts moved from MONTHLY to WEEKLY. `week_start` (YYYY-MM-DD, the Sunday that
  // begins the Israeli week) is APPENDED AT THE END — never reorder or remove the original columns.
  // `month` stays populated (derived from week_start on new rows; kept as-is on historical rows) so
  // nothing downstream that still reads it breaks.
  //
  // Increment 33: unit_label / unit_factor / quantity_base are APPENDED after week_start (never
  // reorder the earlier columns). `quantity` keeps its exact meaning — what the counter typed.
  // `quantity_base` = quantity × unit_factor, expressed in the item's base_unit; it is what par
  // comparison and all aggregation read. The factor is FROZEN at count time — never re-derive it
  // later from unit_label, because labels/factors are edited in the InventoryItems sheet.
  InventoryCounts: [
    'count_id', 'house', 'month',            // month = YYYY-MM (historical + derived from week_start)
    'counted_by', 'counted_at',
    'category', 'item', 'quantity', 'notes',
    'week_start',                            // YYYY-MM-DD, Sunday (Israeli week) — appended inc. 26
    'unit_label', 'unit_factor', 'quantity_base', // appended inc. 33 (unit chosen + frozen factor + base qty)
  ],

  // Budgets (budget module) — one row per house per month. Olga fills rows directly in the Sheet;
  // there is no budget-entry UI. `house` is a CANONICAL id (HOUSE-IDS.md), `period` is YYYY-MM,
  // `amount` is NIS. Created empty + idempotently by setupSheet(); columns are append-only.
  // NOTE: budget/actual figures are financial and MUST NEVER be written into any digest tab.
  Budgets: ['house', 'period', 'amount', 'notes'],

  // Preventive-maintenance plan (תחזוקה מונעת) — one row per recurring task. Olga fills rows directly
  // in the Sheet; there is no plan-entry UI. Created empty + idempotently by setupSheet(); columns are
  // append-only. `house` is a CANONICAL id (HOUSE-IDS.md) OR the literal 'all' (every open house).
  // `frequency_months` is a positive integer. `last_done` is a date (YYYY-MM-DD; blank = never done →
  // due immediately). `active` is 'TRUE'/'FALSE'. next_due / overdue are DERIVED, never stored.
  // The only cell the system writes back is `last_done`, when a generated request reaches הושלם.
  MaintenancePlan: ['id', 'house', 'task', 'frequency_months', 'last_done', 'active', 'notes'],

  // Compliance tracker (עמידה באמות מידה) — one row per certificate/license/inspection with an expiry.
  // Olga fills rows directly in the Sheet (no entry UI this increment). Created empty + idempotently by
  // setupSheet(); columns are append-only. `house` is a CANONICAL id (HOUSE-IDS.md) OR the literal 'all'
  // (every OPEN house). `item` is the Hebrew name (e.g. רישיון עסק). `expires_at` is a date (YYYY-MM-DD).
  // `reminder_days` is a number of days before expiry to start warning; BLANK = the Config default
  // (compliance_reminder_days). `doc_url` links the scanned certificate (optional). `active` is
  // 'TRUE'/'FALSE'. days_to_expiry / status are DERIVED, never stored. NOTHING is written back on
  // completion — the new expiry lives on the new certificate, so Olga updates expires_at by hand.
  Compliance: ['id', 'house', 'item', 'expires_at', 'reminder_days', 'doc_url', 'notes', 'active'],

  // Exceptional-events register (אירועים חריגים) — one row per reported event. Unlike the fill-in-Sheet
  // modules, events are reported from the FIELD via the /events entry UI. Created empty + idempotently by
  // setupSheet(); columns are append-only. `created_by` is the SESSION identity (never client-supplied).
  // `house` is a CANONICAL id (HOUSE-IDS.md). `occurred_at` is a date. `event_type` is from the
  // Config-driven `event_types` list; `severity` is נמוך/בינוני/גבוה; `status` is פתוח/בטיפול/נסגר.
  // `corrective_request_id` optionally links an existing Request (no auto-creation). root_cause / lessons
  // are filled on follow-up; closing (status נסגר) REQUIRES both. Operational fields ONLY — never any
  // clinical/medical record content. Recurrence / trend are DERIVED for /management, never stored.
  Events: [
    'id', 'created_at', 'created_by', 'house', 'occurred_at', 'event_type', 'severity',
    'description', 'immediate_action', 'root_cause', 'lessons', 'corrective_request_id',
    'status', 'closed_at', 'notes',
  ],
};

export const SHEET_NAMES = Object.keys(HEADERS);

// ---- Controlled vocabularies (Hebrew display values are the stored values) ----

export const STATUSES = {
  REQUEST: 'דרישה',
  PENDING_APPROVAL: 'ממתין לאישור',
  APPROVED: 'מאושר',
  NOT_APPROVED: 'לא מאושר',
  DEFERRED: 'נדחה לתאריך',
  IN_PROGRESS: 'בביצוע',
  COMPLETED: 'הושלם',
  CLOSED: 'סגור',
};

export const URGENCY = {
  NORMAL: 'רגיל',
  URGENT: 'דחוף',
  EMERGENCY: 'חירום',
};

export const CATEGORY = {
  PURCHASE: 'רכישה',
  REPAIR: 'תיקון',
  REPLACEMENT: 'החלפה',
};

// Execution status set on the /workorders "סטטוס ביצוע" tab. A task stays LIVE (in the worklist)
// until it is marked בוצע — לא בוצע and אחר keep it live. בוצע also moves the request to הושלם.
export const EXECUTION_STATUS = {
  NONE: '',
  DONE: 'בוצע',
  NOT_DONE: 'לא בוצע',
  OTHER: 'אחר',
};
// The three pickable values (NONE is the unset default, not offered as a button).
export const EXECUTION_STATUS_CHOICES = [
  EXECUTION_STATUS.DONE, EXECUTION_STATUS.NOT_DONE, EXECUTION_STATUS.OTHER,
];

// Internal leads Roy can refer a task to on the "העברה לביצוע" tab (per-task dropdown).
// רועי included so Roy can take a task himself; external work stays on the בעלי מקצוע tab.
export const ASSIGNABLE_LEADS = ['רמי', 'צחי', 'רועי'];

export const CLUSTERS = { SHARON: 'sharon', CAESAREA: 'caesarea', NORTH: 'north' };
export const HOUSE_STATUS = { OPEN: 'open', PRE_OPENING: 'pre-opening' };

// External-work trades. Assignment to an external technician picks ONE trade; smart batching
// groups open external requests by trade × cluster (same trade, same proximity cluster → one visit).
export const TRADES = [
  'חשמלאי',
  'אינסטלטור',
  'איש מזגנים',
  'צבעי',
  'איש בריכות',
  'איש רשתות',
  'עבודות אלומיניום',
  'עבודות נגרות',
  'אחר',
];

// ---- Seed data ----

// Six houses. Note the locked distinction: `technician` (internal assignment) is NOT the
// same axis as `cluster` (external batching). Tzachi (צחי) covers BOTH caesarea and north,
// but they are separate clusters so a far-north visit is never auto-batched with the
// coastal two. A test asserts exactly this.
// Display names are the CANONICAL forms from HOUSE-IDS.md (increment 33) — the single source for how
// a house is shown. They must match that file exactly (city first: "קיסריה עפרוני", not "עפרוני קיסריה").
export const SEED_HOUSES = [
  { name: 'רעננה אשר',      technician: 'רמי', cluster: CLUSTERS.SHARON,   status: HOUSE_STATUS.OPEN },
  { name: 'רמות השבים',     technician: 'רמי', cluster: CLUSTERS.SHARON,   status: HOUSE_STATUS.OPEN },
  { name: 'רעננה הפרדס',    technician: 'רמי', cluster: CLUSTERS.SHARON,   status: HOUSE_STATUS.PRE_OPENING },
  { name: 'קיסריה עפרוני',  technician: 'צחי', cluster: CLUSTERS.CAESAREA, status: HOUSE_STATUS.OPEN },
  { name: 'קיסריה ריהאב',   technician: 'צחי', cluster: CLUSTERS.CAESAREA, status: HOUSE_STATUS.OPEN },
  { name: 'שדה אליעזר',     technician: 'צחי', cluster: CLUSTERS.NORTH,    status: HOUSE_STATUS.PRE_OPENING },
];

// Internal maintenance leads. Displayed in UI as "אחראי תחזוקה", not "technician".
// External suppliers get added later (type: 'external'); none seeded yet.
export const SEED_TECHNICIANS = [
  { name: 'רמי', type: 'internal', cluster: CLUSTERS.SHARON,   trade: 'general', phone: '', rate: '', notes: 'אחראי תחזוקה – שרון' },
  { name: 'צחי', type: 'internal', cluster: CLUSTERS.CAESAREA, trade: 'general', phone: '', rate: '', notes: 'אחראי תחזוקה – קיסריה וצפון' },
];

// Config defaults. Stored as strings in the Sheet (Apps Script reads cells as strings);
// getConfig coerces known keys back to number/boolean — see src/config.js.
export const SEED_CONFIG = [
  { key: 'approval_threshold', value: '3000' },
  { key: 'emergency_bypasses_approval', value: 'TRUE' },
  // ceo_ceiling — kept but DORMANT since increment 31 (chain B v2 routes by amount only and does
  // not read it). Seeded blank; retained so the key/plumbing survive if ceo routing returns.
  { key: 'ceo_ceiling', value: '' },
  // sla_days (increment 36) — a parseable "urgency:days" spec (like allowed_units), tunable in the
  // Sheet with NO deploy. due_at = created_at + days-for-urgency. A malformed spec → no due date
  // (logged), never a silently wrong default.
  { key: 'sla_days', value: 'חירום:1|דחוף:3|רגיל:14' },
  // Foreign digest spreadsheet ids the /management screen reads READ-ONLY (never written). Ids live
  // in Config so they are never hardcoded in code; a BLANK value renders that panel "לא זמין".
  // kitchen_digest_id seeds the known ezone-kitchen digest (tab FoodShortages). coordinators_digest_id
  // is blank — no coordinators-PUBLISHED digest exists to read (this app only PUBLISHES one for them).
  { key: 'kitchen_digest_id', value: '1sJ62lUfgyaes_Ippv1CH3acLmExju3aZXAfk12g0zfE' },
  { key: 'coordinators_digest_id', value: '' },
  // compliance_reminder_days (compliance tracker) — how many days before a certificate/license expiry
  // to start warning + generating a renewal request, when a Compliance row leaves reminder_days blank.
  // Read like sla_days (tunable in the Sheet, no deploy). A malformed value is logged and falls back to
  // this seeded default (30) — never a silent number beyond the seed.
  { key: 'compliance_reminder_days', value: '30' },
  // event_types (exceptional-events register) — a pipe-separated list of the allowed event categories,
  // tunable in the Sheet with NO deploy. A malformed/blank spec is logged and the entry form falls back
  // to אחר only — never a silently wrong category set.
  { key: 'event_types', value: 'בטיחות|תרופות|התנהגות|תשתיות|תברואה|אחר' },
];

// ---- Roles + user seed (increment 30) ----

// The five roles the app knows. Mirror of src/roles.js ROLE values.
export const USER_ROLES = ['coordinator', 'maintenance', 'field_ops', 'ops_manager', 'ceo'];

// Seed roster (active = TRUE). `house`: blank = all houses; a cluster name (or comma-separated
// clusters) for maintenance leads; a specific house for coordinators. `pin_hash` seeds BLANK for
// everyone — tier-A managers' hashes are set later via setUserPin() (never seeded as plaintext).
// setupSheet() upserts by `name` — re-running never duplicates a row and never overwrites an
// edited one (so a manager's set pin_hash survives a re-run).
export const SEED_USERS = [
  { name: 'רועי',  role: 'field_ops',   house: '',                 active: 'TRUE', pin_hash: '' }, // tier A (personal password)
  { name: 'אולגה', role: 'ops_manager', house: '',                 active: 'TRUE', pin_hash: '' }, // tier A (personal password)
  { name: 'סנדרה', role: 'ceo',         house: '',                 active: 'TRUE', pin_hash: '' }, // no password → cannot log in
  { name: 'רמי',   role: 'maintenance', house: 'sharon',           active: 'TRUE', pin_hash: '' }, // tier B, cluster: sharon
  { name: 'צחי',   role: 'maintenance', house: 'caesarea,north',   active: 'TRUE', pin_hash: '' }, // tier B, clusters: caesarea + north
  { name: 'שירה',  role: 'coordinator', house: 'קיסריה עפרוני',     active: 'TRUE', pin_hash: '' }, // tier B
  { name: 'יעקב',  role: 'coordinator', house: 'קיסריה ריהאב',      active: 'TRUE', pin_hash: '' }, // tier B
  { name: 'אורן',  role: 'coordinator', house: 'רעננה אשר',         active: 'TRUE', pin_hash: '' }, // tier B
  { name: 'אביב',  role: 'coordinator', house: 'רמות השבים',        active: 'TRUE', pin_hash: '' }, // tier B
];

// ---- Inspection vocabularies + seed (§13) ----

export const INSPECTION_DOMAINS = {
  TREATMENT: 'treatment',     // תחום הטיפול
  CLEANLINESS: 'cleanliness', // ניקיון ואחזקה
  KITCHEN: 'kitchen',         // מטבחים ומחסנים
};

export const FINDING_TYPE = {
  PROCESS_NOTE: 'process_note',     // stays a note (not a request)
  PHYSICAL_DEFECT: 'physical_defect', // can become a repair/replacement request
};

export const SEVERITY = { LOW: 'low', MEDIUM: 'medium', HIGH: 'high' };

export const INSPECTION_STATUS = { IN_PROGRESS: 'in-progress', SUBMITTED: 'submitted' };

// Who may view/run inspections (§13). Controlled list, like the submitter picker.
export const INSPECTION_USERS = ['רועי', 'אולגה', 'אורן', 'sandra'];

// Fixed core checklist, drafted from Olga's real report (recurring items per domain).
// Olga confirms/adjusts; ad-hoc items are recorded as findings, not added here.
export const SEED_CHECKLIST_ITEMS = [
  // תחום הטיפול
  { domain: 'treatment', item_text: 'תיקים ממוחשבים מסודרים ומעודכנים', active: 'TRUE' },
  { domain: 'treatment', item_text: 'אינטייקים סרוקים ומצורפים', active: 'TRUE' },
  { domain: 'treatment', item_text: 'כל המטופלים רשומים במערכת', active: 'TRUE' },
  { domain: 'treatment', item_text: 'סטנדרטים טיפוליים נשמרים', active: 'TRUE' },
  // ניקיון ואחזקה
  { domain: 'cleanliness', item_text: 'נראות כללית וניקיון שטחים ציבוריים', active: 'TRUE' },
  { domain: 'cleanliness', item_text: 'ברזים, מקלחונים ומראות נקיים מאבנית', active: 'TRUE' },
  { domain: 'cleanliness', item_text: 'חדרי שינה נקיים ומאווררים', active: 'TRUE' },
  { domain: 'cleanliness', item_text: 'מסילות חלונות, מעקות ודלתות נקיים', active: 'TRUE' },
  { domain: 'cleanliness', item_text: 'חדר כביסה נקי ונעול', active: 'TRUE' },
  { domain: 'cleanliness', item_text: 'תאורה תקינה בכל החדרים', active: 'TRUE' },
  { domain: 'cleanliness', item_text: 'חצר/בריכה נקיים ובטיחותיים', active: 'TRUE' },
  { domain: 'cleanliness', item_text: 'פערי תחזוקה (צבע, פאנלים, מזגנים)', active: 'TRUE' },
  // מטבחים ומחסנים
  { domain: 'kitchen', item_text: 'ניקיון מטבח וציוד מטבח', active: 'TRUE' },
  { domain: 'kitchen', item_text: 'מוצרי חשמל תקינים ובמקומם', active: 'TRUE' },
  { domain: 'kitchen', item_text: 'אחסון מזון תקין ובטיחותי', active: 'TRUE' },
  { domain: 'kitchen', item_text: 'בדיקת מחסן ומלאים', active: 'TRUE' },
];

// ---- Inventory vocabularies + seed (increment 25) ----

// Hebrew display values ARE the stored values (same convention as statuses).
//
// Increment 26: מזון (food) is dropped — ezone-kitchen is the system of record for food (per-house
// stock with units/min/par, budgets, purchases, menus, occupancy-driven consumption). Logistics
// owns ONLY the categories no other app owns: טואלטיקה and חומרי ניקוי. The seeded מזון catalog
// rows are kept but flagged active=FALSE (see SEED_INVENTORY_ITEMS) so increment-25 history renders.
export const INVENTORY_CATEGORIES = ['טואלטיקה', 'חומרי ניקוי'];

// Who may submit a weekly count (increment 26): the house COORDINATORS, not the maintenance
// leads. Each open/pre-opening house has a coordinator; רועי is the cross-house backstop and
// רמי/צחי stay accepted as a maintenance-lead backstop (צחי is also קיסריה/צפון's coordinator).
export const INVENTORY_COUNTERS = ['שירה', 'יעקב', 'אורן', 'אביב', 'צחי', 'רועי', 'רמי'];

// House → its coordinator (the default "נספר ע״י" in the weekly count UI). Coordinators are the
// people who actually walk each house: שירה (קיסריה עפרוני) · יעקב (קיסריה ריהאב) · אורן (רעננה אשר) ·
// אביב (רמות השבים) · צחי (שדה אליעזר). רועי covers anything unmapped (backstop, incl. רעננה הפרדס).
// Keys are the CANONICAL house display names (HOUSE-IDS.md) — kept in sync with SEED_HOUSES.
export const INVENTORY_HOUSE_COORDINATORS = {
  'קיסריה עפרוני': 'שירה',
  'קיסריה ריהאב': 'יעקב',
  'רעננה אשר': 'אורן',
  'רמות השבים': 'אביב',
  'שדה אליעזר': 'צחי',
};

// The closed set of base units (increment 33) — SHARED with ezone-kitchen. An item whose base_unit
// is outside this set is treated as unitless (and logged), never coerced to a guessed default.
export const BASE_UNITS = ['kg', 'g', 'l', 'ml', 'unit'];

// Seed catalog — editable in the Sheet (active=FALSE hides, new rows extend; no code change needed).
// base_unit / allowed_units / par_base are STARTING POINTS: labels, options and par are all edited in
// the InventoryItems sheet afterward with NO deploy. par_base is a flat weekly par per house.
//
// The מזון rows are seeded active=FALSE (increment 26): food moved to ezone-kitchen, but the rows
// stay so increment-25 historical counts that reference these item names still resolve. They are
// hidden from the count form (groupCatalog skips inactive rows AND non-INVENTORY_CATEGORIES rows).
// Retired rows carry no units — they are never counted, so par/units are left blank.
//
// Increment 33 SPLIT: the former 'אבקת/ג׳ל כביסה' is retired (active=FALSE) and replaced by two
// separate items — powder (kg) and gel (l) — because one item cannot carry two base units. No count
// rows existed for it, so there is nothing to migrate.
export const SEED_INVENTORY_ITEMS = [
  // טואלטיקה
  { category: 'טואלטיקה', item_text: 'נייר טואלט', active: 'TRUE', base_unit: 'unit', allowed_units: 'גליל:1|חבילה 8:8|חבילה 24:24', par_base: 48 },
  { category: 'טואלטיקה', item_text: 'מגבות נייר', active: 'TRUE', base_unit: 'unit', allowed_units: 'גליל:1|חבילה 4:4', par_base: 24 },
  { category: 'טואלטיקה', item_text: 'טישו', active: 'TRUE', base_unit: 'unit', allowed_units: 'קופסה:1|חבילה 6:6', par_base: 12 },
  { category: 'טואלטיקה', item_text: 'סבון ידיים', active: 'TRUE', base_unit: 'ml', allowed_units: 'בקבוק 500מל:500|ליטר:1000|גלון 4ל:4000', par_base: 5000 },
  { category: 'טואלטיקה', item_text: 'שמפו', active: 'TRUE', base_unit: 'ml', allowed_units: 'בקבוק 750מל:750|ליטר:1000|גלון 4ל:4000', par_base: 5000 },
  { category: 'טואלטיקה', item_text: 'סבון רחצה', active: 'TRUE', base_unit: 'unit', allowed_units: "יח':1|חבילה 6:6", par_base: 20 },
  { category: 'טואלטיקה', item_text: 'משחת שיניים', active: 'TRUE', base_unit: 'unit', allowed_units: "יח':1", par_base: 10 },
  { category: 'טואלטיקה', item_text: 'מברשות שיניים', active: 'TRUE', base_unit: 'unit', allowed_units: "יח':1|חבילה 4:4", par_base: 10 },
  // חומרי ניקוי
  { category: 'חומרי ניקוי', item_text: 'אקונומיקה', active: 'TRUE', base_unit: 'l', allowed_units: 'בקבוק 1ל:1|בקבוק 2ל:2|בקבוק 4ל:4', par_base: 10 },
  { category: 'חומרי ניקוי', item_text: 'נוזל רצפות', active: 'TRUE', base_unit: 'l', allowed_units: 'בקבוק 1ל:1|בקבוק 2ל:2|גלון 4ל:4', par_base: 10 },
  { category: 'חומרי ניקוי', item_text: 'נוזל כלים', active: 'TRUE', base_unit: 'l', allowed_units: 'בקבוק 750מל:0.75|בקבוק 1ל:1|גלון 4ל:4', par_base: 6 },
  { category: 'חומרי ניקוי', item_text: 'ספוגים', active: 'TRUE', base_unit: 'unit', allowed_units: "יח':1|חבילה 10:10", par_base: 20 },
  { category: 'חומרי ניקוי', item_text: 'מטליות', active: 'TRUE', base_unit: 'unit', allowed_units: "יח':1|חבילה 10:10", par_base: 20 },
  { category: 'חומרי ניקוי', item_text: 'שקיות אשפה', active: 'TRUE', base_unit: 'unit', allowed_units: "גליל 20:20|גליל 50:50|יח':1", par_base: 200 },
  { category: 'חומרי ניקוי', item_text: 'תרסיס חיטוי', active: 'TRUE', base_unit: 'unit', allowed_units: 'בקבוק:1|חבילה 3:3', par_base: 6 },
  // increment 33 SPLIT: 'אבקת/ג׳ל כביסה' retired → אבקת כביסה (kg) + ג׳ל כביסה (l).
  { category: 'חומרי ניקוי', item_text: 'אבקת/ג׳ל כביסה', active: 'FALSE' },
  { category: 'חומרי ניקוי', item_text: 'אבקת כביסה', active: 'TRUE', base_unit: 'kg', allowed_units: 'שקית 5 ק"ג:5|שקית 10 ק"ג:10', par_base: 10 },
  { category: 'חומרי ניקוי', item_text: 'ג׳ל כביסה', active: 'TRUE', base_unit: 'l', allowed_units: 'בקבוק 3ל:3|בקבוק 5ל:5', par_base: 5 },
  { category: 'חומרי ניקוי', item_text: 'מרכך כביסה', active: 'TRUE', base_unit: 'l', allowed_units: 'בקבוק 1ל:1|בקבוק 2ל:2|בקבוק 4ל:4', par_base: 5 },
  // מזון — RETIRED in increment 26 (food is owned by ezone-kitchen). Kept as active=FALSE so
  // historical increment-25 counts referencing these names still resolve; hidden from the form.
  { category: 'מזון', item_text: 'אורז', active: 'FALSE' },
  { category: 'מזון', item_text: 'פסטה', active: 'FALSE' },
  { category: 'מזון', item_text: 'קמח', active: 'FALSE' },
  { category: 'מזון', item_text: 'סוכר', active: 'FALSE' },
  { category: 'מזון', item_text: 'מלח', active: 'FALSE' },
  { category: 'מזון', item_text: 'שמן', active: 'FALSE' },
  { category: 'מזון', item_text: 'קפה', active: 'FALSE' },
  { category: 'מזון', item_text: 'תה', active: 'FALSE' },
  { category: 'מזון', item_text: 'שימורים', active: 'FALSE' },
  { category: 'מזון', item_text: 'דגני בוקר', active: 'FALSE' },
];
