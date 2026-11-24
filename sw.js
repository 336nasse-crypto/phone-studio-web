/* sw.js — Phone Studio service worker. Cache-first app shell so the
 * recorder works offline after the first load. All paths are relative
 * ("./") because the site lives at a subpath (GitHub Pages), not a
 * domain root. Bump CACHE_NAME when the shell changes.
 */
var CACHE_NAME = 'phone-studio-v2';
var SHELL = [
  './',
  './index.html',
  './styles.css',
  './wav.js',
  './calibrate.js',
  './residual.js',
  './db.js',
  './store.js',
  './audio.js',
  './worklet.js',
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
