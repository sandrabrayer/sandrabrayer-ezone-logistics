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

const server = createServer((req, res) => {
  const inject = `<script>window.__EXEC_URL__=${JSON.stringify(EXEC_URL)};</script>`;
  let file = null;
  if (req.url === '/' || req.url === '/index.html') file = 'index.html';
  else if (req.url === '/dashboard' || req.url === '/dashboard.html') file = 'dashboard.html';
  else if (req.url === '/inspection' || req.url === '/inspection.html') file = 'inspection.html';
  else if (req.url === '/reports' || req.url === '/reports.html') file = 'reports.html';
  else if (req.url === '/workorders' || req.url === '/workorders.html') file = 'workorders.html';

  if (file) {
    let html = readFileSync(join(__dirname, file), 'utf8');
    html = html.replace('</head>', inject + '</head>');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`EZone Logistics frontend on http://localhost:${PORT}`);
  if (!EXEC_URL) console.warn('WARNING: APPS_SCRIPT_EXEC_URL not set — form submission will fail.');
});
