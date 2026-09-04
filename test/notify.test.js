// test/notify.test.js — the PURE e-mail rules (src/notify.js, mirrored into Code.gs under MIRROR:notify):
// recipient resolution per event, the master switch, blank/malformed addresses, the subject format, the
// new-request → event mapping, and the deferral wake-up rule. Nothing here sends mail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTIFY_EVENT, NOTIFY_EVENTS, NOTIFY_LABEL, notifyAddress, notifyEnabled, notifyRecipients, notifySubject,
  notifyEventForNewRequest, deferralWakeupsDue,
} from '../src/notify.js';

const ROY = 'roy@example.org', OLGA = 'olga@example.org';
const CFG = { notify_enabled: true, notify_email_approver: OLGA, notify_email_field_ops: ROY };

test('recipients per event: new request + emergency → Roy + Olga; approved / rejected / deferral wake-up → Roy only', () => {
  assert.deepEqual(notifyRecipients(NOTIFY_EVENT.NEW_REQUEST, CFG), [ROY, OLGA]);
  assert.deepEqual(notifyRecipients(NOTIFY_EVENT.EMERGENCY_AUTO, CFG), [ROY, OLGA]);
  assert.deepEqual(notifyRecipients(NOTIFY_EVENT.APPROVED, CFG), [ROY]);
  assert.deepEqual(notifyRecipients(NOTIFY_EVENT.REJECTED, CFG), [ROY]);
  assert.deepEqual(notifyRecipients(NOTIFY_EVENT.DEFERRAL_WAKEUP, CFG), [ROY]);
  assert.deepEqual(notifyRecipients('nonsense', CFG), [], 'unknown event → nobody');
  assert.deepEqual(NOTIFY_EVENTS, ['new_request', 'emergency_auto', 'approved', 'rejected', 'deferral_wakeup']);
});

test('notify_enabled = FALSE (or missing) → [] for every event; the raw Sheet spellings are honoured too', () => {
  for (const ev of NOTIFY_EVENTS) {
    assert.deepEqual(notifyRecipients(ev, { ...CFG, notify_enabled: false }), []);
    assert.deepEqual(notifyRecipients(ev, { ...CFG, notify_enabled: 'FALSE' }), []);
    assert.deepEqual(notifyRecipients(ev, { notify_email_approver: OLGA, notify_email_field_ops: ROY }), [], 'missing switch = off');
  }
  assert.deepEqual(notifyRecipients(NOTIFY_EVENT.APPROVED, { ...CFG, notify_enabled: 'TRUE' }), [ROY]);
  assert.deepEqual(notifyRecipients(NOTIFY_EVENT.APPROVED, { ...CFG, notify_enabled: ' yes ' }), [ROY]);
  assert.equal(notifyEnabled(null), false);
});

test('blank recipients are dropped: no Roy → new request goes to Olga only; nobody → []', () => {
  assert.deepEqual(notifyRecipients(NOTIFY_EVENT.NEW_REQUEST, { ...CFG, notify_email_field_ops: '' }), [OLGA]);
  assert.deepEqual(notifyRecipients(NOTIFY_EVENT.APPROVED, { ...CFG, notify_email_field_ops: '   ' }), [], 'Roy-only event with Roy blank → nobody');
  assert.deepEqual(notifyRecipients(NOTIFY_EVENT.NEW_REQUEST, { notify_enabled: true }), []);
  // the same address in both cells is sent once
  assert.deepEqual(notifyRecipients(NOTIFY_EVENT.NEW_REQUEST, { ...CFG, notify_email_approver: ROY }), [ROY]);
});

test('notifyAddress: trims; rejects anything that is not exactly one plain e-mail (no whitespace / commas / angle brackets / header injection)', () => {
  assert.equal(notifyAddress('  olga@example.org '), 'olga@example.org');
  for (const bad of ['', '   ', 'olga', '@example.org', 'olga@', 'a@b@c', 'olga@example.org, roy@example.org', 'olga@example.org\nBcc: x@y.z', '"Olga" <olga@example.org>', null, undefined]) {
    assert.equal(notifyAddress(bad), '', `rejects ${JSON.stringify(bad)}`);
  }
});

test('subject: "[לוגיסטיקה] <event> · <house> · #<id>" with the Hebrew event label', () => {
  assert.equal(notifySubject(NOTIFY_EVENT.NEW_REQUEST, 'רמות השבים', 'REQ-42'), '[לוגיסטיקה] דרישה חדשה · רמות השבים · #REQ-42');
  assert.equal(notifySubject(NOTIFY_EVENT.APPROVED, 'רעננה אשר', 'R1'), '[לוגיסטיקה] דרישה אושרה · רעננה אשר · #R1');
  assert.equal(notifySubject(NOTIFY_EVENT.REJECTED, 'x', 'R1'), '[לוגיסטיקה] דרישה לא אושרה · x · #R1');
  assert.equal(notifySubject(NOTIFY_EVENT.EMERGENCY_AUTO, 'x', 'R1'), '[לוגיסטיקה] דרישת חירום — אושרה אוטומטית · x · #R1');
  assert.equal(notifySubject(NOTIFY_EVENT.DEFERRAL_WAKEUP, 'x', 'R1'), '[לוגיסטיקה] דרישה דחויה חזרה ללוח · x · #R1');
  for (const ev of NOTIFY_EVENTS) assert.ok(NOTIFY_LABEL[ev], `${ev} has a Hebrew label`);
});

test('a freshly created request raises emergency_auto for חירום, else new_request', () => {
  assert.equal(notifyEventForNewRequest('חירום'), NOTIFY_EVENT.EMERGENCY_AUTO);
  assert.equal(notifyEventForNewRequest('רגיל'), NOTIFY_EVENT.NEW_REQUEST);
  assert.equal(notifyEventForNewRequest('דחוף'), NOTIFY_EVENT.NEW_REQUEST);
  assert.equal(notifyEventForNewRequest(undefined), NOTIFY_EVENT.NEW_REQUEST);
});

test('deferralWakeupsDue: deferred requests whose deferred_until is today or earlier; status must still be נדחה לתאריך', () => {
  const reqs = [
    { id: 'A', status: 'נדחה לתאריך', deferred_until: '2026-09-04' },            // today → due
    { id: 'B', status: 'נדחה לתאריך', deferred_until: '2026-08-30' },            // past → due
    { id: 'C', status: 'נדחה לתאריך', deferred_until: '2026-09-05' },            // tomorrow → not yet
    { id: 'D', status: 'מאושר', deferred_until: '2026-08-01' },                   // already re-decided → not
    { id: 'E', status: 'נדחה לתאריך', deferred_until: '' },                       // no date → not
    { id: 'F', status: 'נדחה לתאריך', deferred_until: '2026-09-01T00:00:00.000Z' }, // ISO timestamp → date part
    { id: 'G', status: 'נדחה לתאריך', deferred_until: new Date('2026-09-02T10:00:00.000Z') }, // Date cell
    null,
  ];
  assert.deepEqual(deferralWakeupsDue(reqs, '2026-09-04').map((r) => r.id), ['A', 'B', 'F', 'G']);
  assert.deepEqual(deferralWakeupsDue(reqs, '2026-08-29'), []);
  assert.deepEqual(deferralWakeupsDue(reqs, 'not-a-date'), [], 'a bad today → nothing (never a flood)');
  assert.deepEqual(deferralWakeupsDue(null, '2026-09-04'), []);
});
