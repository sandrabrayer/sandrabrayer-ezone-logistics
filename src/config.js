// config.js — centralized type coercion for Config values.
//
// WHY THIS EXISTS: Google Apps Script reads every Sheet cell as a string. If callers compared
// estimated_cost against a raw "3000" string, `cost > "3000"` would coerce unpredictably and the
// approval routing — the heart of the app — could misfire silently. So coercion lives in ONE
// place. No caller ever sees a raw Config string for a known-typed key.
//
// This module is pure JS (no Apps Script APIs) so it runs under node:test. Code.gs mirrors the
// same NUMERIC_KEYS / BOOLEAN_KEYS lists and the same rule.

export const NUMERIC_KEYS = new Set([
  'approval_threshold',
  'batching_window_days', // reserved for the batching increment
]);

export const BOOLEAN_KEYS = new Set([
  'emergency_bypasses_approval',
]);

// Truthy spellings accepted from the Sheet for boolean keys.
const TRUE_STRINGS = new Set(['true', 'TRUE', 'True', '1', 'yes', 'YES']);

/**
 * Coerce a single raw Config value (always a string from the Sheet) to its intended type.
 * @param {string} key
 * @param {string} rawValue
 * @returns {number|boolean|string}
 */
export function coerceConfigValue(key, rawValue) {
  if (NUMERIC_KEYS.has(key)) {
    const n = Number(rawValue);
    if (Number.isNaN(n)) {
      throw new Error(`Config key "${key}" expected a number but got "${rawValue}"`);
    }
    return n;
  }
  if (BOOLEAN_KEYS.has(key)) {
    return TRUE_STRINGS.has(String(rawValue).trim());
  }
  return rawValue;
}

/**
 * Coerce a whole key/value map of raw Config strings.
 * @param {Record<string,string>} raw
 * @returns {Record<string, number|boolean|string>}
 */
export function coerceConfig(raw) {
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key] = coerceConfigValue(key, value);
  }
  return out;
}
