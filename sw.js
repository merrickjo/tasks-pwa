// Tasks PWA — service worker
// Caches the app shell only. Task data is never cached here — app.js
// keeps its own localStorage snapshot so offline behavior stays predictable.

// v11 -> v12: added concursus.js (Phase 1 CONCURSUS tab port) and the
// five self-hosted Signature Lock font files (Phase 0 req 11 forbids the
// runtime Google Fonts request the roadmap doc's graft block used, so
// these are precached here instead of ever being fetched at runtime).
// Still v12, not a further bump -- this branch hasn't shipped yet, so
// there's no deployed v12 shell to migrate away from.
const CACHE_NAME = "tasks-shell-v12";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./concursus.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./fonts/playfair-display-latin-500-normal.woff2",
  "./fonts/playfair-display-latin-700-normal.woff2",
  "./fonts/roboto-slab-latin-300-normal.woff2",
  "./fonts/roboto-slab-latin-400-normal.woff2",
  "./fonts/roboto-slab-latin-600-normal.woff2",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never touch API calls — those go straight to the network,
  // app.js handles offline fallback for those itself.
  if (event.request.method !== "GET" || url.pathname.includes("/api/")) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      });
    })
  );
});
