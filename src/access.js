// access.js — role-based page + data-action visibility (owner's required model, increment 38).
//
// Owner's model (post nav-cleanup — Logistics is becoming managers-only):
//   coordinator  → no nav tab (the standalone request form + /events were removed); '/' still serves so a
//                  session lands on the root. Data gates (createRequest own-house scope) are unchanged.
//   maintenance  → dashboard / workorders / inventory / inspection / reports (the tier-B pages it had; no /events).
//   field_ops    → those same pages (everything EXCEPT /management); no standalone request form or /events.
//   ops_manager  → everything, including /management.
//   ceo          → everything, including /management.
// Requests are now filed from the in-dashboard create modal, not a standalone דרישה חדשה page. אירועים
// חריגים (/events) is removed entirely (nav + page + routes). '/' (index.html) stays as the root/login landing.
//
// Two enforcement layers use this module:
//   1. SERVER-SIDE data gate (src/server.js): canRead() gates every doGet action by the session role;
//      canWriteAction() gates every doPost action. The write gate is MIRRORED into apps-script/Code.gs
//      (MIRROR:access) and enforced there too — so a direct /exec POST from a tier-B role is refused
//      even if it bypasses the Node proxy. (Reads: doGet on Apps Script is world-callable-by-URL and
//      carries no session identity, so the read gate lives at the session-aware Node proxy — see server.js.)
//   2. NAV shim (src/server.js injects NAV_BY_ROLE): renders only the links a role may open and redirects
//      away from a page the role may not open. Display only — never the security control.
//
// This does NOT weaken any existing gate: canManage (managementData / updateEvent), the coordinator
// own-house scope on createRequest/createEvent, canApprove/canDispatch/canBlock etc. all still run in the
// handlers. canWriteAction is an ADDITIONAL early gate that also CLOSES a gap — several write handlers
// (createInspection/addFinding/confirmFinding/submitInventory/editRequest) had no server-side role check
// and were protected UI-only; tier B is now refused them server-side.

import { isManagerRole, ROLE } from './roles.js';

// === MIRROR:access START ===
// The write-action gate, enforced server-side (Node) AND in apps-script/Code.gs (doPost). Self-contained
// (role string literals only) so the two copies stay identical. Manager-tier roles pass this early gate
// and are then subject to the PRECISE per-action gate inside each handler (canManage for managementData /
// updateEvent, chain-B canApprove, canDispatch, canBlock, isManagement_ for delete, …) — unchanged.
// Tier-B roles are limited to exactly what they can do today via the app: a coordinator may file a
// request and report an event; maintenance may file a request. Every other write is refused.
var ACCESS_WRITE_MANAGER_ROLES = ['field_ops', 'ops_manager', 'ceo'];

function canWriteAction(role, action) {
  if (ACCESS_WRITE_MANAGER_ROLES.indexOf(role) !== -1) return true; // handlers enforce the precise gate
  if (role === 'coordinator') return action === 'createRequest' || action === 'createEvent';
  if (role === 'maintenance') return action === 'createRequest' || action === 'updatePreventiveItem';
  return false;
}
// === MIRROR:access END ===

// ---- Read gate (Node-only: the Apps Script doGet has no session identity) ----
// houses/config are non-sensitive and needed by the request form + event form; requests is allowed for
// all roles but SCOPE-FILTERED for tier B in the proxy. Everything else (users + the manager-only reads:
// technicians, checklist, inspections, findings, inventoryItems, inventoryCounts, events) is manager-tier.
const READ_ALL_ROLES = new Set(['houses', 'config', 'requests']);
function canRead(role, action) {
  if (READ_ALL_ROLES.has(action)) return true;
  // The daily preventive checklist is read by the maintenance leads (their own houses, scope-filtered in the
  // proxy exactly like requests) AND by managers for the /management hub. openingChecklist / emergencyReadiness
  // / trainings stay manager-tier (field_ops = manager reads them for the /workorders entry tabs).
  if (action === 'preventiveDaily') return role === 'maintenance' || isManagerRole(role);
  return isManagerRole(role);
}

// ---- Pages / nav (Node-only: the shim renders these and redirects) ----
// The full ordered link set; each role gets a subset. Labels are the canonical Hebrew nav labels.
// NAV cleanup (Logistics → managers-only): the standalone דרישה חדשה tab ('/') is GONE from the nav —
// managers file requests from the in-dashboard create modal; '/' still serves the root/login landing.
// אירועים חריגים ('/events') is removed entirely (nav + page + routes), matching its removal from /management.
const NAV_ALL = [
  { href: '/dashboard', label: 'דשבורד' },
  { href: '/workorders', label: 'משימות' },
  { href: '/inventory', label: 'מלאי' },
  { href: '/inspection', label: 'בקרה' },
  { href: '/reports', label: 'דוחות' },
  { href: '/management', label: 'ניהול תפעולי רשת' },
];
const NAV_HREFS_BY_ROLE = {
  // coordinator no longer has a nav tab here (דרישה חדשה + אירועים חריגים removed). '/' still serves, so a
  // coordinator session lands on the root; retiring/re-homing the role is the separate architecture work.
  coordinator: [],
  maintenance: ['/dashboard', '/workorders', '/inventory', '/inspection', '/reports'],
  field_ops: ['/dashboard', '/workorders', '/inventory', '/inspection', '/reports'],
  ops_manager: NAV_ALL.map((l) => l.href),
  ceo: NAV_ALL.map((l) => l.href),
};

// Ordered [{href,label}] a role may open. Unknown/blank role → no nav (fail closed); '/' is the root/login
// landing, owned by the shim's overlay, not a nav destination.
function navLinksFor(role) {
  const hrefs = NAV_HREFS_BY_ROLE[role] || [];
  return NAV_ALL.filter((l) => hrefs.indexOf(l.href) !== -1);
}

// { role: [{href,label}], ... } — serialized into the page for the nav shim.
function navByRole() {
  const out = {};
  for (const role of Object.keys(NAV_HREFS_BY_ROLE)) out[role] = navLinksFor(role);
  return out;
}

// Normalize a request path to a canonical nav href: strip a trailing .html, map /index → /.
function canonicalPath(path) {
  let p = String(path || '/');
  const q = p.indexOf('?'); if (q !== -1) p = p.slice(0, q);
  if (p === '/index.html' || p === '/index') return '/';
  p = p.replace(/\.html$/, '');
  return p === '' ? '/' : p;
}

// May this role open this page? Unknown page → false (fail closed).
function canOpenPage(role, path) {
  const hrefs = NAV_HREFS_BY_ROLE[role] || ['/'];
  return hrefs.indexOf(canonicalPath(path)) !== -1;
}

export {
  ROLE, ACCESS_WRITE_MANAGER_ROLES, canWriteAction,
  canRead, READ_ALL_ROLES,
  NAV_ALL, NAV_HREFS_BY_ROLE, navLinksFor, navByRole, canonicalPath, canOpenPage,
};
