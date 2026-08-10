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
// CACHE name — the Node server REWRITES this literal to `ezone-logistics-<commit>` when it serves /sw.js,
// so every deploy ships a new cache name and a new SW byte-content (the browser detects the update, and
// activate() purges every non-matching cache). The static 'v3' here is only the local/dev fallback.
//
// Heal history: v2 cached the non-shell HTML pages (inventory/reports/workorders/inspection/management)
// CACHE-FIRST, so after a redeploy those pages served STALE html (no version footer, old shim). Two things
// fix existing wedged clients WITHOUT a manual cache clear: (1) every app document is now network-first
// (below); (2) install skipWaiting()s UNCONDITIONALLY and activate deletes every non-current cache + claims
// clients, so the new worker can't be blocked from taking over by a failed shell precache.
var CACHE = 'ezone-logistics-v3';
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

// NETWORK-FIRST: EVERY app HTML document (not just the shell). Kept fresh so a redeploy shows up at
// once — critical because the injected auth shim lives in the page HTML, so a stale cached document
// would run an outdated shim and re-prompt for login. Any page served by the Node HTML_ROUTES must be
// listed here (both its extensionless and .html forms); the fetch handler also treats ANY navigation
// (request.mode === 'navigate') as network-first, so a newly added page can't regress to stale cache.
var DOCUMENT_ROUTES = [
  '/', '/index.html',
  '/dashboard', '/dashboard.html',
  '/inspection', '/inspection.html',
  '/inventory', '/inventory.html',
  '/reports', '/reports.html',
  '/workorders', '/workorders.html',
  '/management', '/management.html',
];
// Note: '/events' (אירועים חריגים) was removed from the app; no route entry remains.
function isNetworkFirst(url) {
  return DOCUMENT_ROUTES.indexOf(url.pathname) !== -1;
}

// Whether a successful same-origin GET response for this URL may be written to
// the cache. Live-data (network-only) URLs and cross-origin URLs never are.
function shouldCache(url, origin) {
  if (url.origin !== origin) return false;
  if (isNetworkOnly(url)) return false;
  return true;
}

self.addEventListener('install', function (e) {
  // Take over ASAP. skipWaiting is called UNCONDITIONALLY and FIRST — it must NOT be gated on the shell
  // precache. If addAll() rejected (a renamed/removed shell asset), install would fail and the NEW worker
  // would never activate — leaving the OLD worker (and its stale, cache-first document cache) in control
  // forever. THAT is the heal-blocker this fixes. So skipWaiting immediately, then precache best-effort
  // (per-asset, failures swallowed) so one missing file can never abort the update.
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(SHELL.map(function (u) {
        return fetch(u).then(function (r) { return (r && r.ok) ? c.put(u, r) : null; }).catch(function () { return null; });
      }));
    }).catch(function () { return null; })
  );
});

self.addEventListener('activate', function (e) {
  // Delete EVERY cache whose name isn't the current (commit-stamped) CACHE — purges all stale pre-deploy
  // caches, including older commit-stamped names and the legacy vN names — then claim all open clients so
  // THIS worker controls them immediately. Existing tabs heal WITHOUT a manual cache clear: their next
  // navigation is served by the new, network-first worker.
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

  // NETWORK-FIRST for every app document — by explicit route OR any top-level navigation. The
  // navigate check future-proofs pages not yet in DOCUMENT_ROUTES: a page load never serves stale HTML.
  if (isNetworkFirst(url) || req.mode === 'navigate') {
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
