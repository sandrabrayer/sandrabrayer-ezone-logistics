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
  InventoryItems: ['category', 'item_text', 'active'],

  // One row PER ITEM per submitted count. count_id groups one submission (house × week × counter);
  // re-submitting the same house+week appends a new count_id — the LATEST counted_at wins on display.
  //
  // Increment 26: counts moved from MONTHLY to WEEKLY. `week_start` (YYYY-MM-DD, the Sunday that
  // begins the Israeli week) is APPENDED AT THE END — never reorder or remove the original columns.
  // `month` stays populated (derived from week_start on new rows; kept as-is on historical rows) so
  // nothing downstream that still reads it breaks.
  InventoryCounts: [
    'count_id', 'house', 'month',            // month = YYYY-MM (historical + derived from week_start)
    'counted_by', 'counted_at',
    'category', 'item', 'quantity', 'notes',
    'week_start',                            // YYYY-MM-DD, Sunday (Israeli week) — appended inc. 26
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
export const SEED_HOUSES = [
  { name: 'רעננה',          technician: 'רמי', cluster: CLUSTERS.SHARON,   status: HOUSE_STATUS.OPEN },
  { name: 'רמות השבים',     technician: 'רמי', cluster: CLUSTERS.SHARON,   status: HOUSE_STATUS.OPEN },
  { name: 'הפרדס',          technician: 'רמי', cluster: CLUSTERS.SHARON,   status: HOUSE_STATUS.PRE_OPENING },
  { name: 'קיסריה עפרוני',  technician: 'צחי', cluster: CLUSTERS.CAESAREA, status: HOUSE_STATUS.OPEN },
  { name: 'ריהאב',          technician: 'צחי', cluster: CLUSTERS.CAESAREA, status: HOUSE_STATUS.OPEN },
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
  { name: 'יעקב',  role: 'coordinator', house: 'ריהאב',             active: 'TRUE', pin_hash: '' }, // tier B
  { name: 'אורן',  role: 'coordinator', house: 'רעננה',             active: 'TRUE', pin_hash: '' }, // tier B
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
// people who actually walk each house: שירה (קיסריה עפרוני) · יעקב (ריהאב) · אורן (רעננה) ·
// אביב (רמות השבים) · צחי (שדה אליעזר). רועי covers anything unmapped (backstop).
export const INVENTORY_HOUSE_COORDINATORS = {
  'קיסריה עפרוני': 'שירה',
  'ריהאב': 'יעקב',
  'רעננה': 'אורן',
  'רמות השבים': 'אביב',
  'שדה אליעזר': 'צחי',
};

// Seed catalog — editable in the Sheet (active=FALSE hides, new rows extend; no code change needed).
// The מזון rows are seeded active=FALSE (increment 26): food moved to ezone-kitchen, but the rows
// stay so increment-25 historical counts that reference these item names still resolve. They are
// hidden from the count form (groupCatalog skips inactive rows AND non-INVENTORY_CATEGORIES rows).
export const SEED_INVENTORY_ITEMS = [
  // טואלטיקה
  { category: 'טואלטיקה', item_text: 'נייר טואלט', active: 'TRUE' },
  { category: 'טואלטיקה', item_text: 'מגבות נייר', active: 'TRUE' },
  { category: 'טואלטיקה', item_text: 'טישו', active: 'TRUE' },
  { category: 'טואלטיקה', item_text: 'סבון ידיים', active: 'TRUE' },
  { category: 'טואלטיקה', item_text: 'שמפו', active: 'TRUE' },
  { category: 'טואלטיקה', item_text: 'סבון רחצה', active: 'TRUE' },
  { category: 'טואלטיקה', item_text: 'משחת שיניים', active: 'TRUE' },
  { category: 'טואלטיקה', item_text: 'מברשות שיניים', active: 'TRUE' },
  // חומרי ניקוי
  { category: 'חומרי ניקוי', item_text: 'אקונומיקה', active: 'TRUE' },
  { category: 'חומרי ניקוי', item_text: 'נוזל רצפות', active: 'TRUE' },
  { category: 'חומרי ניקוי', item_text: 'נוזל כלים', active: 'TRUE' },
  { category: 'חומרי ניקוי', item_text: 'ספוגים', active: 'TRUE' },
  { category: 'חומרי ניקוי', item_text: 'מטליות', active: 'TRUE' },
  { category: 'חומרי ניקוי', item_text: 'שקיות אשפה', active: 'TRUE' },
  { category: 'חומרי ניקוי', item_text: 'תרסיס חיטוי', active: 'TRUE' },
  { category: 'חומרי ניקוי', item_text: 'אבקת/ג׳ל כביסה', active: 'TRUE' },
  { category: 'חומרי ניקוי', item_text: 'מרכך כביסה', active: 'TRUE' },
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
