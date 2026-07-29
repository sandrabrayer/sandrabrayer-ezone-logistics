// test/auth.test.js — locks the HMAC session-token primitives (increment 30).
// The SAME token format is verified independently in apps-script/Code.gs (Utilities-based mirror).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { signToken, verifyToken, checkPin } from '../src/auth.js';

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
