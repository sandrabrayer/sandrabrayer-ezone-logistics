/* E-Zone Logistics service worker.
 *
 * This is a LIVE-DATA app: requests, approvals and audit rows are read from and
 * written to Google Sheets through the Apps Script `/exec` endpoint. A stale
 * response there would be actively wrong, so the caching strategy is layered:
 *
 *   NETWORK-ONLY   — anything that talks to live data. Any URL whose path or
 *                    query contains "sheets" (the Apps Script / Sheets origin)
 *                    or "/api/" is never intercepted and never cached; the
 *                    browser performs a normal network fetch every time.
 *   NETWORK-FIRST  — the shell documents ("/", index.html, dashboard.html).
 *                    Always try the network so a redeploy is picked up
 *                    immediately; fall back to cache only when offline.
 *   CACHE-FIRST    — other same-origin static assets (icons, css, scripts):
 *                    served from cache for instant loads, fetched-and-cached
 *                    on a miss.
 *
 * Icon-cache trap: icon filenames are VERSIONED (icon-v1-*). When the icons
 * change, ship icon-v2-* AND bump CACHE below — Android caches launcher icons
 * aggressively and will not refresh otherwise.
 *
 * The routing predicates below are plain top-level functions with no
 * dependency on the service-worker globals, so the test suite can evaluate this
 * exact file and assert on them directly.
 */
var CACHE = 'ezone-logistics-v2';
var SHELL = [
  './',
  './index.html',
  './dashboard.html',
  './manifest.json',
  './icon-v1-192.png',
  './icon-v1-512.png',
  './icon-v1-maskable.png'
];

// NETWORK-ONLY: live data must never be cached or served stale. Matches the
// Google Sheets origin ("sheets" anywhere in the URL — host, path or query) and
// any "/api/" path.
function isNetworkOnly(url) {
  var s = url.href.toLowerCase();
  return s.indexOf('sheets') !== -1 || s.indexOf('/api/') !== -1;
}

// NETWORK-FIRST: the shell documents. Kept fresh so a redeploy shows up at once.
function isNetworkFirst(url) {
  var p = url.pathname;
  return p === '/' || p === '/index.html' || p === '/dashboard' || p === '/dashboard.html';
}

// Whether a successful same-origin GET response for this URL may be written to
// the cache. Live-data (network-only) URLs and cross-origin URLs never are.
function shouldCache(url, origin) {
  if (url.origin !== origin) return false;
  if (isNetworkOnly(url)) return false;
  return true;
}

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE; })
            .map(function (k) { return caches.delete(k); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);

  // NETWORK-ONLY: do not intercept — let the browser fetch live data directly.
  if (isNetworkOnly(url)) return;

  var origin = self.location.origin;

  // NETWORK-FIRST for the shell documents.
  if (isNetworkFirst(url)) {
    e.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok && shouldCache(url, origin)) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit) { return hit || caches.match('./index.html'); });
      })
    );
    return;
  }

  // CACHE-FIRST for other same-origin static assets.
  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.ok && shouldCache(url, origin)) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      });
    })
  );
});
