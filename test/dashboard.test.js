// test/dashboard.test.js — locks the increment-3 dashboard UX guarantees that live inline in
// src/dashboard.html (there is no bundler; the board logic is a <script> in the served file, so
// these are structural/static assertions on that source rather than DOM tests).
//
// Two features are guarded:
//   1. In-flight spinners on the action buttons (login-button pattern, #79): every action button
//      hands its element to the handler, and post() disables + spins it while the write is in
//      flight and restores it on failure.
//   2. Immediate board refresh on every status-change write: post() refreshes after a successful
//      write, and the refresh path does not rebuild the house filter (which would duplicate its
//      options on every action).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');

/** Extract the body of a `function name(...) { ... }` declaration by brace matching. */
function functionBody(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, `expected a function named ${name}`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open + 1, i); }
  }
  throw new Error(`unbalanced braces reading ${name}`);
}

// ---- 1. spinner styles present ----

test('spinner CSS and keyframes exist', () => {
  assert.match(html, /\.spinner\s*\{/, 'a .spinner rule must exist');
  assert.match(html, /@keyframes\s+act-spin/, 'the spin animation must be defined');
  // busy buttons stay fully visible so the spinner reads (overrides the dimmed :disabled state).
  assert.match(html, /button\.act\.busy[^{]*\{[^}]*opacity:\s*1/);
});

// ---- 2. every action button hands its element to the handler ----

test('every action button passes `this` to its handler', () => {
  for (const call of [
    /doApprove\('\$\{id\}', this\)/,
    /doReject\('\$\{id\}', this\)/,
    /doDefer\('\$\{id\}', this\)/,
    /doAssign\('\$\{id\}', this\)/,
    /doComplete\('\$\{id\}', this\)/,
    /doSetStatus\('\$\{id\}','\$\{ST\.CLOSED\}', this\)/,
  ]) {
    assert.match(html, call, `button handler should forward the element: ${call}`);
  }
});

test('every action wrapper accepts a btn and forwards it to post()', () => {
  for (const name of ['doApprove', 'doReject', 'doDefer', 'doAssign', 'doComplete', 'doSetStatus']) {
    const re = new RegExp('window\\.' + name + '\\s*=\\s*\\(id(?:, to)?, btn\\)');
    assert.match(html, re, `${name} should take a btn parameter`);
  }
  // Each wrapper passes btn as the trailing argument to post(...).
  assert.match(html, /post\('approve',[^;]*, btn\)/);
  assert.match(html, /post\('setStatus',[^;]*, btn\)/);
});

// ---- 3. startSpinner disables + spins, and returns a restore ----

test('startSpinner disables the button, injects a spinner, and returns a restore', () => {
  const body = functionBody(html, 'startSpinner');
  assert.match(body, /btn\.disabled\s*=\s*true/, 'must disable the button while in flight');
  assert.match(body, /class="spinner"/, 'must inject the spinner element');
  assert.match(body, /return\s*\(\)\s*=>/, 'must return a restore closure');
  assert.match(body, /btn\.disabled\s*=\s*false/, 'restore must re-enable the button');
});

// ---- 4. post() spins on entry and restores only on failure ----

test('post() spins the button and restores it on write failure', () => {
  const body = functionBody(html, 'post');
  assert.match(body, /startSpinner\(btn\)/, 'post must start the spinner for the triggering button');
  // The write-failure branch restores the button so the coordinator can retry.
  assert.match(body, /catch[\s\S]*restore\(\)/, 'a failed write must restore the button');
});

// ---- 5. refresh-on-write wiring (immediate, not scheduled) ----

test('post() refreshes the board after a successful write (not the full load)', () => {
  const body = functionBody(html, 'post');
  assert.match(body, /await refresh\(\)/, 'a successful write must refresh the board immediately');
  assert.doesNotMatch(body, /await load\(\)/, 'post should call refresh(), not the initial full load()');
});

test('refresh() re-fetches requests + config and renders, without rebuilding the house filter', () => {
  const body = functionBody(html, 'refresh');
  assert.match(body, /action=requests/, 'refresh must re-fetch requests');
  assert.match(body, /render\(\)/, 'refresh must re-render');
  // The house filter is populated once in load(); refreshing must not re-append it.
  assert.doesNotMatch(body, /action=houses/, 'refresh must not re-fetch/duplicate the house filter');
});

test('load() populates the house filter exactly once (initial paint)', () => {
  const body = functionBody(html, 'load');
  assert.match(body, /action=houses/, 'initial load populates the house filter');
  assert.match(body, /await refresh\(\)/, 'initial load delegates the board render to refresh()');
});
