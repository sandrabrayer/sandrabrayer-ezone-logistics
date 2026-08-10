// batching.js — pure, testable smart-batching logic (§10).
//
// When several open requests need an EXTERNAL technician, the app suggests grouping them into one
// visit. A batch is keyed by TRADE × CLUSTER: same trade (חשמלאי / אינסטלטור / …) AND same
// proximity cluster (sharon / caesarea / north). Two plumbing jobs in Sharon batch together; a
// plumbing job in Sharon and one in Caesarea do NOT (different clusters), and a plumbing job and
// an electrical job in Sharon do NOT (different trades).
//
// IMPORTANT (locked distinction, §4): cluster ≠ maintenance lead. Tzachi covers both caesarea and
// north, but those are separate clusters — a far-north visit is never batched with the coastal two.
//
// A request is batchable when it is approved, external, has a trade, and isn't already batched.
// Pure JS (no Apps Script/DOM) so node:test verifies it. Code.gs/dashboard mirror the rule.

const STATUS_APPROVED = 'מאושר';

/** Map house name → cluster, from Houses rows. */
export function houseClusterMap(houses) {
  const map = {};
  (houses || []).forEach((h) => { if (h && h.name) map[h.name] = h.cluster || ''; });
  return map;
}

/** A request is eligible for batching: approved, external, has a trade, not yet batched. */
export function isBatchable(r) {
  return !!r
    && r.status === STATUS_APPROVED
    && r.assignment_type === 'external'
    && !!r.trade
    && !r.batch_id;
}

/**
 * Build batch suggestions from open external requests, grouped by trade × cluster.
 * Only groups with 2+ requests are returned (a single job isn't a "batch").
 *
 * @param {Array} requests  all request rows
 * @param {Array} houses    house rows (to resolve each request's cluster)
 * @returns {Array<{key:string, trade:string, cluster:string, requests:Array}>}
 *          sorted by size (largest batch first), then trade.
 */
export function suggestBatches(requests, houses) {
  const cluster = houseClusterMap(houses);
  const groups = {};
  (requests || []).forEach((r) => {
    if (!isBatchable(r)) return;
    const cl = cluster[r.house] || '';
    if (!cl) return;
    const key = r.trade + '|' + cl;
    (groups[key] = groups[key] || { key, trade: r.trade, cluster: cl, requests: [] }).requests.push(r);
  });

  return Object.values(groups)
    .filter((g) => g.requests.length >= 2)
    .sort((a, b) => (b.requests.length - a.requests.length) || a.trade.localeCompare(b.trade, 'he'));
}

/** Deterministic batch id for a trade × cluster group (UI may override). */
export function makeBatchId(trade, cluster) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return 'BATCH-' + cluster + '-' + stamp;
}
