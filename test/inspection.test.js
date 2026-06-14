// test/inspection.test.js — locks the inspection module: validation + suggest-then-confirm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateInspection, validateFinding, canBecomeRequest, findingToRequestPayload,
  nextInspectionDate, DEFAULT_REINSPECT_MONTHS, consolidateDefectsByHouse,
} from '../src/inspection.js';
import { FINDING_TYPE, INSPECTION_DOMAINS, CATEGORY } from '../src/schema.js';

const inspection = { house: 'רעננה', inspector: 'אולגה', inspection_date: '2026-05-18' };

test('valid inspection passes', () => {
  assert.equal(validateInspection(inspection), null);
});

test('inspection rejects unknown inspector', () => {
  assert.match(validateInspection({ ...inspection, inspector: 'מישהו' }), /inspector/);
});

test('inspection requires house and date', () => {
  assert.match(validateInspection({ ...inspection, house: '' }), /house/);
  assert.match(validateInspection({ ...inspection, inspection_date: '' }), /date/);
});

test('valid physical-defect finding passes', () => {
  const f = {
    domain: INSPECTION_DOMAINS.CLEANLINESS, finding_text: '4 פחים שבורים',
    finding_type: FINDING_TYPE.PHYSICAL_DEFECT, suggested_category: CATEGORY.REPLACEMENT,
  };
  assert.equal(validateFinding(f), null);
});

test('valid process-note finding passes (no category needed)', () => {
  const f = {
    domain: INSPECTION_DOMAINS.TREATMENT, finding_text: 'מטופל לא נמצא במערכת',
    finding_type: FINDING_TYPE.PROCESS_NOTE,
  };
  assert.equal(validateFinding(f), null);
});

test('finding rejects bad domain / type / empty text', () => {
  assert.match(validateFinding({ domain: 'x', finding_text: 'a', finding_type: FINDING_TYPE.PROCESS_NOTE }), /domain/);
  assert.match(validateFinding({ domain: INSPECTION_DOMAINS.KITCHEN, finding_text: '', finding_type: FINDING_TYPE.PROCESS_NOTE }), /finding_text/);
  assert.match(validateFinding({ domain: INSPECTION_DOMAINS.KITCHEN, finding_text: 'a', finding_type: 'weird' }), /finding_type/);
});

test('physical defect with invalid suggested_category is rejected', () => {
  const f = {
    domain: INSPECTION_DOMAINS.CLEANLINESS, finding_text: 'x',
    finding_type: FINDING_TYPE.PHYSICAL_DEFECT, suggested_category: 'רכישה',
  };
  assert.match(validateFinding(f), /suggested_category/);
});

test('only physical defects (unlinked) can become requests', () => {
  assert.equal(canBecomeRequest({ finding_type: FINDING_TYPE.PHYSICAL_DEFECT }), true);
  assert.equal(canBecomeRequest({ finding_type: FINDING_TYPE.PROCESS_NOTE }), false);
  // already linked → not again
  assert.equal(canBecomeRequest({ finding_type: FINDING_TYPE.PHYSICAL_DEFECT, linked_request_id: 'REQ-1' }), false);
});

test('findingToRequestPayload builds a request that will route to Roy (blank cost)', () => {
  const finding = {
    id: 'F-1', domain: INSPECTION_DOMAINS.CLEANLINESS, finding_text: 'תיקון צבע בתקרה',
    finding_type: FINDING_TYPE.PHYSICAL_DEFECT, suggested_category: CATEGORY.REPAIR,
    location_in_house: 'חדר שינה משמאל',
  };
  const payload = findingToRequestPayload(finding, inspection, 'רועי');
  assert.equal(payload.house, 'רעננה');
  assert.equal(payload.category, CATEGORY.REPAIR);
  assert.equal(payload.description, 'תיקון צבע בתקרה');
  assert.equal(payload.location_in_house, 'חדר שינה משמאל');
  assert.equal(payload.estimated_cost, '');     // unknown → Roy
  assert.equal(payload.created_by, 'רועי');
  assert.equal(payload._origin, 'inspection');
  assert.equal(payload._finding_id, 'F-1');
});

test('process note cannot be converted to a request', () => {
  const f = { id: 'F-2', finding_type: FINDING_TYPE.PROCESS_NOTE, finding_text: 'note' };
  assert.throws(() => findingToRequestPayload(f, inspection, 'רועי'), /physical defect/);
});

// ---- Follow-up re-inspection ----

test('default re-inspection is one month out', () => {
  assert.equal(DEFAULT_REINSPECT_MONTHS, 1);
  assert.equal(nextInspectionDate('2026-05-18'), '2026-06-18');
});

test('nextInspectionDate accepts a custom month offset', () => {
  assert.equal(nextInspectionDate('2026-01-15', 3), '2026-04-15');
});

test('nextInspectionDate clamps end-of-month overflow', () => {
  // Jan 31 + 1 month → Feb 28 (2026 is not a leap year), not an invalid Feb 31.
  assert.equal(nextInspectionDate('2026-01-31', 1), '2026-02-28');
});

test('nextInspectionDate rolls over the year', () => {
  assert.equal(nextInspectionDate('2026-12-10', 1), '2027-01-10');
});

test('nextInspectionDate returns empty for bad input', () => {
  assert.equal(nextInspectionDate(''), '');
  assert.equal(nextInspectionDate(null), '');
  assert.equal(nextInspectionDate('nope'), '');
});

// ---- Per-house defect consolidation ----

test('consolidateDefectsByHouse de-duplicates same defect across inspections', () => {
  const inspections = [
    { id: 'I1', house: 'רעננה' },
    { id: 'I2', house: 'רעננה' },
    { id: 'I3', house: 'ריהאב' },
  ];
  const findings = [
    { id: 'F1', inspection_id: 'I1', finding_type: 'physical_defect', linked_request_id: '', finding_text: 'נזילה במקלחת', location_in_house: 'חדר 2' },
    { id: 'F2', inspection_id: 'I2', finding_type: 'physical_defect', linked_request_id: '', finding_text: '  נזילה במקלחת ', location_in_house: '' }, // dup (spacing)
    { id: 'F3', inspection_id: 'I3', finding_type: 'physical_defect', linked_request_id: '', finding_text: 'דלת שבורה' },
    { id: 'F4', inspection_id: 'I1', finding_type: 'process_note', linked_request_id: '', finding_text: 'הערה' }, // not a defect
    { id: 'F5', inspection_id: 'I1', finding_type: 'physical_defect', linked_request_id: 'R9', finding_text: 'כבר דרישה' }, // linked → excluded
  ];
  const out = consolidateDefectsByHouse(findings, inspections);
  const raanana = out.find((h) => h.house === 'רעננה');
  assert.equal(raanana.items.length, 1);          // the two נזילה rows merged
  assert.equal(raanana.items[0].count, 2);
  assert.equal(raanana.items[0].location_in_house, 'חדר 2'); // first non-blank location kept
  assert.deepEqual(raanana.items[0].ids.sort(), ['F1', 'F2']);
  const rehab = out.find((h) => h.house === 'ריהאב');
  assert.equal(rehab.items.length, 1);
});
