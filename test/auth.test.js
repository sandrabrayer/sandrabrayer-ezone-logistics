// test/auth.test.js — locks the HMAC session-token primitives (increment 30).
// The SAME token format is verified independently in apps-script/Code.gs (Utilities-based mirror).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { signToken, verifyToken, checkPin, hashPin, verifyPin } from '../src/auth.js';

const SECRET = 's'.repeat(32);

test('signToken produces payload.signature and carries name + role', () => {
  const t = signToken(SECRET, 7, { name: 'רועי', role: 'field_ops' });
  const [payload, sig] = t.split('.');
  assert.match(sig, /^[0-9a-f]{64}$/);
  const claims = verifyToken(SECRET, t);
  assert.equal(claims.name, 'רועי');
  assert.equal(claims.role, 'field_ops');
  assert.ok(claims.exp > Date.now());
  assert.ok(payload.length > 0);
});

test('signToken throws without a secret (never mint an unverifiable token)', () => {
  assert.throws(() => signToken('', 7, { name: 'x', role: 'ceo' }));
});

test('verifyToken accepts a freshly signed token', () => {
  const claims = verifyToken(SECRET, signToken(SECRET, 1, { name: 'סנדרה', role: 'ceo' }));
  assert.ok(claims);
  assert.equal(claims.role, 'ceo');
});

test('verifyToken rejects a token signed with the wrong secret', () => {
  const forged = signToken('w'.repeat(32), 1, { name: 'x', role: 'ceo' });
  assert.equal(verifyToken(SECRET, forged), null);
});

test('verifyToken rejects an expired token', () => {
  // Forge a well-formed but already-expired token with the real secret.
  const expired = Date.now() - 1000;
  const payload = Buffer.from(JSON.stringify({ n: 'רועי', r: 'field_ops', iat: expired - 1000, exp: expired }))
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  assert.equal(verifyToken(SECRET, `${payload}.${sig}`), null);
});

test('verifyToken rejects a tampered signature', () => {
  const t = signToken(SECRET, 1, { name: 'רועי', role: 'field_ops' });
  const [payload] = t.split('.');
  const badSig = 'a'.repeat(64);
  assert.equal(verifyToken(SECRET, `${payload}.${badSig}`), null);
});

test('verifyToken rejects a tampered payload (role elevation attempt)', () => {
  const t = signToken(SECRET, 1, { name: 'שירה', role: 'coordinator' });
  const sig = t.split('.')[1];
  // Swap in a ceo payload but keep the old signature → must fail.
  const forgedPayload = Buffer.from(JSON.stringify({ n: 'שירה', r: 'ceo', iat: Date.now(), exp: Date.now() + 1e6 }))
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(verifyToken(SECRET, `${forgedPayload}.${sig}`), null);
});

test('verifyToken rejects malformed input safely', () => {
  for (const bad of ['', 'nodot', 'abc.', '.abc', null, undefined, 42, 'abc.zzzz']) {
    assert.equal(verifyToken(SECRET, bad), null);
  }
});

test('verifyToken fails closed on an unset secret', () => {
  const t = signToken(SECRET, 1, { name: 'x', role: 'ceo' });
  assert.equal(verifyToken('', t), null);
});

test('checkPin: exact match only, timing-safe path', () => {
  assert.equal(checkPin('123456', '123456'), true);
  assert.equal(checkPin('123457', '123456'), false);
  assert.equal(checkPin('12345', '123456'), false);   // shorter
  assert.equal(checkPin('1234567', '123456'), false); // longer
  assert.equal(checkPin('', ''), false);              // empty expected PIN never authenticates
  assert.equal(checkPin(null, '123456'), false);
  assert.equal(checkPin('123456', null), false);
  assert.equal(checkPin('anything', ''), false);      // server PIN not configured → deny
});

// ---- token carries the house/cluster scope (increment 31) ----

test('signToken carries the scope claim; verifyToken returns it', () => {
  const t = signToken(SECRET, 7, { name: 'שירה', role: 'coordinator', scope: 'קיסריה עפרוני' });
  const claims = verifyToken(SECRET, t);
  assert.equal(claims.name, 'שירה');
  assert.equal(claims.role, 'coordinator');
  assert.equal(claims.scope, 'קיסריה עפרוני');
});

test('scope defaults to empty (managers) when omitted', () => {
  const claims = verifyToken(SECRET, signToken(SECRET, 7, { name: 'רועי', role: 'field_ops' }));
  assert.equal(claims.scope, '');
});

// ---- per-user password hashing (tier A) ----

test('hashPin → verifyPin round-trip; wrong password fails', () => {
  const stored = hashPin('correct horse battery');
  assert.match(stored, /^pbkdf2\$sha256\$\d+\$[0-9a-f]+\$[0-9a-f]+$/);
  assert.equal(verifyPin('correct horse battery', stored), true);
  assert.equal(verifyPin('wrong', stored), false);
  assert.equal(verifyPin('', stored), false);
});

test('hashPin never returns the plaintext, and salts (two hashes of the same password differ)', () => {
  const a = hashPin('same-password');
  const b = hashPin('same-password');
  assert.ok(!a.includes('same-password'));
  assert.notEqual(a, b);                  // random salt → different strings
  assert.equal(verifyPin('same-password', a), true);
  assert.equal(verifyPin('same-password', b), true);
});

test('verifyPin fails closed on empty / malformed stored value (no password set → never authenticates)', () => {
  assert.equal(verifyPin('x', ''), false);
  assert.equal(verifyPin('x', 'not-a-hash'), false);
  assert.equal(verifyPin('x', 'pbkdf2$sha256$0$aa$bb'), false); // 0 iterations rejected
  assert.equal(verifyPin('x', null), false);
});

// ---- PBKDF2 parity: pinned to a COMMITTED test vector ----
//
// IMPORTANT — what this test does and does NOT prove:
//   - It proves the NODE side of parity: crypto.pbkdf2Sync (which src/auth.js verifyPin uses)
//     reproduces the committed EXPECTED_PARITY_HASH for a fixed password + salt + iterations, and
//     that verifyPin accepts that vector.
//   - It does NOT run the Apps Script runtime, so by itself it does NOT prove the setUserPin()
//     PBKDF2 in apps-script/setup.gs is correct. (An earlier version of this test re-implemented the
//     algorithm in Node and *claimed* to prove Apps Script parity — it passed while the real
//     Utilities.computeHmacSha256Signature call was throwing on every invocation. That was false
//     assurance; it has been removed.)
//
// Parity with the LIVE Apps Script PBKDF2 is confirmed OUT OF BAND: run verifyPinParity_() in the
// Apps Script editor (same fixed password, salt and iterations) and check its logged hash equals
// EXPECTED_PARITY_HASH below, exactly.
test('PBKDF2 fixed vector: crypto.pbkdf2Sync reproduces the committed hash, and verifyPin accepts it', () => {
  const password = 'סיסמה-Test-1!';                       // fixed vector, Hebrew + ASCII (UTF-8)
  const saltHex = '0102030405060708090a0b0c0d0e0f10';     // fixed 16-byte salt
  const iters = 100000;                                   // must equal setup.gs PBKDF2_ITERS_
  // The vector verifyPinParity_() in apps-script/setup.gs must reproduce when run in the editor:
  const EXPECTED_PARITY_HASH =
    'pbkdf2$sha256$100000$0102030405060708090a0b0c0d0e0f10$0464760692cf4028e8246e00b6cfaca8034e9d292766c4a29cc0dc02efb39dc9';

  const dk = crypto.pbkdf2Sync(password, Buffer.from(saltHex, 'hex'), iters, 32, 'sha256');
  const stored = `pbkdf2$sha256$${iters}$${saltHex}$${dk.toString('hex')}`;
  assert.equal(stored, EXPECTED_PARITY_HASH);             // Node reproduces the committed vector
  assert.equal(verifyPin(password, EXPECTED_PARITY_HASH), true); // and the login path accepts it
});
