// test/dashboard-defer-label.test.js — the defer action button reads the STATUS word 'נדחה לתאריך'
// (deferred to date), matching the status vocabulary (approval.js / schema.js DEFERRED, the board group
// title, and the status map), not the bare imperative 'דחה לתאריך'. Guards the label from regressing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { STATUSES } from '../src/schema.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'src/dashboard.html'), 'utf8');

test('the defer button label uses the DEFERRED status word', () => {
  assert.equal(STATUSES.DEFERRED, 'נדחה לתאריך');
  // the doDefer button carries the status label…
  assert.match(html, /onclick="doDefer\('\$\{id\}'\)">נדחה לתאריך<\/button>/);
  // …and no button uses the bare imperative form any more
  assert.doesNotMatch(html, />דחה לתאריך<\/button>/);
});
