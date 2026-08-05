// src/auth.js — HMAC-signed session tokens for the identity-based auth (increment 30).
//
// Same standard as ezone-managers / ezone-staffing (lib/auth.js there), EXTENDED to carry identity:
// the logistics token embeds the user's name + role + issued-at so role enforcement has an identity
// to resolve the actor from. Replaces the old shared STAFF_WRITE_TOKEN scheme (deleted), which
// carried no identity.
//
// SERVER-ONLY module: it holds the signing/verification logic and must never be served to the
// browser. The browser only ever holds the opaque token string it receives from POST /api/login.
//
// Token format (JWT-like, but minimal and dependency-free):
//   "<payloadB64url>.<hmacSha256Hex>"
//   payloadB64url = base64url(JSON.stringify({ n:<name>, r:<role>, iat:<ms>, exp:<ms> }))  (no '=')
//   hmac          = HMAC-SHA256(payloadB64url) keyed by SESSION_SECRET, lowercase hex
//
// apps-script/Code.gs verifies this SAME token independently (Utilities.computeHmacSha256Signature
// + Utilities.base64DecodeWebSafe) using the SESSION_SECRET Script Property — the Node layer is
// never trusted.

import crypto from 'node:crypto';

const DEFAULT_DAYS = 7;

// ---- Per-user password hashing (increment 31, tier A: רועי / אולגה) ----
// PBKDF2-HMAC-SHA256, salted. Stored string format (in the Users.pin_hash column):
//   pbkdf2$sha256$<iterations>$<saltHex>$<hashHex>
// The iteration count is stored IN the string so verification always matches whatever produced it
// (Node here, or the setUserPin() Apps Script helper). A single 32-byte block, so the PBKDF2 output
// equals F(salt,iters,1) = U1 xor … xor Uc — the exact algorithm setUserPin() mirrors.
const PBKDF2_ITERS = 100000;
const PBKDF2_KEYLEN = 32;
const PBKDF2_DIGEST = 'sha256';

/** Hash a plaintext password. NEVER stores or returns the plaintext. */
export function hashPin(plaintext, iterations) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('hashPin: plaintext password required');
  }
  const iters = Number(iterations) > 0 ? Math.floor(Number(iterations)) : PBKDF2_ITERS;
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(plaintext, salt, iters, PBKDF2_KEYLEN, PBKDF2_DIGEST);
  return `pbkdf2$sha256$${iters}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/**
 * Constant-time verify of a plaintext against a stored pbkdf2 string. Fail-closed: false on an
 * empty/malformed stored value (so a user with no password set can never authenticate).
 */
export function verifyPin(plaintext, stored) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) return false;
  if (typeof stored !== 'string' || stored.length === 0) return false;
  const parts = stored.split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') return false;
  const iters = Number(parts[2]);
  if (!Number.isFinite(iters) || iters <= 0) return false;
  let salt, expected;
  try {
    salt = Buffer.from(parts[3], 'hex');
    expected = Buffer.from(parts[4], 'hex');
  } catch (e) { return false; }
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = crypto.pbkdf2Sync(plaintext, salt, iters, expected.length, PBKDF2_DIGEST);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hmacHex(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

/**
 * Sign a session token carrying identity. Fail-closed: throws if the secret is unset (a missing
 * secret must never silently mint an unverifiable token).
 * @param {string} secret  SESSION_SECRET
 * @param {number} days    SESSION_DAYS (token lifetime)
 * @param {{name:string, role:string, scope?:string}} claims  scope = house/cluster scope (tier B)
 */
export function signToken(secret, days, claims) {
  if (!secret) throw new Error('SESSION_SECRET is not set');
  const name = (claims && claims.name) || '';
  const role = (claims && claims.role) || '';
  const scope = (claims && claims.scope != null) ? String(claims.scope) : '';
  const ttlMs = (Number(days) || DEFAULT_DAYS) * 24 * 60 * 60 * 1000;
  const iat = Date.now();
  const exp = iat + ttlMs;
  const payload = b64url(JSON.stringify({ n: name, r: role, sc: scope, iat, exp }));
  const sig = hmacHex(secret, payload);
  return `${payload}.${sig}`;
}

/**
 * Verify a token and return its decoded claims, or null on any failure (missing/empty secret,
 * malformed token, bad signature, expired). Uses a constant-time signature comparison.
 * @returns {{name:string, role:string, iat:number, exp:number}|null}
 */
export function verifyToken(secret, token) {
  if (!secret || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^[0-9a-f]{64}$/.test(sig)) return null;
  const expected = hmacHex(secret, payload);
  // Constant-time compare; both are fixed 64-char hex so lengths already match.
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let claims;
  try {
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    claims = JSON.parse(json);
  } catch (e) {
    return null;
  }
  if (!claims || typeof claims !== 'object') return null;
  if (!Number.isFinite(claims.exp) || claims.exp < Date.now()) return null;
  return { name: claims.n || '', role: claims.r || '', scope: claims.sc || '', iat: claims.iat, exp: claims.exp };
}

/**
 * Constant-time PIN equality. Fail-closed: false on a non-string, an empty expected PIN, or a
 * length mismatch — only an exact match returns true. Never echoes the PIN.
 */
export function checkPin(input, expected) {
  if (typeof input !== 'string' || typeof expected !== 'string') return false;
  if (!expected) return false;
  const a = Buffer.from(input);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Server-to-server proof for the login roster read. The Users sheet holds pin_hash, and the Apps
 * Script /exec endpoint is world-callable, so the hash-bearing roster is returned ONLY to a caller
 * that presents this HMAC(SESSION_SECRET, 'roster:users') proof. Node (which shares SESSION_SECRET
 * with Apps Script) computes it here; Code.gs recomputes and compares it. The raw secret never
 * appears in a URL. Public `users` reads omit the proof and get pin_hash stripped.
 */
export function rosterProof(secret) {
  if (!secret) return '';
  return hmacHex(secret, 'roster:users');
}

/**
 * Server-to-server proof for the PUBLIC request submit (entry-flow redesign). The request form is
 * reachable WITHOUT a login, so its submit has no session token — but the Apps Script /exec endpoint is
 * world-callable, so an unauthenticated createRequestPublic must NOT be invokable by just anyone who has
 * the /exec URL. The Node gateway (which shares SESSION_SECRET with Apps Script) presents this
 * HMAC(SESSION_SECRET, 'submit:request') proof; Code.gs recomputes and compares it, so ONLY the Node
 * gateway can drive the unauthenticated create. The raw secret never appears in a request body. Mirrors
 * the rosterProof pattern. '' when the secret is unset (fail-closed: Code.gs then rejects every submit).
 */
export function submitProof(secret) {
  if (!secret) return '';
  return hmacHex(secret, 'submit:request');
}

export { DEFAULT_DAYS };
