// Tasks PWA — service worker
// Caches the app shell only. Task data is never cached here — app.js
// keeps its own localStorage snapshot so offline behavior stays predictable.

// v11 -> v12: added concursus.js (Phase 1 CONCURSUS tab port) and the
// five self-hosted Signature Lock font files.
// v12 -> v13: Phase 3 (roll-to-Tasks projection). No new files in SHELL --
// this is a real bump anyway, not a formality: it rewrites the CONTENTS of
// app.js, concursus.js, styles.css, and index.html, all of which were
// already shelled under v12. Without a new CACHE_NAME, this sw.js file
// would be byte-identical to the v12 one, the browser would never detect
// an update, and a phone that already installed v12 during Phase 1
// on-device testing would keep serving the stale pre-Phase-3 shell
// indefinitely.
// v13 -> v14: the "list content peeking behind the floating nav" polish
// fix (bottom-scrim, main padding, tabbar border) changed the CONTENTS of
// app.js, index.html, and styles.css but that commit forgot to bump this
// version -- meaning the service worker had no way to detect anything
// changed and would keep serving the stale v13 shell indefinitely,
// regardless of how many times the installed PWA icon is killed and
// reopened. Reinstalling the home-screen icon does not clear Cache
// Storage; only an actual sw.js byte change (this bump) does.
// v14 -> v15: AB-01 (quick-add due-chip click handler was document-scoped
// and leaked into the edit sheet's due chips), AB-02 (stale CONCURSUS ·
// TODAY rows survived local midnight on a held Tasks view), and AB-03
// (post-boot render(getCache()) calls in setActiveTab, the CONCURSUS
// subscribe callback, and the projected-row check handler could clobber
// the offline connection-error state with a false "No open tasks") all
// changed app.js contents only -- bump needed or the fixes never reach an
// already-installed PWA.
const CACHE_NAME = "tasks-shell-v15";
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
