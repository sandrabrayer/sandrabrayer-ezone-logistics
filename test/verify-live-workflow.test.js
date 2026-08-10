// test/verify-live-workflow.test.js — guards the "Verify Live (Railway Node leg)" workflow's deploy-aware
// gating. The workflow must FAIL loudly when a real code push isn't served live, but must NOT fail when a
// push changes nothing Railway deploys (Railway skips redeploying an identical build, so /version keeps
// returning the previous SHA — the false failure this logic fixes, e.g. the tests-only merge 0967c41).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WF = readFileSync(join(ROOT, '.github/workflows/verify-live.yml'), 'utf8');

// Pull the runtime path filter straight out of the workflow so the test tracks the real value, not a copy.
const RUNTIME_RE = (() => {
  const m = WF.match(/RUNTIME_RE='([^']+)'/);
  assert.ok(m, "workflow must define a RUNTIME_RE path filter");
  return new RegExp(m[1]);
})();

test('the runtime path filter matches what Railway actually deploys', () => {
  for (const p of ['src/server.js', 'src/public/sw.js', 'src/dashboard.html', 'package.json', 'package-lock.json']) {
    assert.ok(RUNTIME_RE.test(p), `${p} must count as a Railway-deployed (runtime) path`);
  }
});

test('the runtime filter ignores files Railway does NOT deploy (no false redeploy demand)', () => {
  // The exact file set of the tests-only merge 0967c41 that this fix targets, plus other non-runtime files.
  for (const p of [
    '.github/workflows/test.yml', 'BASELINE.md', 'CHANGELOG.md', 'README.md', 'test/server.test.js',
    'apps-script/Code.gs', 'DEPLOY.md', 'scripts/baseline.mjs', '.gitignore',
  ]) {
    assert.ok(!RUNTIME_RE.test(p), `${p} must NOT trigger a required Railway redeploy`);
  }
});

test('the real 0967c41 change set (tests + docs only) classifies as non-runtime', () => {
  const merge0967c41 = ['.github/workflows/test.yml', 'BASELINE.md', 'CHANGELOG.md', 'README.md', 'test/server.test.js'];
  assert.equal(merge0967c41.some((p) => RUNTIME_RE.test(p)), false,
    'a tests/docs-only push must not require the live build to advance to its SHA');
});

test('a src/ change flips the same push to runtime (strict gate re-armed)', () => {
  const codePush = ['src/server.js', 'test/server.test.js', 'CHANGELOG.md'];
  assert.equal(codePush.some((p) => RUNTIME_RE.test(p)), true,
    'any src/ change must require the live build to serve the new SHA');
});

test('the workflow has a detect step plus BOTH a strict and a liveness verify step', () => {
  assert.match(WF, /id:\s*detect/, 'a detect step computes whether runtime paths changed');
  assert.match(WF, /runtime_changed=true/, 'detect can report a runtime change');
  assert.match(WF, /runtime_changed=false/, 'detect can report no runtime change');
  // Strict leg: runs only when runtime changed, and gates on the exact deploy SHA.
  assert.match(WF, /if:\s*steps\.detect\.outputs\.runtime_changed == 'true'/, 'strict leg is gated on a runtime change');
  assert.match(WF, /EXPECTED_COMMIT:\s*\$\{\{ github\.sha \}\}/, 'strict leg asserts the live build serves this exact SHA');
  // Liveness leg: runs only when nothing runtime changed, and must NOT gate on the SHA.
  assert.match(WF, /if:\s*steps\.detect\.outputs\.runtime_changed == 'false'/, 'liveness leg runs when no runtime path changed');
  assert.match(WF, /unset EXPECTED_COMMIT/, 'liveness leg drops the SHA gate so a skipped redeploy does not fail the run');
});

test('checkout fetches history so the before/after diff is computable', () => {
  assert.match(WF, /fetch-depth:\s*0/, 'a full-history checkout is required to diff the pushed range');
});

test('an unresolvable diff base fails safe (strict), and the live app must always respond', () => {
  // Initial/force push or a root-commit manual run → we cannot diff, so demand the strict SHA gate.
  assert.match(WF, /runtime_changed=true/, 'no resolvable base must default to the strict gate');
  // Both legs still error out loudly if the live site is unreachable.
  assert.ok((WF.match(/::error::/g) || []).length >= 2, 'both the strict and liveness legs must fail loudly on a dead site');
});
