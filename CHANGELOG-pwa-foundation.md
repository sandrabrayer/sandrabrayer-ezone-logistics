# PWA foundation — installable E-Zone Logistics

Adds the Progressive Web App layer so Logistics installs to the home screen and
opens standalone, matching the ecosystem pattern (mirrors `ezone-outpatient`).
The brand mark is the **original E-Zone glyph** — recovered, not redrawn —
recoloured to the Logistics teal.

## Icons — recoloured, never redrawn

The three launcher icons are the original E-Zone brand glyph, recovered
byte-for-byte from `sandrabrayer/ezone-outpatient` git history at commit
`e1b0da0` (the state before its recolour PRs): dark `#071410` background,
`#29d488` green logo.

`scripts/gen-icons.js` recolours them **in place** with a pixel blend-remap that
preserves the exact glyph shape and anti-aliasing — every source pixel is read
as a blend `t·logo + (1−t)·background`, `t` is recovered from its RGB, and the
pixel is re-emitted as `t·newLogo + (1−t)·newBg`. No thresholding, no redraw.

- Background `#071410` → `#071410` (dark, unchanged)
- Logo `#29d488` → `#00bfa5` (Logistics teal)
- `icon-v1-maskable.png` is flattened to a fully-opaque dark square so the
  safe-zone padding stays dark to the edge under a launcher mask.

Files: `src/public/icon-v1-192.png`, `icon-v1-512.png`, `icon-v1-maskable.png`.
Verified visually at 48 / 64 / 96 px — the glyph reads cleanly at every size.
Icon filenames are **versioned** (`icon-v1-*`); a future recolour must ship
`icon-v2-*` and bump the SW cache, because Android caches launcher icons hard.

## Manifest

`src/public/manifest.json`: `name` "E-Zone Logistics", `short_name` "Logistics",
`display` standalone, `dir` rtl, `lang` he, dark `theme_color` /
`background_color` `#071410`, and the three icons (192 any, 512 any, 512
maskable).

## Service worker — `src/public/sw.js`

Versioned cache `ezone-logistics-v1`. `skipWaiting` on install, `clients.claim`
on activate, and every non-current cache purged on activate. Layered strategy:

- **NETWORK-ONLY** for live data — any URL containing `sheets` or `/api/` is
  never intercepted or cached (a stale Sheets read would be actively wrong).
- **NETWORK-FIRST** for the shell documents `/`, `index.html`, `dashboard.html`
  — a redeploy is picked up immediately; cache is an offline fallback only.
- **CACHE-FIRST** for other same-origin static assets (icons, css, scripts).

## Wiring

- `src/index.html` and `src/dashboard.html`: manifest link, `theme-color`,
  apple-touch-icon + apple-mobile-web-app meta, and a guarded service-worker
  registration (a failed register never breaks the page).
- `src/server.js` (hand-rolled, no framework): explicit routes serving
  `/manifest.json`, `/sw.js` (from the root path so its scope covers `/` and
  `/dashboard`; `Cache-Control: no-cache`), and the three icon PNGs from
  `src/public/`.

## Tests — `test/pwa.test.js`

- **Manifest validity**: identity fields + all three declared icon files exist
  and are PNGs.
- **`shouldCache` sheets-exclusion**: the real `sw.js` is evaluated in a sandbox
  and its predicates asserted — Sheets / `/api/` URLs are network-only and never
  cacheable; static same-origin assets are; cross-origin is never cached; the
  cache name is versioned.
- **Palette**: each icon contains `#071410` and `#00bfa5` and no leftover
  `#29d488` green.
- **Logo-presence**: logo ink covers > 5% of pixels in every icon, so a future
  recolour can't silently blank the glyph.

Full suite green (`npm test`).
