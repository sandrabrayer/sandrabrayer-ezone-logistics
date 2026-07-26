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
    'batch_id',            // links requests grouped into one external visit
    'completed_at',
    'actual_cost',
    'completion_notes',
  ],

  // Self-owned house list (NOT fed from Dashboard). §4.
  Houses: ['name', 'technician', 'cluster', 'status'],

  // Key/value rules so logic changes without code edits. §6, §8.
  Config: ['key', 'value'],

  // Internal maintenance leads + reusable external suppliers. §8.
  Technicians: ['name', 'type', 'cluster', 'trade', 'phone', 'rate', 'notes'],

  // Every status transition, for full traceability. §8, §9.
  AuditLog: ['request_id', 'from_status', 'to_status', 'by', 'timestamp', 'note'],

  // People + roles that drive the approval chain and server-side role enforcement (increment 28).
  // `house` scopes a user: '*' = all houses, 'cluster:<a>+<b>' = one or more maintenance clusters,
  // or a literal house name (coordinators, own house only). `active` FALSE fails closed.
  Users: ['name', 'role', 'house', 'active'],
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

export const CLUSTERS = { SHARON: 'sharon', CAESAREA: 'caesarea', NORTH: 'north' };
export const HOUSE_STATUS = { OPEN: 'open', PRE_OPENING: 'pre-opening' }; // pre-opening = טרום-פתיחה

// Roles that drive the approval chain (§6, increment 28). Slugs are the stored values.
export const ROLES = {
  COORDINATOR: 'coordinator',  // רכז/ת בית — own house only
  MAINTENANCE: 'maintenance',  // אחראי/ת תחזוקה — cluster-scoped
  FIELD_OPS: 'field_ops',      // מנהל/ת שטח (רועי) — base approver
  OPS_MANAGER: 'ops_manager',  // מנהל/ת תפעול (אולגה) — above threshold
  CEO: 'ceo',                  // מנכ"לית (סנדרה) — pre-opening / ceiling / can approve anything
};

// House-scope encoding used in the Users sheet `house` column and by src/roles.js.
export const ALL_HOUSES_MARK = '*';       // covers every house
export const CLUSTER_SCOPE_PREFIX = 'cluster:'; // 'cluster:caesarea+north' → those clusters

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
// ceo_ceiling is intentionally NOT a numeric key: blank ('') means "disabled". Coercing ''
// to a number would make it 0 and route every request to the CEO — so it stays a passthrough
// string and the approval chain only reads it when non-blank (see src/approval.js).
export const SEED_CONFIG = [
  { key: 'approval_threshold', value: '3000' },
  { key: 'emergency_bypasses_approval', value: 'TRUE' },
  { key: 'ceo_ceiling', value: '' }, // blank = disabled; set a number to force CEO above it
];

// Users seed (increment 28). active TRUE for all. `house` uses the encoding above.
export const SEED_USERS = [
  { name: 'רועי',  role: ROLES.FIELD_OPS,   house: ALL_HOUSES_MARK,               active: true },
  { name: 'אולגה', role: ROLES.OPS_MANAGER, house: ALL_HOUSES_MARK,               active: true },
  { name: 'סנדרה', role: ROLES.CEO,         house: ALL_HOUSES_MARK,               active: true },
  { name: 'רמי',   role: ROLES.MAINTENANCE, house: 'cluster:sharon',              active: true },
  { name: 'צחי',   role: ROLES.MAINTENANCE, house: 'cluster:caesarea+north',      active: true },
  { name: 'שירה',  role: ROLES.COORDINATOR, house: 'קיסריה עפרוני',               active: true },
  { name: 'יעקב',  role: ROLES.COORDINATOR, house: 'ריהאב',                       active: true },
  { name: 'אורן',  role: ROLES.COORDINATOR, house: 'רעננה',                       active: true },
  { name: 'אביב',  role: ROLES.COORDINATOR, house: 'רמות השבים',                  active: true },
];
