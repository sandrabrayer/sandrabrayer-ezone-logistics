// Mobile-responsive pass, step 1: assert every user-facing page carries the
// viewport meta and the ≤640px media block that gives it a mobile layout.
// Pure static assertions on the HTML source — no DOM/render needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');

const PAGES = ['index.html', 'dashboard.html', 'inspection.html', 'reports.html', 'workorders.html'];

for (const page of PAGES) {
  const html = readFileSync(join(srcDir, page), 'utf8');

  test(`${page} declares the responsive viewport meta`, () => {
    assert.match(html, /<meta\s+name="viewport"\s+content="width=device-width/i);
  });

  test(`${page} has the ≤640px mobile media block`, () => {
    assert.match(html, /@media\s*\(\s*max-width:\s*640px\s*\)/);
  });

  test(`${page} mobile block keeps the nav reachable via horizontal scroll`, () => {
    // guards the core intent: the nav row must stay scrollable on small screens
    assert.match(html, /overflow-x:\s*auto/);
  });

  test(`${page} mobile block hard-disables horizontal panning on html/body`, () => {
    // stops some Android devices from loading the page panned sideways
    assert.match(html, /html,\s*body\s*\{[^}]*overflow-x:\s*hidden/);
  });
}

// Step 2 — intake form polish (index.html only).
const indexHtml = readFileSync(join(srcDir, 'index.html'), 'utf8');

test('index.html mobile: seg groups wrap gracefully on narrow screens', () => {
  assert.match(indexHtml, /\.seg\s*\{\s*flex-wrap:\s*wrap/);
  assert.match(indexHtml, /\.seg label\s*\{\s*min-width:\s*0/);
});

test('index.html mobile: submit button gets a ≥48px touch target', () => {
  assert.match(indexHtml, /button\.submit\s*\{\s*min-height:\s*48px/);
});
