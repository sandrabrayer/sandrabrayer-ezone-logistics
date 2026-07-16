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

  // One row PER ITEM per submitted count. count_id groups one submission (house × month × lead);
  // re-submitting the same house+month appends a new count_id — the LATEST counted_at wins on display.
  InventoryCounts: [
    'count_id', 'house', 'month',            // month = YYYY-MM
    'counted_by', 'counted_at',
    'category', 'item', 'quantity', 'notes',
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

// Internal leads Roy can refer a task to on the "הפניה לביצוע" tab (per-task dropdown).
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
export const INVENTORY_CATEGORIES = ['טואלטיקה', 'חומרי ניקוי', 'מזון'];

// Who may submit a monthly count: the house maintenance leads (+ רועי as backstop).
export const INVENTORY_COUNTERS = ['רמי', 'צחי', 'רועי'];

// Seed catalog — editable in the Sheet (active=FALSE hides, new rows extend; no code change needed).
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
  // מזון
  { category: 'מזון', item_text: 'אורז', active: 'TRUE' },
  { category: 'מזון', item_text: 'פסטה', active: 'TRUE' },
  { category: 'מזון', item_text: 'קמח', active: 'TRUE' },
  { category: 'מזון', item_text: 'סוכר', active: 'TRUE' },
  { category: 'מזון', item_text: 'מלח', active: 'TRUE' },
  { category: 'מזון', item_text: 'שמן', active: 'TRUE' },
  { category: 'מזון', item_text: 'קפה', active: 'TRUE' },
  { category: 'מזון', item_text: 'תה', active: 'TRUE' },
  { category: 'מזון', item_text: 'שימורים', active: 'TRUE' },
  { category: 'מזון', item_text: 'דגני בוקר', active: 'TRUE' },
];
