// rating.test.js — checklist 1–5 rating → ליקוי/finding rules.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ratingIsDefect, ratingToFinding, RATING_DEFECT_THRESHOLD } from '../src/inspection.js';
import { FINDING_TYPE, CATEGORY } from '../src/schema.js';

test('threshold is 2', () => {
  assert.equal(RATING_DEFECT_THRESHOLD, 2);
});

test('scores 1 and 2 are defects; 3-5 are not', () => {
  assert.equal(ratingIsDefect(1), true);
  assert.equal(ratingIsDefect(2), true);
  assert.equal(ratingIsDefect(3), false);
  assert.equal(ratingIsDefect(4), false);
  assert.equal(ratingIsDefect(5), false);
});

test('blank / invalid scores are not defects', () => {
  assert.equal(ratingIsDefect(''), false);
  assert.equal(ratingIsDefect(null), false);
  assert.equal(ratingIsDefect('abc'), false);
  assert.equal(ratingIsDefect(0), false);
  assert.equal(ratingIsDefect(6), false);
});

test('a score of 1 produces a physical-defect finding routed as a repair', () => {
  const f = ratingToFinding({ domain: 'cleanliness', item: 'תאורה תקינה בכל החדרים', score: 1 });
  assert.ok(f);
  assert.equal(f.finding_type, FINDING_TYPE.PHYSICAL_DEFECT);
  assert.equal(f.suggested_category, CATEGORY.REPAIR);
  assert.equal(f.domain, 'cleanliness');
  assert.match(f.finding_text, /דירוג 1/);
});

test('a score of 3 produces no finding', () => {
  assert.equal(ratingToFinding({ domain: 'kitchen', item: 'בדיקת מחסן', score: 3 }), null);
});
