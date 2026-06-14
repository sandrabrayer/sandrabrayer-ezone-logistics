// workorders.js — pure, testable logic for Roy's weekly work orders to the maintenance leads.
//
// Roy generates a weekly task list per maintenance lead (רמי / צחי). The list pulls every open
// item that belongs to that lead and groups it SMARTLY:
//   • primarily BY HOUSE — so if a lead is already going to a house, everything for that house is
//     bundled into one trip (this is the "smart" part Sandra asked for);
//   • within each house, ordered by urgency (חירום → דחוף → רגיל);
//   • houses themselves ordered by their most-urgent item, so the hottest house floats to the top.
//
// Two open-item sources feed a lead's list:
//   1. Approved-but-unassigned requests (status מאושר) for houses that lead covers.
//   2. Open inspection defects (physical_defect, not yet linked to a request) for those houses.
// Roy can remove items before issuing; that's a UI concern. This module just builds the proposal.
//
// Pure JS (no Apps Script, no DOM) so node:test verifies it. Code.gs/workorders.html mirror it.

export const URGENCY_RANK = { 'חירום': 0, 'דחוף': 1, 'רגיל': 2 };
const STATUS_APPROVED = 'מאושר';
const FINDING_PHYSICAL_DEFECT = 'physical_defect';

/** Numeric urgency rank; unknown/blank sorts last (after רגיל). Lower = more urgent. */
export function urgencyRank(urgency) {
  return Object.prototype.hasOwnProperty.call(URGENCY_RANK, urgency) ? URGENCY_RANK[urgency] : 3;
}

/**
 * Map a house name → its maintenance lead, from the Houses rows.
 * @param {Array<{name:string, technician:string}>} houses
 * @returns {Object<string,string>}
 */
export function houseLeadMap(houses) {
  const map = {};
  (houses || []).forEach((h) => { if (h && h.name) map[h.name] = h.technician || ''; });
  return map;
}

/**
 * Normalize the two open-item sources into one flat list of work items for a given lead.
 * Each work item: { source, id, house, title, urgency, category, location, _ref }.
 *
 * A lead's worklist = requests Roy REFERRED to them (assigned_to === lead) that are still open
 * (not הושלם/סגור). Referred work lands here and carries forward until completed.
 *
 * @param {object} args
 * @param {Array} args.requests   all request rows
 * @param {string} args.lead      the maintenance lead to build for (רמי / צחי)
 * @returns {Array} flat work items referred to that lead and still open
 */
export function collectLeadItems({ requests, lead }) {
  const DONE = ['הושלם', 'סגור'];
  const items = [];
  (requests || []).forEach((r) => {
    if (!r || r.assigned_to !== lead) return;     // only what Roy referred to this lead
    if (DONE.indexOf(r.status) !== -1) return;     // still open
    items.push({
      source: 'request', id: r.id, house: r.house,
      title: r.description || r.id, urgency: r.urgency || 'רגיל',
      category: r.category || '', location: r.location_in_house || '', status: r.status, _ref: r,
    });
  });
  return items;
}

// eslint-disable-next-line no-unused-vars
function _legacyCollectLeadItems({ requests, findings, inspections, houseLead, lead }) {
  const items = [];

  // 1) Approved, not-yet-assigned requests whose house is covered by this lead.
  (requests || []).forEach((r) => {
    if (!r || r.status !== STATUS_APPROVED) return;
    if (r.assigned_to) return; // already assigned → not part of a fresh weekly proposal
    if ((houseLead[r.house] || '') !== lead) return;
    items.push({
      source: 'request', id: r.id, house: r.house,
      title: r.description || r.id, urgency: r.urgency || 'רגיל',
      category: r.category || '', location: r.location_in_house || '', _ref: r,
    });
  });

  // 2) Open physical-defect findings (not yet a request) whose house is covered by this lead.
  const insById = {};
  (inspections || []).forEach((i) => { if (i && i.id != null) insById[String(i.id)] = i; });
  (findings || []).forEach((f) => {
    if (!f || f.finding_type !== FINDING_PHYSICAL_DEFECT) return;
    if (f.linked_request_id) return; // already became a request → counted above (or assigned)
    const ins = insById[String(f.inspection_id)];
    const house = ins ? ins.house : '';
    if (!house || (houseLead[house] || '') !== lead) return;
    items.push({
      source: 'finding', id: f.id, house,
      title: f.finding_text, urgency: 'רגיל', // findings default to normal; Roy can escalate via a request
      category: f.suggested_category || 'תיקון', location: f.location_in_house || '', _ref: f,
    });
  });

  return items;
}

/**
 * Group a lead's flat work items by house, ordering items within a house by urgency and houses
 * by their most-urgent item. This is the weekly order Roy issues.
 *
 * @param {Array} items  flat work items (from collectLeadItems)
 * @returns {Array<{house:string, topRank:number, items:Array}>} ordered house groups
 */
export function buildWeeklyOrder(items) {
  const byHouse = {};
  (items || []).forEach((it) => {
    (byHouse[it.house] = byHouse[it.house] || []).push(it);
  });

  const groups = Object.keys(byHouse).map((house) => {
    const list = byHouse[house].slice().sort((a, b) => urgencyRank(a.urgency) - urgencyRank(b.urgency));
    const topRank = list.reduce((min, it) => Math.min(min, urgencyRank(it.urgency)), 99);
    return { house, topRank, items: list };
  });

  // Hottest house first; tie-break alphabetically for a stable, readable order.
  groups.sort((a, b) => (a.topRank - b.topRank) || a.house.localeCompare(b.house, 'he'));
  return groups;
}

/**
 * Convenience: full pipeline for one lead — collect, then group.
 * @returns {{lead:string, groups:Array, total:number}}
 */
export function weeklyOrderForLead({ requests, lead }) {
  const items = collectLeadItems({ requests, lead });
  const groups = buildWeeklyOrder(items);
  return { lead, groups, total: items.length };
}
