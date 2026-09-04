// notify.js — email notifications (PR 5): WHO gets mail for WHICH event, and the deferral wake-up rule.
//
// PURE, dependency-free module. The MIRROR:notify block is duplicated verbatim in apps-script/Code.gs
// (the drift guard asserts they stay identical) — that is where it actually runs, next to the MailApp
// wiring (notifyEvent_), which is Apps-Script-only and NOT mirrored. Nothing here sends mail.
//
// Recipients come ONLY from Config (never hardcoded):
//   notify_email_approver   — אולגה
//   notify_email_field_ops  — רועי
//   notify_enabled          — TRUE/FALSE master switch (coerced to a boolean by src/config.js / Code.gs)
// Events → recipients:
//   new_request      → רועי + אולגה        (a request landed: manager modal or the coordinators intake)
//   emergency_auto   → רועי + אולגה        (an emergency request landed — auto-approved by chain B)
//   approved         → רועי
//   rejected         → רועי
//   deferral_wakeup  → רועי                (deferred_until reached, found by the daily scan)
// A blank recipient or notify_enabled = FALSE → [] (the caller sends nothing and logs nothing else).

// === MIRROR:notify START ===
var NOTIFY_EVENT = {
  NEW_REQUEST: 'new_request',
  EMERGENCY_AUTO: 'emergency_auto',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  DEFERRAL_WAKEUP: 'deferral_wakeup',
};
var NOTIFY_EVENTS = [NOTIFY_EVENT.NEW_REQUEST, NOTIFY_EVENT.EMERGENCY_AUTO, NOTIFY_EVENT.APPROVED, NOTIFY_EVENT.REJECTED, NOTIFY_EVENT.DEFERRAL_WAKEUP];

// Hebrew event labels (the subject's <event> part).
var NOTIFY_LABEL = {
  new_request: 'דרישה חדשה',
  emergency_auto: 'דרישת חירום — אושרה אוטומטית',
  approved: 'דרישה אושרה',
  rejected: 'דרישה לא אושרה',
  deferral_wakeup: 'דרישה דחויה חזרה ללוח',
};

// One address cell → a usable address, or ''. Trimmed; must look like one e-mail (an '@', no whitespace,
// no line breaks — so a stray header injection or a "a, b" pair in one cell is never passed to MailApp).
function notifyAddress(v) {
  if (v == null) return '';
  var s = String(v).replace(/^\s+|\s+$/g, '');
  if (s === '' || /[\s,;<>"]/.test(s)) return '';
  var at = s.indexOf('@');
  if (at < 1 || at !== s.lastIndexOf('@') || at === s.length - 1) return '';
  return s;
}

// The master switch. Accepts the coerced boolean AND the raw Sheet spellings (defensive: a caller that
// bypassed coercion must not silently turn mail on/off).
function notifyEnabled(config) {
  var v = config ? config.notify_enabled : undefined;
  if (v === true) return true;
  if (v === false || v == null) return false;
  return ['true', 'TRUE', 'True', '1', 'yes', 'YES'].indexOf(String(v).replace(/^\s+|\s+$/g, '')) !== -1;
}

// WHO gets this event. [] when disabled, unknown event, or every relevant address is blank.
// Unique, in a stable order (רועי first, then אולגה).
function notifyRecipients(event, config) {
  if (!notifyEnabled(config)) return [];
  var roy = notifyAddress(config.notify_email_field_ops);
  var olga = notifyAddress(config.notify_email_approver);
  var wanted;
  if (event === NOTIFY_EVENT.NEW_REQUEST || event === NOTIFY_EVENT.EMERGENCY_AUTO) wanted = [roy, olga];
  else if (event === NOTIFY_EVENT.APPROVED || event === NOTIFY_EVENT.REJECTED || event === NOTIFY_EVENT.DEFERRAL_WAKEUP) wanted = [roy];
  else return [];
  var out = [];
  for (var i = 0; i < wanted.length; i++) {
    if (wanted[i] && out.indexOf(wanted[i]) === -1) out.push(wanted[i]);
  }
  return out;
}

// "[לוגיסטיקה] <event> · <house> · #<id>"
function notifySubject(event, house, id) {
  var label = NOTIFY_LABEL[event] || String(event || '');
  return '[לוגיסטיקה] ' + label + ' · ' + String(house == null ? '' : house) + ' · #' + String(id == null ? '' : id);
}

// The event a freshly CREATED request raises: an emergency is auto-approved by chain B (emergency_auto),
// anything else is a plain new request.
function notifyEventForNewRequest(urgency) {
  return urgency === 'חירום' ? NOTIFY_EVENT.EMERGENCY_AUTO : NOTIFY_EVENT.NEW_REQUEST;
}

// Deferral wake-ups due: every request still in נדחה לתאריך whose deferred_until (YYYY-MM-DD, or an ISO
// timestamp — only the date part is compared) is on or before `todayYmd`. The request is NOT changed —
// a human re-decides it; the scan only notifies (deduped per request by NotifyLog).
function deferralWakeupsDue(requests, todayYmd) {
  var out = [];
  var today = String(todayYmd || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return out;
  for (var i = 0; i < (requests || []).length; i++) {
    var r = requests[i];
    if (!r || String(r.status) !== 'נדחה לתאריך') continue;
    var raw = r.deferred_until;
    var until = (raw instanceof Date) ? raw.toISOString().slice(0, 10) : String(raw == null ? '' : raw).replace(/^\s+|\s+$/g, '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) continue;
    if (until <= today) out.push(r);
  }
  return out;
}
// === MIRROR:notify END ===

export {
  NOTIFY_EVENT, NOTIFY_EVENTS, NOTIFY_LABEL, notifyAddress, notifyEnabled, notifyRecipients, notifySubject,
  notifyEventForNewRequest, deferralWakeupsDue,
};
