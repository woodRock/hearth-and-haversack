// Offline support. The app's own files are fetched fresh when there's signal and
// served from the cache when there isn't. Pinned library versions from the CDNs
// never change, so they're served from the cache first.
// Claude and Firebase requests are never cached; Firestore has its own offline cache.
const VERSION = "hh-v8";
const SHELL = [
  "./", "index.html", "styles.css?v=8", "app.js?v=8", "claude.js?v=8", "cloud.js?v=8",
  "manifest.webmanifest", "icon.svg",
];
const PINNED_HOSTS = ["cdn.jsdelivr.net", "www.gstatic.com", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(req));
  } else if (PINNED_HOSTS.includes(url.hostname) && (url.hostname.startsWith("fonts") || url.pathname.includes("firebasejs") || url.pathname.includes("@anthropic-ai"))) {
    event.respondWith(cacheFirst(req));
  }
});

async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req, { ignoreSearch: req.mode === "navigate" })) || (await cache.match("index.html")) || Response.error();
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") cache.put(req, res.clone());
  return res;
}
