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
 * @param {{name:string, role:string}} claims
 */
export function signToken(secret, days, claims) {
  if (!secret) throw new Error('SESSION_SECRET is not set');
  const name = (claims && claims.name) || '';
  const role = (claims && claims.role) || '';
  const ttlMs = (Number(days) || DEFAULT_DAYS) * 24 * 60 * 60 * 1000;
  const iat = Date.now();
  const exp = iat + ttlMs;
  const payload = b64url(JSON.stringify({ n: name, r: role, iat, exp }));
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
  return { name: claims.n || '', role: claims.r || '', iat: claims.iat, exp: claims.exp };
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

export { DEFAULT_DAYS };
