// server.js — minimal zero-dependency Node server for the frontend.
// Serves src/index.html and injects APPS_SCRIPT_EXEC_URL from the environment at request time,
// so the URL is never hardcoded in the HTML and never committed. Reads .env if present.

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Tiny .env loader (no dependency). Only used locally; Railway injects real env vars.
function loadEnv() {
  const path = join(__dirname, '..', '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();

const PORT = process.env.PORT || 3000;
const EXEC_URL = process.env.APPS_SCRIPT_EXEC_URL || '';
// The staff access code is NOT injected here anymore — it is never sent to the browser. Staff type
// it and the Apps Script backend verifies it (verifyToken) against the STAFF_WRITE_TOKEN Script
// Property. Only the (non-secret) /exec URL is exposed to the page.

const PUBLIC = join(__dirname, 'public');

// PWA head links injected into every served HTML page (kept here, DRY, like __EXEC_URL__).
// These point at the brand PWA layer under src/public/ (dark #071410, teal #00bfa5 glyph): the
// installable manifest, apple-touch icon and standalone metas. The 32px favicon stays the shared
// src/icons/ asset. Injecting server-side means every page (index, dashboard, inspection, reports,
// workorders) is wired identically with no per-file duplication.
const HEAD_INJECT =
  '<link rel="manifest" href="/manifest.json">'
  + '<meta name="theme-color" content="#071410">'
  + '<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32-v1.png">'
  + '<link rel="apple-touch-icon" href="/icon-v1-192.png">'
  + '<meta name="apple-mobile-web-app-capable" content="yes">'
  + '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">'
  + '<meta name="apple-mobile-web-app-title" content="Logistics">';

// The brand PWA static assets (src/public/): the installable manifest, the service worker and the
// recoloured teal icons the manifest/apple-touch links reference. The server is hand-rolled (no
// framework / static middleware), so each must be mapped explicitly. sw.js is served from the ROOT
// path so its scope covers "/" and "/dashboard"; a service worker only controls pages at or below
// its own URL.
const PUBLIC_ASSETS = {
  '/manifest.json':        { file: 'manifest.json',        type: 'application/manifest+json; charset=utf-8' },
  '/sw.js':                { file: 'sw.js',                type: 'application/javascript; charset=utf-8', noCache: true },
  '/icon-v1-192.png':      { file: 'icon-v1-192.png',      type: 'image/png' },
  '/icon-v1-512.png':      { file: 'icon-v1-512.png',      type: 'image/png' },
  '/icon-v1-maskable.png': { file: 'icon-v1-maskable.png', type: 'image/png' },
};

const HTML_ROUTES = {
  '/': 'index.html', '/index.html': 'index.html',
  '/dashboard': 'dashboard.html', '/dashboard.html': 'dashboard.html',
  '/inspection': 'inspection.html', '/inspection.html': 'inspection.html',
  '/inventory': 'inventory.html', '/inventory.html': 'inventory.html',
  '/reports': 'reports.html', '/reports.html': 'reports.html',
  '/workorders': 'workorders.html', '/workorders.html': 'workorders.html',
};

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

// Serve a PNG from src/icons/ with an EXPLICIT image/png Content-Type — never let it default to a
// text/document type, or browsers render a blank box instead of the image. Returns false (writing
// nothing) if the file is missing, so the caller can fall through to 404.
function sendPng(res, name, cacheControl) {
  let body;
  try {
    body = readFileSync(join(__dirname, 'icons', name));
  } catch (e) {
    return false;
  }
  res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': cacheControl });
  res.end(body);
  return true;
}

export function requestHandler(req, res) {
  const path = (req.url || '/').split('?')[0];

  // Static: brand PWA assets (manifest.json, sw.js, recoloured teal icons) from src/public/.
  const asset = PUBLIC_ASSETS[path];
  if (asset) {
    let body;
    try {
      body = readFileSync(join(PUBLIC, asset.file));
    } catch (e) {
      return notFound(res);
    }
    const headers = { 'Content-Type': asset.type };
    // sw.js must never be cached by the browser, or a newly-deployed worker is missed.
    if (asset.noCache) headers['Cache-Control'] = 'no-cache';
    res.writeHead(200, headers);
    return res.end(body);
  }

  // Static: PWA manifest (legacy .webmanifest variant, still served for compatibility).
  if (path === '/manifest.webmanifest') {
    try {
      const body = readFileSync(join(__dirname, 'manifest.webmanifest'));
      res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
      return res.end(body);
    } catch (e) { return notFound(res); }
  }

  // Static: the browser's default favicon request → serve the 32px PNG so it stops 404-ing. The URL
  // is unversioned, so cache it modestly (not immutably) in case the favicon changes later.
  if (path === '/favicon.ico') {
    if (sendPng(res, 'favicon-32-v1.png', 'public, max-age=86400')) return;
    return notFound(res);
  }

  // Static: PWA icons. Whitelist the filename (no slashes, no traversal) before touching disk.
  // Filenames are versioned (…-v1.png), so cache them immutably. Always served as image/png.
  if (path.startsWith('/icons/')) {
    const name = path.slice('/icons/'.length);
    if (/^[A-Za-z0-9._-]+\.png$/.test(name)
        && sendPng(res, name, 'public, max-age=31536000, immutable')) {
      return;
    }
    return notFound(res);
  }

  // HTML routes — inject the non-secret /exec URL global + the PWA head links.
  const file = HTML_ROUTES[path];
  if (file) {
    const inject = `<script>window.__EXEC_URL__=${JSON.stringify(EXEC_URL)};</script>` + HEAD_INJECT;
    let html = readFileSync(join(__dirname, file), 'utf8');
    html = html.replace('</head>', inject + '</head>');
    // no-cache: HTML has no versioned URL, so force browsers to revalidate every load —
    // otherwise phones serve a stale page across deploys. (Icons/manifest keep long-cache.)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(html);
  }

  notFound(res);
}

const server = createServer(requestHandler);

// Only bind a port when run directly (node src/server.js / npm start). Importing the module — e.g.
// from the test suite — gets requestHandler without starting a listener.
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  server.listen(PORT, () => {
    console.log(`EZone Logistics frontend on http://localhost:${PORT}`);
    if (!EXEC_URL) console.warn('WARNING: APPS_SCRIPT_EXEC_URL not set — form submission will fail.');
  });
}
