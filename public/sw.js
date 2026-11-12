// Service worker minimal de Hermes Web : cache hors-ligne partiel.
// Stratégie : network-first pour la navigation et les assets, avec repli
// sur le cache ; les requêtes vers la gateway (XTransformPort) et les
// websockets ne sont jamais mises en cache.
const CACHE = "hermes-web-v1";
const SHELL = ["/", "/icon-192.png", "/icon-512.png", "/logo.svg", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isCacheable(request) {
  const url = new URL(request.url);
  if (request.method !== "GET") return false;
  if (url.origin !== self.location.origin) return false;
  // Jamais de cache pour la gateway Caddy (sockets, uploads, API)
  if (url.searchParams.has("XTransformPort")) return false;
  if (url.pathname.startsWith("/socket.io/")) return false;
  if (url.pathname.startsWith("/uploads/")) return false;
  if (url.pathname.startsWith("/api/")) return false;
  return true;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (!isCacheable(request)) return;
  if (request.mode === "navigate") {
    // Navigation : réseau d'abord, cache en repli (page hors-ligne)
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((hit) => hit ?? caches.match("/")))
    );
    return;
  }
  // Assets : cache d'abord, réseau sinon
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ??
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
    )
  );
});
