// test/manifest.test.js — locks the PWA manifest shape so the install/icon wiring can't drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(join(__dirname, '..', 'src', 'manifest.webmanifest'), 'utf8'),
);

test('manifest has the core PWA fields', () => {
  assert.equal(manifest.name, 'EZone Logistics');
  assert.ok(manifest.short_name);
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  assert.match(manifest.theme_color, /^#[0-9a-fA-F]{6}$/);
  assert.match(manifest.background_color, /^#[0-9a-fA-F]{6}$/);
});

test('manifest declares 192/512 "any" icons and a 512 maskable icon', () => {
  const icons = manifest.icons || [];
  const find = (sizes, purpose) =>
    icons.find(i => i.sizes === sizes && i.purpose === purpose && i.type === 'image/png');
  assert.ok(find('192x192', 'any'), 'missing 192x192 any');
  assert.ok(find('512x512', 'any'), 'missing 512x512 any');
  assert.ok(find('512x512', 'maskable'), 'missing 512x512 maskable');
});

test('every icon src is under /icons/ and versioned (cache-busting)', () => {
  for (const i of manifest.icons || []) {
    assert.match(i.src, /^\/icons\/.+-v\d+\.png$/, `bad icon src: ${i.src}`);
  }
});
