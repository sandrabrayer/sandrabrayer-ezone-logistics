// src/inventory.js — pure logic for the WEEKLY inventory count (מלאי), increments 25–26.
// Dependency-free; validation mirrored verbatim in apps-script/Code.gs (server is the real gate).
//
// Model: one submitted count = { house, week_start (YYYY-MM-DD, Sunday), counted_by, items[] }.
// The backend writes one InventoryCounts row PER ITEM, all sharing a count_id. Re-submitting the
// same house+week appends a new count — the latest counted_at wins on display (no destructive
// edits; the sheet keeps full history). Each row also carries `month` (derived from week_start)
// so the monthly-era readers keep working.
//
// SCOPE (increment 26): Logistics owns ONLY טואלטיקה and חומרי ניקוי. Food (מזון) is owned by
// ezone-kitchen — the system of record for per-house stock, budgets, purchases, menus and
// occupancy-driven consumption. Logistics does not duplicate any of it.
//
// Increment 26 moved counts from MONTHLY to WEEKLY. The month-era helpers (currentMonth,
// isValidMonth, formatMonthDisplay) are KEPT — historical rows and the derived `month` column
// still use them, and the week-display helper reuses formatMonthDisplay's RTL/bidi approach.

import { INVENTORY_CATEGORIES, INVENTORY_COUNTERS } from './schema.js';

// ---- Month helpers (historical rows + the derived `month` column) ----

/** Current month as YYYY-MM. */
export function currentMonth(now) {
  const d = now instanceof Date ? now : new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

/** True for a well-formed YYYY-MM month string (2020-01 … 2099-12). */
export function isValidMonth(m) {
  return typeof m === 'string' && /^20[2-9][0-9]-(0[1-9]|1[0-2])$/.test(m);
}

/**
 * A YYYY-MM month formatted for display as MM/YYYY (e.g. '2026-07' → '07/2026').
 * The UI wraps the result in an LTR bidi isolate (<span dir="ltr">…</span>) so the
 * slash-separated digits never reorder inside the RTL layout. Input that is not a
 * well-formed YYYY-MM string is returned unchanged (defensive — never throws).
 */
export function formatMonthDisplay(month) {
  const m = typeof month === 'string' ? month.match(/^(\d{4})-(\d{2})$/) : null;
  return m ? m[2] + '/' + m[1] : String(month == null ? '' : month);
}

// ---- Week helpers (Sunday-based Israeli week) ----
// Computed in UTC so the Sunday boundary is deterministic and test-stable, exactly like the
// digest's weekStart (src/digest.js) — the two must agree on what "the week of X" means.

/** The YYYY-MM-DD of the Sunday that begins the week containing `date`. '' on unparseable input. */
export function weekStart(date) {
  const d = date instanceof Date ? new Date(date.getTime()) : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay()); // getUTCDay: 0 = Sunday
  return d.toISOString().slice(0, 10);
}

/** The current week-start (Sunday) as YYYY-MM-DD — the default value of the week picker. */
export function currentWeekStart(now) {
  return weekStart(now instanceof Date ? now : (now || new Date()));
}

/**
 * True only for a YYYY-MM-DD string that is BOTH well-formed (2020…2099) AND a Sunday.
 * A non-Sunday date is rejected — the week key is always the Sunday that begins the week.
 */
export function isValidWeekStart(w) {
  if (typeof w !== 'string') return false;
  if (!/^20[2-9][0-9]-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/.test(w)) return false;
  return weekStart(w) === w;
}

/** The YYYY-MM month a (valid) week_start falls in, for the derived `month` column. '' otherwise. */
export function monthFromWeekStart(w) {
  return isValidWeekStart(w) ? w.slice(0, 7) : '';
}

/**
 * A YYYY-MM-DD week-start formatted for display as DD/MM/YYYY (e.g. '2026-07-19' → '19/07/2026').
 * Same RTL/bidi-isolate contract as formatMonthDisplay: callers wrap it in <span dir="ltr"> so the
 * slash-separated digits never reorder in the RTL layout. Malformed input is returned unchanged.
 */
export function formatWeekDisplay(w) {
  const m = typeof w === 'string' ? w.match(/^(\d{4})-(\d{2})-(\d{2})$/) : null;
  return m ? m[3] + '/' + m[2] + '/' + m[1] : String(w == null ? '' : w);
}

/**
 * The last `n` Sunday week-starts up to and including the week containing `now`, MOST-RECENT
 * FIRST: index 0 is the current week. Returns an array of YYYY-MM-DD strings — used to populate
 * the week picker with real, unambiguous Sundays (avoids the Monday-based `<input type=week>`).
 */
export function recentWeekStarts(now, n) {
  const count = Number(n) || 0;
  const base = weekStart(now instanceof Date ? now : (now || new Date()));
  if (!base || count <= 0) return [];
  const out = [];
  const d = new Date(base + 'T00:00:00Z');
  for (let i = 0; i < count; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 7);
  }
  return out;
}

// ---- Quantity primitive ----

/** True for a countable quantity: a finite number ≥ 0 (string numerics accepted). */
export function isValidQuantity(q) {
  if (q === '' || q === null || q === undefined) return false;
  const n = Number(q);
  return Number.isFinite(n) && n >= 0;
}

// ---- Coordinator submission validation (mirrored server-side) ----

/**
 * Validate one COORDINATOR submission. Returns null when valid, else a human-readable error.
 * Items with a BLANK quantity are allowed in the input array (the form sends only filled rows,
 * but the server tolerates blanks by skipping them) — however at least ONE item must carry a
 * valid quantity, and any non-blank quantity must be a number ≥ 0.
 */
export function validateInventorySubmission(p) {
  if (!p || typeof p !== 'object') return 'Missing payload';
  if (!p.house) return 'Missing house';
  if (!isValidWeekStart(p.week_start)) return 'week_start must be a Sunday (YYYY-MM-DD)';
  if (INVENTORY_COUNTERS.indexOf(p.counted_by) === -1) return 'Invalid counted_by';
  if (!Array.isArray(p.items) || p.items.length === 0) return 'Missing items';
  let filled = 0;
  for (const it of p.items) {
    if (!it || !it.item) return 'Item missing name';
    if (INVENTORY_CATEGORIES.indexOf(it.category) === -1) return 'Invalid category: ' + (it && it.category);
    const blank = it.quantity === '' || it.quantity === null || it.quantity === undefined;
    if (blank) continue;                       // skipped server-side
    if (!isValidQuantity(it.quantity)) return 'quantity must be a number ≥ 0 (' + it.item + ')';
    filled++;
  }
  if (filled === 0) return 'No quantities filled';
  return null;
}

// ---- Catalog grouping ----

/** Group active catalog rows by category, preserving INVENTORY_CATEGORIES order. */
export function groupCatalog(rows) {
  const out = {};
  for (const cat of INVENTORY_CATEGORIES) out[cat] = [];
  for (const r of rows || []) {
    if (!r || !r.item_text) continue;
    if (String(r.active).toUpperCase() === 'FALSE') continue;   // hidden item
    if (!Object.prototype.hasOwnProperty.call(out, r.category)) continue;
    out[r.category].push(r.item_text);
  }
  return out;
}

// ---- Latest-count resolution (re-submission supersedes, history preserved) ----

/**
 * From flat InventoryCounts rows, return the LATEST count for a given house+week:
 * { count_id, counted_by, counted_at, items: [{category,item,quantity,notes}] } or null.
 * "Latest" = the count_id whose counted_at is greatest (re-submissions supersede).
 */
export function latestCountFor(rows, house, week) {
  const mine = (rows || []).filter((r) =>
    r && String(r.house) === String(house) && String(r.week_start) === String(week));
  if (mine.length === 0) return null;
  let winner = null;
  for (const r of mine) {
    if (!winner || String(r.counted_at) > String(winner.counted_at)) winner = r;
  }
  const items = mine.filter((r) => r.count_id === winner.count_id)
    .map((r) => ({ category: r.category, item: r.item, quantity: r.quantity, notes: r.notes || '' }));
  return { count_id: winner.count_id, counted_by: winner.counted_by, counted_at: winner.counted_at, items };
}

/** Latest count per house for a week — for the weekly-status table. Returns { houseName: count|null }. */
export function latestByHouse(rows, houses, week) {
  const out = {};
  for (const h of houses || []) {
    if (!h || !h.name) continue;
    out[h.name] = latestCountFor(rows, h.name, week);
  }
  return out;
}
