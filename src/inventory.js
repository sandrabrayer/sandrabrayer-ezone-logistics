// src/inventory.js — pure logic for the monthly inventory count (מלאי), increment 25.
// Dependency-free; validation mirrored verbatim in apps-script/Code.gs (server is the real gate).
//
// Model: one submitted count = { house, month (YYYY-MM), counted_by, items[] }. The backend
// writes one InventoryCounts row PER ITEM, all sharing a count_id. Re-submitting the same
// house+month appends a new count — the latest counted_at wins on display (no destructive edits;
// the sheet keeps full history).

import { INVENTORY_CATEGORIES, INVENTORY_COUNTERS } from './schema.js';

/** Current month as YYYY-MM (the default value of the month picker). */
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

/** True for a countable quantity: a finite number ≥ 0 (string numerics accepted). */
export function isValidQuantity(q) {
  if (q === '' || q === null || q === undefined) return false;
  const n = Number(q);
  return Number.isFinite(n) && n >= 0;
}

/**
 * Validate one submission. Returns null when valid, else a human-readable error string.
 * Items with a BLANK quantity are allowed in the input array (the form sends only filled
 * rows, but the server tolerates blanks by skipping them) — however at least ONE item must
 * carry a valid quantity, and any non-blank quantity must be a number ≥ 0.
 */
export function validateInventorySubmission(p) {
  if (!p || typeof p !== 'object') return 'Missing payload';
  if (!p.house) return 'Missing house';
  if (!isValidMonth(p.month)) return 'month must be YYYY-MM';
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

/**
 * From flat InventoryCounts rows, return the LATEST count for a given house+month:
 * { count_id, counted_by, counted_at, items: [{category,item,quantity,notes}] } or null.
 * "Latest" = the count_id whose counted_at is greatest (re-submissions supersede).
 */
export function latestCountFor(rows, house, month) {
  const mine = (rows || []).filter((r) => r && String(r.house) === String(house) && String(r.month) === String(month));
  if (mine.length === 0) return null;
  let winner = null;
  for (const r of mine) {
    if (!winner || String(r.counted_at) > String(winner.counted_at)) winner = r;
  }
  const items = mine.filter((r) => r.count_id === winner.count_id)
    .map((r) => ({ category: r.category, item: r.item, quantity: r.quantity, notes: r.notes || '' }));
  return { count_id: winner.count_id, counted_by: winner.counted_by, counted_at: winner.counted_at, items };
}

/** Latest count per house for a month — for the summary table. Returns { houseName: count|null }. */
export function latestByHouse(rows, houses, month) {
  const out = {};
  for (const h of houses || []) {
    if (!h || !h.name) continue;
    out[h.name] = latestCountFor(rows, h.name, month);
  }
  return out;
}
