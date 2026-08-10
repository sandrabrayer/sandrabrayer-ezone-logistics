// test/batching.test.js — smart batching by trade × cluster (§10).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  houseClusterMap, isBatchable, suggestBatches, makeBatchId,
} from '../src/batching.js';

const HOUSES = [
  { name: 'רעננה', cluster: 'sharon' },
  { name: 'רמות השבים', cluster: 'sharon' },
  { name: 'קיסריה עפרוני', cluster: 'caesarea' },
  { name: 'שדה אליעזר', cluster: 'north' },
];

function ext(over) {
  return { status: 'מאושר', assignment_type: 'external', trade: 'אינסטלטור', batch_id: '', house: 'רעננה', ...over };
}

test('houseClusterMap maps house to cluster', () => {
  const m = houseClusterMap(HOUSES);
  assert.equal(m['רעננה'], 'sharon');
  assert.equal(m['שדה אליעזר'], 'north');
});

test('isBatchable requires approved + external + trade + unbatched', () => {
  assert.equal(isBatchable(ext()), true);
  assert.equal(isBatchable(ext({ status: 'דרישה' })), false);          // not approved
  assert.equal(isBatchable(ext({ assignment_type: 'internal' })), false); // internal
  assert.equal(isBatchable(ext({ trade: '' })), false);                // no trade
  assert.equal(isBatchable(ext({ batch_id: 'B1' })), false);           // already batched
});

test('same trade + same cluster batch together', () => {
  const reqs = [
    ext({ id: 'A', house: 'רעננה' }),
    ext({ id: 'B', house: 'רמות השבים' }), // both sharon, both plumbing
  ];
  const batches = suggestBatches(reqs, HOUSES);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].trade, 'אינסטלטור');
  assert.equal(batches[0].cluster, 'sharon');
  assert.deepEqual(batches[0].requests.map((r) => r.id).sort(), ['A', 'B']);
});

test('different cluster does NOT batch (Sharon vs Caesarea)', () => {
  const reqs = [
    ext({ id: 'A', house: 'רעננה' }),          // sharon
    ext({ id: 'B', house: 'קיסריה עפרוני' }),  // caesarea
  ];
  assert.equal(suggestBatches(reqs, HOUSES).length, 0); // each alone → no batch
});

test('different trade does NOT batch (plumber vs electrician, same cluster)', () => {
  const reqs = [
    ext({ id: 'A', house: 'רעננה', trade: 'אינסטלטור' }),
    ext({ id: 'B', house: 'רמות השבים', trade: 'חשמלאי' }),
  ];
  assert.equal(suggestBatches(reqs, HOUSES).length, 0);
});

test('a single eligible request is not a batch', () => {
  assert.equal(suggestBatches([ext({ id: 'A' })], HOUSES).length, 0);
});

test('largest batch is suggested first', () => {
  const reqs = [
    ext({ id: 'P1', house: 'רעננה', trade: 'אינסטלטור' }),
    ext({ id: 'P2', house: 'רמות השבים', trade: 'אינסטלטור' }),
    ext({ id: 'P3', house: 'רעננה', trade: 'אינסטלטור' }),
    ext({ id: 'E1', house: 'רעננה', trade: 'חשמלאי' }),
    ext({ id: 'E2', house: 'רמות השבים', trade: 'חשמלאי' }),
  ];
  const batches = suggestBatches(reqs, HOUSES);
  assert.equal(batches.length, 2);
  assert.equal(batches[0].trade, 'אינסטלטור'); // 3 > 2
  assert.equal(batches[0].requests.length, 3);
  assert.equal(batches[1].requests.length, 2);
});

test('makeBatchId encodes the cluster', () => {
  assert.match(makeBatchId('אינסטלטור', 'sharon'), /^BATCH-sharon-/);
});
