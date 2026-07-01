// server.js — minimal zero-dependency Node server for the frontend.
// Serves src/index.html and injects APPS_SCRIPT_EXEC_URL from the environment at request time,
// so the URL is never hardcoded in the HTML and never committed. Reads .env if present.

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

// PWA head links injected into every served HTML page (kept here, DRY, like __EXEC_URL__).
const HEAD_INJECT =
  '<link rel="manifest" href="/manifest.webmanifest">'
  + '<meta name="theme-color" content="#161a20">'
  + '<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32-v1.png">'
  + '<link rel="apple-touch-icon" href="/icons/apple-touch-icon-v1.png">';

const HTML_ROUTES = {
  '/': 'index.html', '/index.html': 'index.html',
  '/dashboard': 'dashboard.html', '/dashboard.html': 'dashboard.html',
  '/inspection': 'inspection.html', '/inspection.html': 'inspection.html',
  '/reports': 'reports.html', '/reports.html': 'reports.html',
  '/workorders': 'workorders.html', '/workorders.html': 'workorders.html',
};

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

const server = createServer((req, res) => {
  const path = (req.url || '/').split('?')[0];

  // Static: PWA manifest.
  if (path === '/manifest.webmanifest') {
    try {
      const body = readFileSync(join(__dirname, 'manifest.webmanifest'));
      res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
      return res.end(body);
    } catch (e) { return notFound(res); }
  }

  // Static: PWA icons. Whitelist the filename (no slashes, no traversal) before touching disk.
  // Filenames are versioned (…-v1.png), so cache them immutably.
  if (path.startsWith('/icons/')) {
    const name = path.slice('/icons/'.length);
    if (/^[A-Za-z0-9._-]+\.png$/.test(name)) {
      try {
        const body = readFileSync(join(__dirname, 'icons', name));
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' });
        return res.end(body);
      } catch (e) { /* missing → 404 below */ }
    }
    return notFound(res);
  }

  // HTML routes — inject the non-secret /exec URL global + the PWA head links.
  const file = HTML_ROUTES[path];
  if (file) {
    const inject = `<script>window.__EXEC_URL__=${JSON.stringify(EXEC_URL)};</script>` + HEAD_INJECT;
    let html = readFileSync(join(__dirname, file), 'utf8');
    html = html.replace('</head>', inject + '</head>');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  notFound(res);
});

server.listen(PORT, () => {
  console.log(`EZone Logistics frontend on http://localhost:${PORT}`);
  if (!EXEC_URL) console.warn('WARNING: APPS_SCRIPT_EXEC_URL not set — form submission will fail.');
});
