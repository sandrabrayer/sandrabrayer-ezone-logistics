// test/mirror-drift.test.js — the guard that the pure logic in src/roles.js + src/approval.js is
// mirrored VERBATIM (logic-for-logic) inside apps-script/Code.gs. Drift between the Node modules and
// the Apps Script copy has caused bugs before; this test fails loudly the moment they diverge.
//
// Each mirrored region is fenced by matching markers in BOTH files:
//   // === MIRROR:<name> START ===  ...  // === MIRROR:<name> END ===
// We extract the fenced text from each side, strip comments + collapse whitespace (so comment and
// formatting differences are allowed, but any change to the actual code fails), and assert equality.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function readBlock(file, name) {
  const src = readFileSync(join(root, file), 'utf8');
  const start = `// === MIRROR:${name} START ===`;
  const end = `// === MIRROR:${name} END ===`;
  const i = src.indexOf(start);
  const j = src.indexOf(end);
  assert.ok(i !== -1, `missing "${start}" in ${file}`);
  assert.ok(j !== -1 && j > i, `missing "${end}" in ${file}`);
  return src.slice(i + start.length, j);
}

// Strip line + block comments, drop a leading `export ` keyword, and collapse all whitespace so the
// comparison is on code/logic only.
function normalize(block) {
  return block
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // block comments
    .replace(/\/\/[^\n]*/g, ' ')         // line comments
    .replace(/\bexport\s+/g, ' ')        // ESM export keyword (Code.gs has none)
    .replace(/\s+/g, ' ')                // collapse whitespace
    .trim();
}

test('roles.js MIRROR:roles matches apps-script/Code.gs', () => {
  const a = normalize(readBlock('src/roles.js', 'roles'));
  const b = normalize(readBlock('apps-script/Code.gs', 'roles'));
  assert.ok(a.length > 0);
  assert.equal(a, b);
});

test('approval.js MIRROR:approval matches apps-script/Code.gs', () => {
  const a = normalize(readBlock('src/approval.js', 'approval'));
  const b = normalize(readBlock('apps-script/Code.gs', 'approval'));
  assert.ok(a.length > 0);
  assert.equal(a, b);
});
