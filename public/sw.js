// Peak Journey — tile-cache service worker.
//
// Intercepts requests to known basemap tile servers, serves them from
// CacheStorage if present, otherwise fetches and caches them. Other
// requests pass through untouched (no interference with Vite HMR or app
// JS/CSS).

const CACHE_NAME = 'peak-journey-tiles-v1';

const TILE_HOST_PATTERNS = [
  /^tile\.openstreetmap\.org$/,
  /^[abc]\.basemaps\.cartocdn\.com$/,
];

function isTileRequest(url) {
  return TILE_HOST_PATTERNS.some((re) => re.test(url.host));
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Clean up any older versions of our cache so we don't grow forever.
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith('peak-journey-tiles-') && n !== CACHE_NAME)
          .map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (!isTileRequest(url)) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const response = await fetch(req);
        // Store both transparent (CORS-allowed) and opaque (no-cors) tiles.
        // Opaque responses count as ~7MB each in the storage quota math, but
        // for a few hundred tiles per region this is comfortably within the
        // browser's per-origin budget.
        if (response && (response.ok || response.type === 'opaque')) {
          cache.put(req, response.clone()).catch(() => {});
        }
        return response;
      } catch (err) {
        return cached ?? new Response('Tile fetch failed', { status: 504 });
      }
    })(),
  );
});
