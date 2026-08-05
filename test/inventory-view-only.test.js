// test/inventory-view-only.test.js — PR B: non-food inventory COUNTING moved to the Coordinators app.
// The Logistics inventory page keeps the data VIEW (מצב שבועי) but no longer offers a count-entry form.
// This guards that the count form (and its write action) is gone, while the status view stays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'inventory.html'), 'utf8');

test('the count-entry form is removed: no submit action, no submit button, no form renderer', () => {
  assert.ok(!html.includes('submitInventory'), 'the submitInventory write action must be gone from the page');
  assert.ok(!html.includes('submitCount'), 'the submit handler must be gone');
  assert.ok(!html.includes('renderCountForm'), 'the count-form renderer must be gone');
  assert.ok(!html.includes('שליחת ספירה'), 'the "send count" button label must be gone');
  assert.ok(!html.includes('counterSel'), 'the "counted by" control (form-only) must be gone');
});

test('the weekly status VIEW is kept (read-only data still renders)', () => {
  assert.ok(html.includes('renderStatus'), 'the status view renderer stays');
  assert.ok(html.includes('מצב שבועי'), 'the weekly-status view stays');
  assert.ok(html.includes('pageData&page=inventory'), 'still loads the inventory read data');
});

test('the page advertises that counting moved to the coordinators app', () => {
  assert.ok(/הרכזים/.test(html), 'the page explains counting moved to the coordinators app');
});
