// defer.js — pure helpers for deferral reminders (mirrors the inline copy in dashboard.html
// and the date logic in Code.gs checkDeferralReminders).

// Reminder date = deferred_until minus `daysBefore` days, as YYYY-MM-DD. '' for invalid input.
export function reminderDate(deferUntil, daysBefore) {
  if (!deferUntil) return '';
  const d = new Date(deferUntil + 'T00:00:00');
  if (isNaN(d.getTime())) return '';
  d.setDate(d.getDate() - (Number(daysBefore) || 0));
  return d.toISOString().slice(0, 10);
}

// Is the reminder due, given a reference "today" (YYYY-MM-DD)?
export function reminderDue(remindOn, today) {
  if (!remindOn || !today) return false;
  return today >= remindOn;
}
