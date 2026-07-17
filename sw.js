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
// v15 -> v16: DM3-01 (Domain model v3 -- FAMILY, the fifth mandate domain).
// Changed contents of concursus.js (state v1->v2 migration, FAMILY roll
// table/mandateFor, DOMAINS list, second Non-Negotiables accordion) and
// app.js (strip text, comment) only -- no new files in SHELL, but a real
// bump anyway per the same v12->v13 lesson above: without it this sw.js
// would be byte-identical and an already-installed PWA would keep serving
// the stale four-domain shell indefinitely.
// v16 -> v17: 2.1 Today's Mandate Ring (segmented donut replaces the text
// strip; #concursus-strip element renamed #mandate-ring) and 2.2 local
// mandate-history contract (concursus-history-v1 writes in concursus.js).
// Changed contents of index.html, app.js, concursus.js, and styles.css —
// no new files in SHELL, real bump per the standing v12->v13 lesson.
// v17 -> v18: 2.1.1 domain color semantics (locked five-color map replaces
// the all-coral ring; neutral track + opacity carries state) and 2.3
// Weekly Mandate Review (seven-day rings + diagnosis in #concursus-view,
// read from CONCURSUS.history(7)). Changed contents of app.js,
// concursus.js, and styles.css — no new files in SHELL, real bump per the
// standing v12->v13 lesson.
// v18 -> v19: 2.3 layout revision — Weekly Mandate Review moves from the
// bottom of #concursus-view to directly below the roll line, above the
// domain cards; domain totals + FAMILY coverage fold into a collapsed
// TOTALS disclosure (inferable from the rings — drill-down, not layout).
// Changed contents of concursus.js and styles.css.
// v19 -> v20: 2.5 relative due-date labels. Raw YYYY-MM-DD tags are now
// decision-useful local-date labels, with Today-header suppression and
// overdue escalation styling. Changed app.js and styles.css.
// v20 -> v21: 3.1 token consolidation (Narrowkind palette, three-layer
// tokens, charcoal mode with manual override via the contracted
// localStorage key tasks-theme-v1) + 3.2 motion tokens and inventory
// (coral check-fill, FLIP completion reflow, token-driven durations).
// Changed index.html, styles.css, app.js, manifest.json.
// v21 -> v22: 3.4 shell rename to "Carpe" (display strings only —
// <title>, manifest.json name/short_name; repo path/scope/start_url and
// the Worker's ALLOWED_ORIGIN are untouched) + 3.5 mode-toggle relabel
// (icon-only sun/moon replaces the cream/charcoal text label; same
// click handler, same tasks-theme-v1 contract, no storage or token
// change). Changed index.html, manifest.json, app.js, styles.css.
// v22 -> v23: 3.5 follow-up fix — the toggle's box (24x24 with 8px
// padding on all sides, border-box) was smaller than the SVG's own
// intrinsic 14px size, so the flex layout shrank the icon well below
// spec ("10x smaller" per on-device report). Also moved the button out
// of absolute positioning pinned to the date line and into a new
// .topbar-heading flex row alongside date+h1, so it's vertically
// centered against the view title instead of floating by the small
// date row above it. Icon bumped to 20px (CSS-driven, not just the SVG
// attribute) in a properly sized 40px tap target. No contract change —
// same click handler, same tasks-theme-v1 storage. Changed index.html,
// styles.css, app.js.
// v23 -> v24: bug fix — CONCURSUS (#concursus-view and everything under
// it: .cc-*, .wk-*, the tab-bar's cream/charcoal inversion) was hardcoded
// to a permanent charcoal surface and ignored tasks-theme-v1 entirely, so
// the light/dark toggle only ever affected the Tasks tab. Swapped its
// background/text/border colors over to the same --bg/--ink tokens (plus
// a new --ink-rgb triple for the translucent overlays, and a cream-safe
// --label-tan for the eyebrow labels, which were 1.7:1 on cream). Same
// tasks-theme-v1 contract, no storage change. Changed styles.css only.
// v24 -> v25: bug fix — .bottom-scrim and #concursus-view's own bottom
// padding both reserved --capture-h (110px) on top of the nav-bar
// clearance, but CONCURSUS never renders .capture (it lives inside #app,
// which is display:none on this tab) -- that unused capture height showed
// up as a dead solid-color gap between the last card and the floating
// nav. Both now size to nav-only clearance while CONCURSUS is active;
// scrim itself still shows (still backstops the pill's inset gaps), just
// shorter. Changed styles.css only.
// v25 -> v26: 3.8 — CONCURSUS gets the same frozen-header/scrolling-body
// split Tasks already had (.topbar sticky, #list scrolling under it).
// Previously the whole tab was one undifferentiated block, so nothing
// stayed put on scroll and there was no light/dark toggle button on this
// tab at all. Now: date, ROLL n, the CARPE badge, and the weekly review
// (rings + its one-line diagnosis) live in a new sticky .cc-headbar; the
// cards and non-negotiables scroll underneath in .cc-body. The toggle
// button is a second .mode-toggle (same class/icons/dimensions as the
// Tasks one) built by concursus.js and wired to app.js's toggleTheme() —
// applyTheme() now syncs every .mode-toggle in the DOM instead of just
// the one #mode-toggle by id, so both stay in lockstep. Changed
// concursus.js, app.js, styles.css.
const CACHE_NAME = "tasks-shell-v26";
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
