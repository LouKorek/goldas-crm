// CACHE_NAME bumped on every meaningful deploy so users get fresh assets
// instead of stale CSS/JS pinned in their PWA cache.
const CACHE_NAME = 'goldas-crm-v15';

// Assets pre-cached for offline use. Hashed /static/* files are NOT in
// this list — they're populated on first fetch.
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/logo.png',
  '/manifest.json',
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
//   • /static/* hashed assets (CSS, JS, fonts, images)  → network-first,
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

  // Everything else (CSS, JS, fonts, images) — network-first, fall back to
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
