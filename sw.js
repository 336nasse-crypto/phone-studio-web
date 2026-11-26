/* sw.js — Phone Studio service worker. Cache-first app shell so the
 * recorder works offline after the first load. All paths are relative
 * ("./") because the site lives at a subpath (GitHub Pages), not a
 * domain root. Bump CACHE_NAME when the shell changes.
 */
var CACHE_NAME = 'phone-studio-v22';
var SHELL = [
  './',
  './index.html',
  './styles.css',
  './perf-probe.js',
  './wav.js',
  './calibrate.js',
  './residual.js',
  './db.js',
  './store.js',
  './routelab.js',
  './safety.js',
  './audio.js',
  './worklet.js',
  './tune-worklet.js',
  './vocal-chain-worklet.js',
  './key-detect.js',
  './tempo-detect.js',
  './retune.js',
  './voice-ref.js',
  './app.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      // Add entries one by one: one missing file (a 404) must not
      // fail the whole install — cache.addAll rejects entirely if
      // any entry fails. A missing entry just falls back to the
      // network until it exists.
      return Promise.all(SHELL.map(function (url) {
        return cache.add(url).catch(function () { /* tolerate a 404 */ });
      }));
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key !== CACHE_NAME) return caches.delete(key);
        return undefined;
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  // Same-origin only — never cache anything else.
  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // v13.2 (item 8) — the voice reference is optional and
  // replaceable: it does not exist until his voice note lands, and
  // it is rewritten whenever a better one arrives. Never serve it
  // from the cache (a stale reference would tune against the wrong
  // voice), and never pass a 404 through for its absence — a
  // missing file just means "no reference yet", so the worker
  // answers that itself with an empty reference (200). The loader
  // treats an empty reference as absent.
  if (url.pathname.endsWith('voice-reference.json')) {
    event.respondWith(
      fetch(request).then(function (response) {
        if (response && response.status === 200) return response;
        return new Response(JSON.stringify({ schemaVersion: 1, pitch: null }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }).catch(function () {
        return new Response(JSON.stringify({ schemaVersion: 1, pitch: null }), {
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then(function (cached) {
      if (cached) return cached;
      return fetch(request).then(function (response) {
        // Cache good same-origin responses for next time.
        if (response && response.status === 200) {
          var copy = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(request, copy);
          });
        }
        return response;
      });
    })
  );
});
