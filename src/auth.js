// src/auth.js — write-authorization predicate for the staff /exec actions.
//
// Pure, dependency-free, and mirrored verbatim in apps-script/Code.gs so the exact same
// rule is enforced server-side on the public /exec endpoint (never trust the Node layer).
// The browser never holds the secret: the staff member TYPES the shared code, the server
// verifies it against the STAFF_WRITE_TOKEN Script Property, and it rides along as `token`
// on every staff write.
//
// Fail-closed by design: an unset server secret, or a missing / mismatched client token,
// denies the write.

// Write actions that require the staff token. `createRequest` is deliberately ABSENT: it is
// the public intake form (coordinators submit a request without a staff code). Every other
// mutating action is staff-only.
export const STAFF_WRITE_ACTIONS = [
  'approve', 'reject', 'defer', 'assign', 'markExternal', 'assignBatch',
  'setStatus', 'createInspection', 'addFinding', 'confirmFinding',
  'deleteRequest', 'editRequest',
];

/** True when the given POST action must carry a valid staff token. */
export function writeRequiresToken(action) {
  return STAFF_WRITE_ACTIONS.indexOf(action) !== -1;
}

/**
 * Constant-time equality of the provided token against the expected server secret.
 * Fail-closed: returns false if the server secret is unset/empty, if the provided token is
 * empty, or if the lengths differ — only an exact match returns true.
 */
export function tokenOk(provided, expected) {
  if (typeof expected !== 'string' || expected.length === 0) return false;
  if (typeof provided !== 'string' || provided.length === 0) return false;
  if (provided.length !== expected.length) return false;
  var diff = 0;
  for (var i = 0; i < expected.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
