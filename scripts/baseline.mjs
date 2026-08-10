#!/usr/bin/env node
// scripts/baseline.mjs — the baseline gate. Run via `npm run baseline`.
//
// WHY: work on this repo has repeatedly started from a wrong assumption about what is already on `main`
// (a merged PR whose CHANGELOG entry got dropped, a test count that drifted). This script pins the
// expected state in a committed BASELINE.md and fails loudly the moment reality diverges — so every task
// can gate on it before starting, and every PR re-anchors it (see .github/PULL_REQUEST_TEMPLATE.md).
//
// WHAT it checks:
//   1. The top 3 CHANGELOG.md headings (verbatim `## …` lines) match BASELINE.md.
//   2. The passing test count from `npm test` matches BASELINE.md.
// It also fetches origin/main (best-effort) and reports whether the local CHANGELOG top heading differs
// from origin/main's, so a stale checkout is visible. Exit code is non-zero on any tracked mismatch.

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHANGELOG = join(root, 'CHANGELOG.md');
const BASELINE = join(root, 'BASELINE.md');

const HEADING_COUNT = 3;

function topHeadings(markdown, n) {
  return markdown.split('\n').filter((l) => l.startsWith('## ')).slice(0, n).map((l) => l.trim());
}

/** Parse BASELINE.md: the numbered heading lines and the `tests-passing:` count. */
function parseBaseline(md) {
  const headings = [];
  for (const line of md.split('\n')) {
    const m = line.match(/^\d+\.\s+(##\s+.*\S)\s*$/);
    if (m) headings.push(m[1].trim());
  }
  const tm = md.match(/tests-passing:\s*(\d+)/);
  return { headings: headings.slice(0, HEADING_COUNT), testsPassing: tm ? Number(tm[1]) : null };
}

/** Run the unit suite and return { passing, failing }. Captures output even when tests fail (non-zero exit). */
function runTests() {
  let out = '';
  try {
    out = execSync('npm test', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    out = `${e.stdout || ''}${e.stderr || ''}`;
  }
  const pass = out.match(/^# pass (\d+)/m);
  const fail = out.match(/^# fail (\d+)/m);
  return { passing: pass ? Number(pass[1]) : null, failing: fail ? Number(fail[1]) : null };
}

function fetchMainHeading() {
  try {
    execSync('git fetch --depth 1 origin main', { cwd: root, stdio: 'ignore' });
    const remote = execSync('git show FETCH_HEAD:CHANGELOG.md', { cwd: root, encoding: 'utf8' });
    return topHeadings(remote, 1)[0] || null;
  } catch {
    return undefined; // undefined = fetch unavailable (offline / no remote); null = fetched but no heading
  }
}

// ---- gather actual state ----
const changelog = readFileSync(CHANGELOG, 'utf8');
const actualHeadings = topHeadings(changelog, HEADING_COUNT);
const { passing, failing } = runTests();

let expected;
try {
  expected = parseBaseline(readFileSync(BASELINE, 'utf8'));
} catch {
  console.error('✗ BASELINE.md not found or unreadable — create it (see the PR template checklist).');
  process.exit(2);
}

// ---- report ----
console.log('Baseline check\n==============');
console.log('\nTop %d CHANGELOG headings (actual):', HEADING_COUNT);
actualHeadings.forEach((h, i) => console.log(`  ${i + 1}. ${h}`));
console.log(`\nTests: ${passing == null ? '??' : passing} passing, ${failing == null ? '??' : failing} failing`);

const remoteTop = fetchMainHeading();
if (remoteTop === undefined) console.log('\norigin/main: (fetch unavailable — skipped remote drift check)');
else if (remoteTop !== actualHeadings[0]) {
  console.log(`\n⚠ origin/main top heading differs from local:\n    local:  ${actualHeadings[0]}\n    remote: ${remoteTop}`);
} else console.log('\norigin/main: top heading matches local.');

// ---- compare ----
const problems = [];
if (expected.headings.length !== HEADING_COUNT) {
  problems.push(`BASELINE.md lists ${expected.headings.length} headings; expected ${HEADING_COUNT}.`);
}
for (let i = 0; i < HEADING_COUNT; i++) {
  if (actualHeadings[i] !== expected.headings[i]) {
    problems.push(`Heading ${i + 1} mismatch:\n    expected: ${expected.headings[i]}\n    actual:   ${actualHeadings[i]}`);
  }
}
if (failing == null || failing > 0) problems.push(`Test suite is not green (failing: ${failing}).`);
if (expected.testsPassing == null) problems.push('BASELINE.md has no `tests-passing:` count.');
else if (passing !== expected.testsPassing) {
  problems.push(`Test count mismatch: BASELINE.md expects ${expected.testsPassing} passing, got ${passing}.`);
}

if (problems.length) {
  console.error('\n✗ BASELINE MISMATCH — do not proceed until reconciled:');
  for (const p of problems) console.error('  - ' + p);
  console.error('\nIf this change is intentional, update BASELINE.md (PR checklist) and re-run.');
  process.exit(1);
}

console.log('\n✓ Baseline matches BASELINE.md.');
