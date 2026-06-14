// test/workorders.test.js — covers Roy's weekly work-order generation:
// lead filtering, house-first grouping, urgency ordering within and across houses,
// and the two open-item sources (approved-unassigned requests + open inspection defects).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  urgencyRank, houseLeadMap, collectLeadItems, buildWeeklyOrder, weeklyOrderForLead,
} from '../src/workorders.js';

const HOUSES = [
  { name: 'רעננה', technician: 'רמי' },
  { name: 'רמות השבים', technician: 'רמי' },
  { name: 'קיסריה עפרוני', technician: 'צחי' },
  { name: 'ריהאב', technician: 'צחי' },
];

test('urgencyRank orders emergency < urgent < normal < unknown', () => {
  assert.ok(urgencyRank('חירום') < urgencyRank('דחוף'));
  assert.ok(urgencyRank('דחוף') < urgencyRank('רגיל'));
  assert.ok(urgencyRank('רגיל') < urgencyRank('whatever'));
});

test('houseLeadMap maps house name to its lead', () => {
  const m = houseLeadMap(HOUSES);
  assert.equal(m['רעננה'], 'רמי');
  assert.equal(m['ריהאב'], 'צחי');
});

test('collectLeadItems takes only approved-unassigned requests for the lead', () => {
  const requests = [
    { id: 'R1', status: 'מאושר', assigned_to: '', house: 'רעננה', urgency: 'דחוף', description: 'ברז' },
    { id: 'R2', status: 'מאושר', assigned_to: 'רמי', house: 'רעננה', urgency: 'רגיל', description: 'כבר הוקצה' },
    { id: 'R3', status: 'דרישה', assigned_to: '', house: 'רעננה', urgency: 'רגיל', description: 'עוד לא אושר' },
    { id: 'R4', status: 'מאושר', assigned_to: '', house: 'ריהאב', urgency: 'רגיל', description: 'של צחי' },
  ];
  const items = collectLeadItems({ requests, findings: [], inspections: [], houseLead: houseLeadMap(HOUSES), lead: 'רמי' });
  assert.deepEqual(items.map((i) => i.id), ['R1']); // only R1: approved, unassigned, Rami's house
});

test('collectLeadItems includes open inspection defects for the lead', () => {
  const inspections = [{ id: 'INS1', house: 'רמות השבים' }];
  const findings = [
    { id: 'F1', inspection_id: 'INS1', finding_type: 'physical_defect', linked_request_id: '', finding_text: 'נזילה', suggested_category: 'תיקון' },
    { id: 'F2', inspection_id: 'INS1', finding_type: 'process_note', linked_request_id: '', finding_text: 'הערה' },
    { id: 'F3', inspection_id: 'INS1', finding_type: 'physical_defect', linked_request_id: 'R9', finding_text: 'כבר דרישה' },
  ];
  const items = collectLeadItems({ requests: [], findings, inspections, houseLead: houseLeadMap(HOUSES), lead: 'רמי' });
  assert.deepEqual(items.map((i) => i.id), ['F1']); // only the open physical defect
});

test('buildWeeklyOrder groups by house, urgent items first within a house', () => {
  const items = [
    { source: 'request', id: 'A', house: 'רעננה', urgency: 'רגיל', title: 'a' },
    { source: 'request', id: 'B', house: 'רעננה', urgency: 'חירום', title: 'b' },
    { source: 'finding', id: 'C', house: 'רעננה', urgency: 'דחוף', title: 'c' },
  ];
  const groups = buildWeeklyOrder(items);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].items.map((i) => i.id), ['B', 'C', 'A']); // emergency, urgent, normal
});

test('buildWeeklyOrder floats the hottest house to the top', () => {
  const items = [
    { id: 'A', house: 'רעננה', urgency: 'רגיל', title: 'a' },
    { id: 'B', house: 'רמות השבים', urgency: 'חירום', title: 'b' },
  ];
  const groups = buildWeeklyOrder(items);
  assert.equal(groups[0].house, 'רמות השבים'); // has the emergency
  assert.equal(groups[1].house, 'רעננה');
});

test('weeklyOrderForLead end-to-end: only that lead, bundled by house', () => {
  const requests = [
    { id: 'R1', status: 'מאושר', assigned_to: '', house: 'רעננה', urgency: 'רגיל', description: 'ברז' },
    { id: 'R2', status: 'מאושר', assigned_to: '', house: 'קיסריה עפרוני', urgency: 'חירום', description: 'של צחי' },
  ];
  const inspections = [{ id: 'INS1', house: 'רעננה' }];
  const findings = [
    { id: 'F1', inspection_id: 'INS1', finding_type: 'physical_defect', linked_request_id: '', finding_text: 'נזילה' },
  ];
  const out = weeklyOrderForLead({ requests, findings, inspections, houses: HOUSES, lead: 'רמי' });
  assert.equal(out.lead, 'רמי');
  assert.equal(out.total, 2);           // R1 + F1, both Rami / רעננה; R2 is Tzachi's
  assert.equal(out.groups.length, 1);   // bundled into one house
  assert.equal(out.groups[0].house, 'רעננה');
  assert.equal(out.groups[0].items.length, 2);
});
