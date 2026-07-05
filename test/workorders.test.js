// test/workorders.test.js — covers Roy's weekly work-order generation:
// lead filtering, house-first grouping, urgency ordering within and across houses,
// and the two open-item sources (approved-unassigned requests + open inspection defects).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  urgencyRank, houseLeadMap, collectLeadItems, buildWeeklyOrder, weeklyOrderForLead,
  isExecutionLive, collectExecutionItems, EXEC_DONE, EXEC_NOT_DONE, EXEC_OTHER, EXEC_CHOICES,
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

test('collectLeadItems shows only requests referred to the lead and still open', () => {
  const requests = [
    { id: 'R1', status: 'בביצוע', assigned_to: 'רמי', house: 'רעננה', urgency: 'דחוף', description: 'ברז' },
    { id: 'R2', status: 'מאושר', assigned_to: '', house: 'רעננה', urgency: 'רגיל', description: 'לא הופנה עדיין' },
    { id: 'R3', status: 'הושלם', assigned_to: 'רמי', house: 'רעננה', urgency: 'רגיל', description: 'כבר הושלם' },
    { id: 'R4', status: 'בביצוע', assigned_to: 'צחי', house: 'ריהאב', urgency: 'רגיל', description: 'של צחי' },
    { id: 'R5', status: 'סגור', assigned_to: 'רמי', house: 'רעננה', urgency: 'רגיל', description: 'נסגר' },
  ];
  const items = collectLeadItems({ requests, lead: 'רמי' });
  assert.deepEqual(items.map((i) => i.id), ['R1']); // referred to Rami, not done; R3/R5 done, R2 unreferred, R4 Tzachi's
});

test('collectLeadItems carries in-progress work forward (not just one status)', () => {
  const requests = [
    { id: 'A', status: 'בביצוע', assigned_to: 'צחי', house: 'ריהאב', urgency: 'רגיל', description: 'a' },
    { id: 'B', status: 'בביצוע', assigned_to: 'צחי', house: 'קיסריה עפרוני', urgency: 'חירום', description: 'b' },
  ];
  const items = collectLeadItems({ requests, lead: 'צחי' });
  assert.equal(items.length, 2);
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

test('weeklyOrderForLead end-to-end: only referred-to-lead, bundled by house', () => {
  const requests = [
    { id: 'R1', status: 'בביצוע', assigned_to: 'רמי', house: 'רעננה', urgency: 'רגיל', description: 'ברז' },
    { id: 'R2', status: 'בביצוע', assigned_to: 'רמי', house: 'רעננה', urgency: 'דחוף', description: 'דלת' },
    { id: 'R3', status: 'בביצוע', assigned_to: 'צחי', house: 'קיסריה עפרוני', urgency: 'חירום', description: 'של צחי' },
    { id: 'R4', status: 'הושלם', assigned_to: 'רמי', house: 'רעננה', urgency: 'רגיל', description: 'הושלם' },
  ];
  const out = weeklyOrderForLead({ requests, lead: 'רמי' });
  assert.equal(out.lead, 'רמי');
  assert.equal(out.total, 2);           // R1 + R2 (Rami, open); R3 Tzachi's, R4 done
  assert.equal(out.groups.length, 1);   // both in רעננה → one house bundle
  assert.equal(out.groups[0].house, 'רעננה');
  assert.equal(out.groups[0].items.length, 2);
});

// ── Execution status ("סטטוס ביצוע" tab): a task stays live until marked בוצע. ──

test('EXEC_CHOICES are exactly בוצע / לא בוצע / אחר', () => {
  assert.deepEqual(EXEC_CHOICES, [EXEC_DONE, EXEC_NOT_DONE, EXEC_OTHER]);
  assert.deepEqual(EXEC_CHOICES, ['בוצע', 'לא בוצע', 'אחר']);
});

test('isExecutionLive: only בוצע (or completed/closed) drops a task off the list', () => {
  const base = { assigned_to: 'רמי', status: 'בביצוע' };
  assert.equal(isExecutionLive({ ...base, execution_status: '' }), true);          // fresh → live
  assert.equal(isExecutionLive({ ...base, execution_status: 'לא בוצע' }), true);    // not done → stays live
  assert.equal(isExecutionLive({ ...base, execution_status: 'אחר' }), true);        // other → stays live
  assert.equal(isExecutionLive({ ...base, execution_status: 'בוצע' }), false);      // done → gone
  assert.equal(isExecutionLive({ ...base, status: 'הושלם' }), false);               // completed → gone
  assert.equal(isExecutionLive({ ...base, status: 'סגור' }), false);                // closed → gone
  assert.equal(isExecutionLive(null), false);                                        // guard
});

test('collectExecutionItems returns live referred tasks, drops בוצע and completed', () => {
  const requests = [
    { id: 'R1', assigned_to: 'רמי', status: 'בביצוע', execution_status: '', house: 'רעננה', urgency: 'רגיל', description: 'ברז' },
    { id: 'R2', assigned_to: 'צחי', status: 'בביצוע', execution_status: 'לא בוצע', house: 'ריהאב', urgency: 'דחוף', description: 'דלת' },
    { id: 'R3', assigned_to: 'רועי', status: 'בביצוע', execution_status: 'אחר', house: 'רעננה', urgency: 'רגיל', description: 'אחר' },
    { id: 'R4', assigned_to: 'רמי', status: 'בביצוע', execution_status: 'בוצע', house: 'רעננה', urgency: 'רגיל', description: 'בוצע' },
    { id: 'R5', assigned_to: 'צחי', status: 'הושלם', execution_status: 'בוצע', house: 'ריהאב', urgency: 'רגיל', description: 'הושלם' },
    { id: 'R6', assigned_to: '', status: 'מאושר', execution_status: '', house: 'רעננה', urgency: 'רגיל', description: 'לא הופנה' },
  ];
  const items = collectExecutionItems({ requests });
  assert.deepEqual(items.map((i) => i.id).sort(), ['R1', 'R2', 'R3']); // בוצע + הושלם + unassigned excluded
});

test('collectExecutionItems carries assigned_to and execution_status through', () => {
  const requests = [
    { id: 'R1', assigned_to: 'רועי', status: 'בביצוע', execution_status: 'אחר', house: 'רעננה', urgency: 'רגיל', description: 'x' },
  ];
  const [it] = collectExecutionItems({ requests });
  assert.equal(it.assigned_to, 'רועי');
  assert.equal(it.execution_status, 'אחר');
});
