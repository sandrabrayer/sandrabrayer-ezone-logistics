// test/header.test.js — locks the topbar brand: the app emblem + Hebrew name only.
// Pure static assertions on the HTML source (same style as mobile-css.test.js) — no DOM needed.
//
// The header dropped the "E-ZONE" wordmark. Every page now shows the app's existing PWA emblem
// (/icon-v1-192.png, unchanged/recolour-free) next to the Hebrew app name "לוגיסטיקה", sized
// ~30px on desktop and 28px on mobile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');

// Every user-facing page carries the shared topbar.
const PAGES = ['landing.html', 'request.html', 'login.html', 'status.html', 'dashboard.html', 'inspection.html', 'reports.html', 'workorders.html', 'inventory.html'];

for (const page of PAGES) {
  const html = readFileSync(join(srcDir, page), 'utf8');
  const brand = (html.match(/<div class="brand">[\s\S]*?<\/div>/) || [''])[0];

  test(`${page} topbar has a brand block`, () => {
    assert.ok(brand, `${page} must keep a .brand block in the topbar`);
  });

  test(`${page} brand drops the "E-ZONE" wordmark`, () => {
    assert.ok(!/E-ZONE/i.test(html), `${page} must not contain the E-ZONE text`);
  });

  test(`${page} brand shows the existing PWA emblem next to the name`, () => {
    // The app's existing icon — referenced, not a new/recoloured asset.
    assert.match(brand, /<img[^>]*class="brand-emblem"[^>]*src="\/icon-v1-192\.png"/);
  });

  test(`${page} brand shows the Hebrew app name "לוגיסטיקה"`, () => {
    assert.match(brand, /לוגיסטיקה/);
  });

  test(`${page} emblem is ~30px desktop / 28px mobile`, () => {
    assert.match(html, /\.brand-emblem\s*\{[^}]*width:\s*30px/); // desktop
    assert.match(html, /@media\s*\([^)]*640px[^)]*\)\s*\{[\s\S]*\.brand-emblem\s*\{[^}]*width:\s*28px/); // mobile override
  });

  test(`${page} brand stays on one line (no-wrap, doesn't crowd the nav)`, () => {
    assert.match(brand, /class="brand"/);
    assert.match(html, /\.brand\s*\{[^}]*white-space:\s*nowrap/);
  });
}
