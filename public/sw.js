// Minimal offline shell for THE Travel Club. Caches the app shell so the page
// loads without a network; API calls are never cached (prices and account data
// must always be fresh). The single exception is the concierge briefing, which
// is enrichment (weather, guides, nearby places), carries no prices or account
// data, and is exactly what a traveler needs when roaming data runs out.
const CACHE = 'ttc-shell-v3';
const CONCIERGE_CACHE = 'ttc-concierge-v1';
const SHELL = ['/app', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE && key !== CONCIERGE_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Only handle same-origin GETs; never intercept cross-origin requests.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Concierge briefings: network first, cache fallback, so the last briefing
  // for a destination keeps working offline mid-trip.
  if (url.pathname === '/v1/concierge') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CONCIERGE_CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => caches.match(event.request, { cacheName: CONCIERGE_CACHE }).then((cached) => cached || Response.error()))
    );
    return;
  }

  // Every other API route stays uncached: prices and account data must be live.
  if (url.pathname.startsWith('/v1/') || url.pathname === '/health' || url.pathname === '/ready' || url.pathname === '/metrics') return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match('/app')))
  );
});
