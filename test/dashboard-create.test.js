// test/dashboard-create.test.js — guards the in-dashboard create-request entry point. The nav cleanup
// removed the standalone דרישה חדשה page, so managers MUST be able to file a request FROM the dashboard.
// This asserts the button + modal markup, that it posts createRequest, that it never collects created_by
// (the server stamps it from the session token), and that the dashboard nav no longer links the removed '/'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'src/dashboard.html'), 'utf8');

test('dashboard exposes the in-dashboard create entry point (button + modal + fields)', () => {
  assert.ok(/id="openCreate"/.test(html), 'the ＋ דרישה חדשה button');
  assert.ok(/id="createModal"/.test(html), 'the create modal');
  for (const f of ['crHouse', 'crCategory', 'crUrgency', 'crDescription', 'crLocation']) {
    assert.ok(new RegExp(`id="${f}"`).test(html), `modal field ${f} present`);
  }
  assert.ok(/post\('createRequest'/.test(html), 'the confirm button posts createRequest');
});

test('the create modal never collects created_by (server stamps it from the token)', () => {
  const m = html.match(/post\('createRequest',\s*\{([^}]*)\}/);
  assert.ok(m, 'found the createRequest post payload');
  assert.ok(!/created_by/.test(m[1]), 'created_by must NOT be sent from the client — the token identity is authoritative');
});

test('dashboard static nav no longer links the removed standalone request-form page (/)', () => {
  const nav = html.match(/<nav class="nav">([\s\S]*?)<\/nav>/);
  assert.ok(nav, 'nav markup present');
  assert.ok(!/href="\/"/.test(nav[1]), 'no href="/" (דרישה חדשה) tab in the dashboard nav');
  assert.ok(!/href="\/events"/.test(nav[1]), 'no href="/events" (אירועים חריגים) tab');
});
