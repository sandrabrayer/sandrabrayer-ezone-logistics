// test/auth.test.js — locks the write-authorization predicate that gates staff /exec writes.
// The same STAFF_WRITE_ACTIONS / tokenOk logic is mirrored into apps-script/Code.gs; this
// suite is the guard that the shared secret is verified fail-closed and that the public
// createRequest intake never requires a staff token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STAFF_WRITE_ACTIONS, writeRequiresToken, tokenOk } from '../src/auth.js';

test('every staff write requires a token; createRequest and reads do not', () => {
  for (const a of STAFF_WRITE_ACTIONS) assert.equal(writeRequiresToken(a), true);
  assert.equal(writeRequiresToken('createRequest'), false); // public intake form
  assert.equal(writeRequiresToken('houses'), false);        // read action
  assert.equal(writeRequiresToken('requests'), false);      // read action
  assert.equal(writeRequiresToken(''), false);
  assert.equal(writeRequiresToken(undefined), false);
});

test('the staff write set is exactly the mutating actions minus public createRequest', () => {
  assert.deepEqual([...STAFF_WRITE_ACTIONS].sort(), [
    'addFinding', 'approve', 'assign', 'assignBatch', 'confirmFinding', 'createInspection',
    'defer', 'deleteRequest', 'editRequest', 'markExternal', 'reject', 'setStatus',
  ]);
});

test('tokenOk: only an exact match passes', () => {
  assert.equal(tokenOk('s3cret-code', 's3cret-code'), true);
  assert.equal(tokenOk('s3cret-cod3', 's3cret-code'), false);
  assert.equal(tokenOk('s3cret-cod', 's3cret-code'), false);  // length mismatch (shorter)
  assert.equal(tokenOk('s3cret-codex', 's3cret-code'), false); // length mismatch (longer)
});

test('tokenOk fails closed on an unset server secret or a missing client token', () => {
  assert.equal(tokenOk('anything', ''), false);        // server secret not configured → deny
  assert.equal(tokenOk('', 's3cret-code'), false);     // no client token → deny
  assert.equal(tokenOk('', ''), false);
  assert.equal(tokenOk(undefined, 's3cret-code'), false);
  assert.equal(tokenOk('s3cret-code', undefined), false);
  assert.equal(tokenOk(null, null), false);
});
