/* WAYLO — offline vision-model cache (best-effort).
 *
 * Intercepts the one-time TensorFlow.js COCO-SSD model download
 * (storage.googleapis.com / tfhub.dev) and serves it from Cache Storage on
 * every later run, so the vision engine works fully offline once installed.
 * Nothing else is cached — app assets, API calls and STT are never touched.
 */
const CACHE = "waylo-models-v1";
const MODEL_URL = /storage\.googleapis\.com\/(tfjs-models|tfhub)|\.bin(\?|$)/;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith("waylo-models-") && k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (!MODEL_URL.test(url.href)) return;

  // Cache-first for model artifacts: once downloaded, load offline.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
  );
});
