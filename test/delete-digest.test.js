// test/delete-digest.test.js — confirms (task 3) that deleting a request also removes it from the
// coordinators' OpenTickets digest on the next rebuild, so a junk/test request stops being seen.
//
// The digest is a FULL wipe-and-rewrite from the LIVE Requests rows (buildOpenTicketRows_ reads the
// sheet fresh each time), and handleDeleteRequest_ deletes the row from Requests and THEN calls
// rebuildDigest(). Together that means a deleted request has no row to rebuild from → it cannot appear
// in OpenTickets. This is a source-level guard (the handlers live in Apps Script, exercised in prod);
// it locks the wiring so a future refactor can't silently reintroduce ghost tickets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const code = readFileSync(join(root, 'apps-script/Code.gs'), 'utf8');
const digest = readFileSync(join(root, 'apps-script/digest.gs'), 'utf8');

function fnBody(src, signature) {
  const start = src.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { i++; break; }
  }
  return src.slice(start, i);
}

test('handleDeleteRequest_ removes the Requests row AND rebuilds the digest', () => {
  const body = fnBody(code, 'function handleDeleteRequest_(');
  assert.match(body, /deleteRow\(/, 'delete must remove the request row from the sheet');
  assert.match(body, /rebuildDigest\(\)/, 'delete must trigger a digest rebuild so it propagates');
  // the deletion is audited before the row is gone (never a silent removal)
  assert.match(body, /writeAuditEntry\(/);
});

test('the rebuild runs SYNCHRONOUSLY in the same handler — deleteRow first, then rebuildDigest, then return', () => {
  // Apps Script is synchronous: rebuildDigest() completes before the handler returns its JSON response, so
  // the digest is already rebuilt by the time the delete call resolves — exactly like every other mutation
  // (approve/reject/defer/setStatus all call rebuildDigest() before returning). Any lag a coordinator sees
  // is their app's read cache (~5 min), NOT a missing rebuild.
  const body = fnBody(code, 'function handleDeleteRequest_(');
  const iDelete = body.indexOf('deleteRow(');
  const iRebuild = body.indexOf('rebuildDigest()');
  const iReturn = body.indexOf('return jsonOut_({ ok: true })');
  assert.ok(iDelete !== -1 && iRebuild !== -1 && iReturn !== -1, 'all three steps present');
  assert.ok(iDelete < iRebuild, 'the row is removed before the rebuild');
  assert.ok(iRebuild < iReturn, 'the rebuild completes before the success response returns');
});

test('the digest rebuild reads LIVE Requests rows (a deleted row cannot survive it)', () => {
  const body = fnBody(digest, 'function buildOpenTicketRows_(');
  assert.match(body, /readObjects_\('Requests'\)/, 'OpenTickets is built from the current Requests rows');
});

test('rebuildDigest wipes and rewrites the OpenTickets tab (full rebuild, not append)', () => {
  const body = fnBody(digest, 'function rebuildDigest(');
  assert.match(body, /DIGEST_TAB_OPEN_/);
  assert.match(body, /buildOpenTicketRows_\(\)/);
  // digestWriteRows_ clears prior rows before writing — so removed tickets don't linger
  const writer = fnBody(digest, 'function digestWriteRows_(');
  assert.match(writer, /clearContent\(\)/);
});
