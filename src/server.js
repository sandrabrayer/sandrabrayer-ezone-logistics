// server.js — minimal zero-dependency Node server for the frontend.
// Serves src/index.html and injects APPS_SCRIPT_EXEC_URL from the environment at request time,
// so the URL is never hardcoded in the HTML and never committed. Reads .env if present.
//
// The request handler and server factory are exported so test/server.test.js can exercise the
// routes on an ephemeral port WITHOUT importing this module ever making an outbound call: the
// exec URL is only INJECTED into the HTML (consumed later by the browser), never fetched here.
// The process only starts listening when this file is run directly (`node src/server.js`).

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Tiny .env loader (no dependency). Only used locally; Railway injects real env vars.
export function loadEnv() {
  const path = join(__dirname, '..', '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

/**
 * Build the HTTP request handler. Pure and side-effect free: given an exec URL and a directory,
 * it serves the two HTML pages with the exec URL injected, or 404s. It never performs any network
 * I/O of its own — the injected URL is only ever read by the browser at runtime.
 * @param {object} opts
 * @param {string} [opts.execUrl]  value injected as window.__EXEC_URL__
 * @param {string} [opts.dir]      directory the HTML files are read from (defaults to src/)
 */
export function createRequestHandler({ execUrl = '', dir = __dirname } = {}) {
  const inject = `<script>window.__EXEC_URL__=${JSON.stringify(execUrl)};</script>`;
  return (req, res) => {
    let file = null;
    if (req.url === '/' || req.url === '/index.html') file = 'index.html';
    else if (req.url === '/dashboard' || req.url === '/dashboard.html') file = 'dashboard.html';

    if (file) {
      let html = readFileSync(join(dir, file), 'utf8');
      html = html.replace('</head>', inject + '</head>');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  };
}

/** Create (but do not start) an http.Server wired to the request handler. */
export function createAppServer(opts = {}) {
  return createServer(createRequestHandler(opts));
}

// Only boot a listening server when run directly, so tests can import the factory cleanly.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  loadEnv();
  const PORT = process.env.PORT || 3000;
  const EXEC_URL = process.env.APPS_SCRIPT_EXEC_URL || '';
  const server = createAppServer({ execUrl: EXEC_URL });
  server.listen(PORT, () => {
    console.log(`EZone Logistics frontend on http://localhost:${PORT}`);
    if (!EXEC_URL) console.warn('WARNING: APPS_SCRIPT_EXEC_URL not set — form submission will fail.');
  });
}
