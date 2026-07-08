// test/pwa.test.js — guards the PWA foundation: manifest validity, the service
// worker's live-data (sheets/api) cache-exclusion, and the icon palette + a
// logo-presence check so a future "recolour" can never silently blank the glyph.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import zlib from 'node:zlib';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUB = join(__dirname, '..', 'src', 'public');

// Brand palette locked by this suite.
const BG = [7, 20, 16];        // #071410
const LOGO = [0, 191, 165];    // #00bfa5 (Logistics teal)
const OLD_LOGO = [41, 212, 136]; // #29d488 (original green — must be gone)

const hex = (r, g, b) => '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');

// ---- manifest ------------------------------------------------------------
test('manifest.json is valid and carries the Logistics identity', () => {
  const m = JSON.parse(readFileSync(join(PUB, 'manifest.json'), 'utf8'));
  assert.equal(m.name, 'E-Zone Logistics');
  assert.equal(m.short_name, 'Logistics');
  assert.equal(m.display, 'standalone');
  assert.equal(m.dir, 'rtl');
  assert.equal(m.lang, 'he');
  assert.equal(m.theme_color, '#071410');
  assert.equal(m.background_color, '#071410');
  assert.ok(Array.isArray(m.icons) && m.icons.length === 3, 'three icons declared');

  const bySize = Object.fromEntries(m.icons.map((i) => [i.sizes + '/' + i.purpose, i]));
  assert.ok(bySize['192x192/any'], '192 any icon present');
  assert.ok(bySize['512x512/any'], '512 any icon present');
  assert.ok(bySize['512x512/maskable'], '512 maskable icon present');
  // Every declared icon file must actually exist and be a PNG.
  for (const icon of m.icons) {
    assert.equal(icon.type, 'image/png');
    const buf = readFileSync(join(PUB, icon.src));
    assert.equal(buf.readUInt32BE(0), 0x89504e47, icon.src + ' is a PNG');
  }
});

// ---- service worker: sheets / api exclusion ------------------------------
// Evaluate the REAL sw.js in a sandbox so we assert on the shipped routing
// predicates, not a copy.
function loadSW() {
  const code = readFileSync(join(PUB, 'sw.js'), 'utf8');
  const sandbox = {
    self: {
      addEventListener() {},
      location: { origin: 'https://logistics.example' },
      skipWaiting() {},
      clients: { claim() {} },
    },
    caches: { open() {}, keys() {}, match() {}, delete() {} },
    URL,
    Promise,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox;
}

test('service worker never caches Google Sheets or /api/ (network-only)', () => {
  const sw = loadSW();
  const O = 'https://logistics.example';

  // Live-data URLs — must be network-only, and thus never cacheable.
  assert.equal(sw.isNetworkOnly(new URL('https://sheets.googleapis.com/v4/spreadsheets/abc/values')), true);
  assert.equal(sw.isNetworkOnly(new URL(O + '/data?backend=sheets')), true);
  assert.equal(sw.isNetworkOnly(new URL(O + '/api/requests')), true);
  assert.equal(sw.shouldCache(new URL(O + '/api/requests'), O), false);
  assert.equal(sw.shouldCache(new URL('https://sheets.googleapis.com/v4/x'), O), false);

  // Static same-origin assets — cacheable.
  assert.equal(sw.isNetworkOnly(new URL(O + '/icon-v1-192.png')), false);
  assert.equal(sw.shouldCache(new URL(O + '/icon-v1-192.png'), O), true);
  assert.equal(sw.shouldCache(new URL(O + '/manifest.json'), O), true);

  // Cross-origin static is never cached either.
  assert.equal(sw.shouldCache(new URL('https://cdn.other/app.js'), O), false);

  // Shell documents are network-first.
  assert.equal(sw.isNetworkFirst(new URL(O + '/')), true);
  assert.equal(sw.isNetworkFirst(new URL(O + '/dashboard.html')), true);

  // Cache name is versioned.
  assert.match(sw.CACHE, /^ezone-logistics-v\d+$/);
});

// ---- icon palette + logo presence ----------------------------------------
// Minimal 8-bit RGBA PNG decoder (no dependencies), matching scripts/gen-icons.js.
function decodeRGBA(file) {
  const buf = readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG: ' + file);
  let off = 8, w = 0, h = 0, bd = 0, ct = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  assert.equal(bd, 8, 'bit depth 8');
  assert.equal(ct, 6, 'colour type RGBA');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[pos++];
    for (let x = 0; x < stride; x++) {
      const v = raw[pos++];
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = (x >= bpp && y > 0) ? out[(y - 1) * stride + x - bpp] : 0;
      let recon;
      if (ft === 0) recon = v;
      else if (ft === 1) recon = v + a;
      else if (ft === 2) recon = v + b;
      else if (ft === 3) recon = v + ((a + b) >> 1);
      else if (ft === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        recon = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error('bad filter type ' + ft);
      out[y * stride + x] = recon & 0xff;
    }
  }
  return { w, h, data: out };
}

// blend fraction of a pixel toward the logo colour (same projection the
// recolour uses); 1 = pure logo ink, 0 = pure background.
const D = [LOGO[0] - BG[0], LOGO[1] - BG[1], LOGO[2] - BG[2]];
const DLEN2 = D[0] * D[0] + D[1] * D[1] + D[2] * D[2];
function inkFraction(r, g, b) {
  let t = ((r - BG[0]) * D[0] + (g - BG[1]) * D[1] + (b - BG[2]) * D[2]) / DLEN2;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

const ICONS = ['icon-v1-192.png', 'icon-v1-512.png', 'icon-v1-maskable.png'];

for (const name of ICONS) {
  test(`${name}: palette is dark #071410 + teal #00bfa5, no leftover green`, () => {
    const img = decodeRGBA(join(PUB, name));
    const cnt = {};
    for (let i = 0; i < img.data.length; i += 4) {
      if (img.data[i + 3] < 128) continue; // ignore transparent
      cnt[hex(img.data[i], img.data[i + 1], img.data[i + 2])] = 1;
    }
    assert.ok(cnt[hex(...BG)], 'background #071410 present');
    assert.ok(cnt[hex(...LOGO)], 'logo teal #00bfa5 present');
    assert.ok(!cnt[hex(...OLD_LOGO)], 'original green #29d488 fully remapped away');
  });

  test(`${name}: logo ink covers > 5% of pixels (glyph not blanked)`, () => {
    const img = decodeRGBA(join(PUB, name));
    let ink = 0, total = img.w * img.h;
    for (let i = 0; i < img.data.length; i += 4) {
      if (img.data[i + 3] < 128) continue;
      // count a pixel as "ink" when it leans toward the logo colour
      if (inkFraction(img.data[i], img.data[i + 1], img.data[i + 2]) >= 0.5) ink++;
    }
    const pct = (100 * ink) / total;
    assert.ok(pct > 5, `${name} logo ink ${pct.toFixed(1)}% must exceed 5%`);
  });
}
