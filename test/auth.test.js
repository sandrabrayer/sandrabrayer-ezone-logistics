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

// ---- PBKDF2 GAS-parity: the setUserPin() Apps Script algorithm equals crypto.pbkdf2Sync ----
// Re-implements the setup.gs pbkdf2Sha256_ using node HMAC in place of Utilities, then asserts it
// matches crypto.pbkdf2Sync byte-for-byte. This is the guard that a hash written by the Apps Script
// helper verifies in Node. (A small iteration count keeps the test fast; the loop is identical at
// any count, so correctness carries to the deployed 100000.)
test('setup.gs PBKDF2 (single 32-byte block) matches crypto.pbkdf2Sync', () => {
  function gasPbkdf2(password, saltBytes, iterations) {
    const hmac = (msgBytes, keyStr) => Array.from(
      crypto.createHmac('sha256', keyStr).update(Buffer.from(msgBytes.map((b) => b & 0xff))).digest()
    );
    const block = saltBytes.concat([0, 0, 0, 1]);
    let u = hmac(block, password);
    const t = u.map((b) => b & 0xff);
    for (let i = 1; i < iterations; i++) {
      u = hmac(u, password);
      for (let j = 0; j < t.length; j++) t[j] = (t[j] ^ u[j]) & 0xff;
    }
    return Buffer.from(t);
  }
  const password = 'a-manager-password';
  const salt = Array.from(crypto.randomBytes(16));
  const iters = 2000;
  const mine = gasPbkdf2(password, salt, iters);
  const ref = crypto.pbkdf2Sync(password, Buffer.from(salt), iters, 32, 'sha256');
  assert.equal(mine.toString('hex'), ref.toString('hex'));
  // And a hash produced this way verifies with verifyPin:
  const stored = `pbkdf2$sha256$${iters}$${Buffer.from(salt).toString('hex')}$${mine.toString('hex')}`;
  assert.equal(verifyPin(password, stored), true);
});
