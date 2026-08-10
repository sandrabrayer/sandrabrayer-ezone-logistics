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

// A checklist rating of 1 or 2 (out of 5) counts as a ליקוי. Anything 3+ is just recorded.
export const RATING_DEFECT_THRESHOLD = 2;

/** True when a 1–5 checklist score should auto-create a physical-defect finding. */
export function ratingIsDefect(score) {
  const n = Number(score);
  return Number.isFinite(n) && n >= 1 && n <= RATING_DEFECT_THRESHOLD;
}

/**
 * Turn a rated checklist row into a physical-defect finding payload (suggested category = repair).
 * Returns null when the score is fine (3–5) or blank — only 1–2 produce a finding.
 * @param {{domain:string,item:string,score:number}} rating
 */
export function ratingToFinding(rating) {
  if (!rating || !ratingIsDefect(rating.score)) return null;
  return {
    domain: rating.domain,
    finding_text: `${rating.item} — דירוג ${Number(rating.score)} (ליקוי מצ'קליסט)`,
    finding_type: FINDING_TYPE.PHYSICAL_DEFECT,
    location_in_house: '',
    suggested_category: CATEGORY.REPAIR,
  };
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
// ---- Follow-up re-inspection (בקרה חוזרת) ----
// Every report proposes a re-inspection date. Default is one month after the inspection date;
// Roy/Olga can override before saving. Pure date math so it's testable and timezone-stable.

export const DEFAULT_REINSPECT_MONTHS = 1;

/**
 * Compute a follow-up date `months` after an ISO date string (YYYY-MM-DD).
 * Clamps end-of-month overflow (e.g. Jan 31 + 1mo → Feb 28/29) so the date stays valid.
 * @param {string} isoDate  base date, "YYYY-MM-DD"
 * @param {number} [months] months to add (default 1)
 * @returns {string} "YYYY-MM-DD", or '' if input is unusable
 */
export function nextInspectionDate(isoDate, months = DEFAULT_REINSPECT_MONTHS) {
  if (!isoDate || typeof isoDate !== 'string') return '';
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const target = new Date(Date.UTC(y, mo + Number(months), 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

// ---- Per-house defect consolidation (ריכוז ליקויים פר בית) ----
// Roll up open physical-defect findings into one clean list per house, with no duplicates.
// "Duplicate" = same house + same normalized finding text (case/space-insensitive). When the
// same defect is found across inspections, it appears once with a count of how many times it
// was seen — so nobody opens two requests for the same broken tap.

function normalizeText_(s) {
  return String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Consolidate open physical defects per house, de-duplicated by normalized text.
 * @param {Array} findings    inspection-finding rows
 * @param {Array} inspections inspection rows (to resolve each finding's house)
 * @returns {Array<{house:string, items:Array<{finding_text:string, location_in_house:string, suggested_category:string, count:number, ids:string[]}>}>}
 */
export function consolidateDefectsByHouse(findings, inspections) {
  const insById = {};
  (inspections || []).forEach((i) => { if (i && i.id != null) insById[String(i.id)] = i; });

  const byHouse = {};
  (findings || []).forEach((f) => {
    if (!f || f.finding_type !== FINDING_TYPE.PHYSICAL_DEFECT) return;
    if (f.linked_request_id) return; // already became a request → not "open"
    const ins = insById[String(f.inspection_id)];
    const house = ins ? ins.house : '';
    if (!house) return;
    const key = normalizeText_(f.finding_text);
    const bucket = (byHouse[house] = byHouse[house] || {});
    if (bucket[key]) {
      bucket[key].count += 1;
      bucket[key].ids.push(f.id);
      if (!bucket[key].location_in_house && f.location_in_house) bucket[key].location_in_house = f.location_in_house;
    } else {
      bucket[key] = {
        finding_text: f.finding_text,
        location_in_house: f.location_in_house || '',
        suggested_category: f.suggested_category || 'תיקון',
        count: 1, ids: [f.id],
      };
    }
  });

  return Object.keys(byHouse).sort((a, b) => a.localeCompare(b, 'he')).map((house) => ({
    house, items: Object.values(byHouse[house]),
  }));
}

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
