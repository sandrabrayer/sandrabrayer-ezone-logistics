// request.js — pure builder + validator for a NEW request.
//
// WHY PURE: like config.js, this is plain JS with no Apps Script APIs, so node:test can verify
// the rules directly. Code.gs mirrors buildNewRequest / validateNewRequest with the same logic.
//
// SCOPE (increment 2a): capture a request correctly and stamp it as דרישה. NO approval routing,
// NO approval_required computation — that is increment 3. Those fields are left blank here on
// purpose so the approval increment owns them.

import { STATUSES, URGENCY, CATEGORY } from './schema.js';

// Controlled list of who may submit. Not free text — keeps deferral-reminder routing clean
// later (reminders go to "whoever deferred", which must be a known identity, not a typo).
export const SUBMITTERS = ['רמי', 'צחי', 'רועי', 'sandra'];

const VALID_CATEGORIES = new Set(Object.values(CATEGORY));   // רכישה / תיקון / החלפה
const VALID_URGENCIES = new Set(Object.values(URGENCY));     // רגיל / דחוף / חירום

/**
 * Validate raw form input for a new request. Returns null if valid, else an error string.
 * Note: estimated_cost BLANK is valid (unknown cost is a real case, not an error).
 * @param {object} input
 */
export function validateNewRequest(input) {
  if (!input || typeof input !== 'object') return 'Missing payload';
  if (!input.house) return 'Missing house';
  if (!VALID_CATEGORIES.has(input.category)) return 'Invalid or missing category';
  if (!VALID_URGENCIES.has(input.urgency)) return 'Invalid or missing urgency';
  if (!SUBMITTERS.includes(input.created_by)) return 'Invalid or missing created_by';

  const cost = input.estimated_cost;
  const costBlank = cost === '' || cost === null || cost === undefined;
  if (!costBlank && Number.isNaN(Number(cost))) {
    return 'estimated_cost must be a number or blank';
  }
  return null;
}

/**
 * Build the full request row object from validated input. The CLIENT never supplies id, status,
 * created_at, or any approval/assignment/completion field — those are owned server-side (id,
 * status, created_at here) or by later increments (the rest, left blank).
 *
 * @param {object} input  validated form input
 * @param {object} deps   { id, now } injected so tests are deterministic
 * @returns {object} a row keyed by Requests headers
 */
export function buildNewRequest(input, deps) {
  const id = deps.id;
  const now = deps.now;

  const cost = input.estimated_cost;
  const costBlank = cost === '' || cost === null || cost === undefined;

  return {
    id,
    created_at: now,
    created_by: input.created_by,
    house: input.house,
    category: input.category,
    description: input.description || '',
    location_in_house: input.location_in_house || '',
    urgency: input.urgency,
    estimated_cost: costBlank ? '' : Number(cost),
    attachment_url: '',            // photo arrives in 2b
    status: STATUSES.REQUEST,      // דרישה — every new request starts here
    approval_required: '',         // computed in increment 3, not here
    approved_by: '',
    approved_at: '',
    rejection_reason: '',
    deferred_until: '',
    assigned_to: '',
    assignment_type: '',
    batch_id: '',
    completed_at: '',
    actual_cost: '',
    completion_notes: '',
  };
}

/** Generate a request id. Time-based + random suffix; server-side single-writer avoids collisions. */
export function generateRequestId(now, rand) {
  const stamp = new Date(now).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const suffix = String(Math.floor((rand ?? Math.random()) * 1e4)).padStart(4, '0');
  return `REQ-${stamp}-${suffix}`;
}
