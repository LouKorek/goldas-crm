// CACHE_NAME changes on every build: the build replaces the placeholder with
// the commit id (apps/web/scripts/sw-version.js), so users always get fresh
// assets without anyone bumping a version by hand.
const CACHE_NAME = 'goldas-crm-__BUILD_ID__';

// Assets pre-cached for offline use. Hashed /assets/* files are NOT in
// this list — they're populated on first fetch.
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/logo.png',
  '/brand-mark.png',
  '/manifest.json',
  '/fonts/Heebo-400.ttf',
  '/fonts/Heebo-700.ttf',
];

// Install — pre-cache the shell + immediately take over.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate — drop every cache whose name doesn't match the current
// CACHE_NAME, then claim all open clients so the new SW takes over now
// without requiring a tab close + reopen.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

// Fetch strategy:
//   • Firebase / Google / Firestore                     → bypass SW
//   • HTML navigation                                   → network-first
//   • /assets/* hashed assets and /fonts/*              → cache-first
//   • anything else                                     → network-first,
//                                                          cache as fallback
// This is the critical change from the previous version, which used
// cache-first for static assets and meant the user's browser served the
// OLD CSS forever, even after Netlify deployed a new one. Network-first
// guarantees fresh assets on every load while still giving an offline
// fallback.
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GETs.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Bypass for live data sources.
  if (
    url.hostname.includes('firebase') ||
    url.hostname.includes('firestore') ||
    url.hostname.includes('googleapis') ||
    url.hostname.includes('google.com')
  ) {
    return;
  }

  // HTML navigation — always try network so a deploy is immediately
  // visible. If the user is offline, fall back to the cached shell.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((c) => c.put('/index.html', clone)).catch(() => {});
          }
          return response;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Hashed build files (/assets/name-HASH.js|css) never change under the same
  // name: a new build gets new names. So they come from the cache when
  // present, which saves re-downloading the whole app on every open. The
  // stale-CSS problem the old cache-first had came from unhashed files,
  // which still go network-first below.
  if (url.origin === self.location.origin && (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/fonts/'))) {
    event.respondWith(
      caches.match(request).then((hit) => hit || fetch(request).then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((c) => c.put(request, clone)).catch(() => {});
        }
        return response;
      }))
    );
    return;
  }

  // Everything else (unhashed images, manifest) — network-first, fall back to
  // cache only when the network actually fails.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((c) => c.put(request, clone)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});
