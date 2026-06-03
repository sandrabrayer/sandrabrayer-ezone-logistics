// inspection.js — pure, testable logic for the inspections module (§13).
//
// Two responsibilities:
//  1. Validate an inspection and its findings.
//  2. Convert a CONFIRMED physical-defect finding into a request payload (suggest-then-confirm:
//     Olga flags the defect, Roy confirms it into a tracked request that flows through the SAME
//     approval pipeline as any other request).
//
// Pure JS (no Apps Script) so node:test verifies it. Code.gs mirrors the rules.

import { FINDING_TYPE, INSPECTION_DOMAINS, CATEGORY, STATUSES, INSPECTION_USERS } from './schema.js';

const VALID_DOMAINS = new Set(Object.values(INSPECTION_DOMAINS));
const VALID_FINDING_TYPES = new Set(Object.values(FINDING_TYPE));

/** Validate the inspection header. Returns null if valid, else an error string. */
export function validateInspection(input) {
  if (!input || typeof input !== 'object') return 'Missing inspection';
  if (!input.house) return 'Missing house';
  if (!INSPECTION_USERS.includes(input.inspector)) return 'Invalid or missing inspector';
  if (!input.inspection_date) return 'Missing inspection_date';
  return null;
}

/** Validate a single finding. Returns null if valid, else an error string. */
export function validateFinding(f) {
  if (!f || typeof f !== 'object') return 'Missing finding';
  if (!VALID_DOMAINS.has(f.domain)) return 'Invalid or missing domain';
  if (!f.finding_text) return 'Missing finding_text';
  if (!VALID_FINDING_TYPES.has(f.finding_type)) return 'Invalid or missing finding_type';
  // A physical defect should carry a suggested category so Roy's confirmation can pre-fill a request.
  if (f.finding_type === FINDING_TYPE.PHYSICAL_DEFECT && f.suggested_category) {
    if (![CATEGORY.REPAIR, CATEGORY.REPLACEMENT].includes(f.suggested_category)) {
      return 'suggested_category must be תיקון or החלפה';
    }
  }
  return null;
}

/** Only physical defects are eligible to become requests; process notes never are. */
export function canBecomeRequest(finding) {
  return finding.finding_type === FINDING_TYPE.PHYSICAL_DEFECT && !finding.linked_request_id;
}

/**
 * Build a request payload from a confirmed inspection finding. The resulting request is then
 * created and routed by the EXISTING approval pipeline (same §6 threshold rule) — origin doesn't
 * change the rules. Cost is unknown at inspection time, so it's blank → routes to Roy unless he
 * sets a cost later.
 *
 * @param {object} finding   the InspectionFindings row (confirmed physical_defect)
 * @param {object} inspection the parent Inspections row (for house)
 * @param {string} confirmedBy who confirmed (Roy)
 * @returns {object} a request payload ready for the createRequest pipeline
 */
export function findingToRequestPayload(finding, inspection, confirmedBy) {
  if (!canBecomeRequest(finding)) {
    throw new Error('Only an unlinked physical defect can become a request');
  }
  return {
    created_by: confirmedBy,
    house: inspection.house,
    category: finding.suggested_category || CATEGORY.REPAIR,
    description: finding.finding_text,
    location_in_house: finding.location_in_house || '',
    urgency: 'רגיל',           // inspection findings default to normal; Roy can escalate
    estimated_cost: '',        // unknown at inspection time → routes to Roy
    _origin: 'inspection',     // traceability; Code.gs notes this in the audit log
    _finding_id: finding.id,
  };
}
