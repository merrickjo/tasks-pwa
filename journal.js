// JOURNAL tab — 4.6 (30 Oct 2026)
//
// The bullet journal, inside Notch. Three templated spreads:
//   MONTH  m:YYYY-MM     goals · one line per date (with that day's CONCURSUS
//                         marks) · monthly task list
//   WEEK   w:YYYY-Www    focus · seven day slots (each with CONCURSUS marks
//                         and a peek at that day's log) · Sunday review
//   DAY    d:YYYY-MM-DD  CONCURSUS strip · rapid log (• task ○ event – note
//                         × done > migrated)
// 4.7: pages talk to Tasks and the calendar — "• x" / "○ 14:00 x" on a dated
// line sends to Tasks / Google Calendar; each date shows what's already
// scheduled; a sent task that gets done turns its "> x" line into "× x".
// See "4.7 links" below.
//
// Every page has two faces: TYPE (the template's text sections) and INK (a
// 3:4 paper page with the same template printed on it, written on with a
// stylus). Both live in the Worker (D1), so the web app and the APK read the
// same journal; the Mac mirrors it into the vault (Notch/Journal).
//
// Sync model: each page carries a `rev`. Writes send the rev they started
// from; a stale write gets 409 + the current server copy, and we merge —
// text per section (a section you changed keeps your version, others take
// the server's), ink by stroke id (union, minus strokes you erased). Edits
// made offline stay on the device (dirty) and flush on the next chance.
//
// CONCURSUS history becomes durable here too: every device pushes its local
// history (35 days) and today's live state to /api/concursus, and the spreads
// read the merged server copy — so the week/month rows match on every device.
//
// Fast ink (4.6.1): inside the Notch APK on a Bigme device the pen is handed
// to the firmware's own handwriting service (window.NotchInk, see
// android/src/.../BigmeInk.java). It paints on the panel directly with the
// handwriting waveform while the pen moves; each finished stroke comes back
// here (window.__notchInk.stroke) and is stored and drawn exactly like a
// web-canvas stroke. Anywhere else — browsers, other tablets, or if the
// service misbehaves — the canvas ink below is used unchanged.
//
// Load order: after app.js and concursus.js (uses getConfig, api, localISO,
// todayISO, getCache, setCache, sortTasks, render, renderChips, showToast,
// effectiveTheme, modeIcon, toggleTheme, CONCURSUS). app.js owns routing.

const NOTCH_JOURNAL = (function () {
  const CACHE_KEY = "journal-cache-v1";   // { key: record }  (record below)
  const INDEX_KEY = "journal-index-v1";   // { "from|to": { fetchedAt, days, cc, cal } }
  const FINGER_KEY = "journal-finger-v1"; // "1" when a finger may draw
  const VIEW_KEY = "journal-view-v1";     // session: { view, anchor }
  const FACE_KEY = "journal-face-v1";     // last face used (type | ink): new pages open in it
  const CACHE_MAX = 24;
  const INDEX_MAX = 6;
  const REFETCH_MS = 60 * 1000;
  const TEXT_DEBOUNCE = 1200;
  const INK_DEBOUNCE = 1500;
  const PAGE_W = 1000;
  const PAGE_H = 1333;                    // 3:4 — the Bigme's own panel ratio
  const MAX_PAGES = 12;
  const MONTHS = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const CC_DOMAINS = ["intake", "synthesis", "exercise", "scripture", "family"];
  const SIGNIFIERS = [
    ["•", "Task"], ["○", "Event"], ["–", "Note"], ["×", "Done"], [">", "Migrated"],
  ];
  const SIG_RE = /^([•○–×>]|-)\s+/;

  let root = null;
  let view = "day";                // day | week | month
  let anchor = null;               // ISO date the spread is built around
  let status = "";                 // shown in the kicker
  let fingerInk = false;
  let tool = "pen";                // pen | eraser
  let inited = false;
  const timers = {};               // debounce timers by "text:key" / "ink:key:page"
  const inflight = {};
  const canvases = [];             // live ink surfaces on screen

  // ---------- dates ----------
  function parseISO(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
  function addDays(s, n) { const d = parseISO(s); d.setDate(d.getDate() + n); return localISO(d); }
  function mondayOf(s) { const d = parseISO(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return localISO(d); }
  function isoWeek(s) {
    // ISO 8601: the week belongs to the year of its Thursday.
    const d = parseISO(s);
    const thu = new Date(d); thu.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 3);
    const year = thu.getFullYear();
    const jan4 = new Date(year, 0, 4);
    const week1Thu = new Date(jan4); week1Thu.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7) + 3);
    const week = 1 + Math.round((thu - week1Thu) / (7 * 86400000));
    return { year, week };
  }
  function keyFor(v, s) {
    if (v === "day") return "d:" + s;
    if (v === "month") return "m:" + s.slice(0, 7);
    const w = isoWeek(s);
    return `w:${w.year}-W${String(w.week).padStart(2, "0")}`;
  }
  function monthDays(s) {
    const d = parseISO(s);
    const n = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const out = [];
    for (let i = 1; i <= n; i++) out.push(localISO(new Date(d.getFullYear(), d.getMonth(), i)));
    return out;
  }
  function weekDays(s) { const m = mondayOf(s); return [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(m, i)); }
  function rangeFor() {
    const days = view === "month" ? monthDays(anchor) : view === "week" ? weekDays(anchor) : [anchor];
    return { from: days[0], to: days[days.length - 1], days };
  }
  function shortDay(s) { const d = parseISO(s); return `${DOW[d.getDay()]} ${d.getDate()}`; }

  // ---------- network ----------
  // Own fetch rather than app.js's apiFetch: a 409 carries the server copy
  // we need for the merge, and apiFetch throws the body away.
  async function req(method, path, body) {
    const cfg = getConfig();
    const res = await fetch(api(path), {
      method,
      headers: { "content-type": "application/json", "x-app-key": cfg.key },
      body: body === undefined ? undefined : JSON.stringify(body),
      keepalive: method !== "GET" && body !== undefined && JSON.stringify(body).length < 60000,
    });
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, data };
  }
  const enc = (key) => "/api/journal/" + encodeURIComponent(key);

  // ---------- local cache ----------
  // record = { entry: { key, kind, sections, mode, rev, ink:[{page,strokes,rev}] },
  //            base: { sections }  (last server-agreed text),
  //            dirtyText: bool, dirtyInk: { page: true },
  //            deleted: { page: [strokeId] }  (erased since last ink sync),
  //            fetchedAt, touched }
  function readAll() { try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch { return {}; } }
  let mem = null;
  function all() { if (!mem) mem = readAll(); return mem; }
  function persist() {
    const c = all();
    const keys = Object.keys(c).sort((a, b) => (c[b].touched || 0) - (c[a].touched || 0));
    // Never evict a record that still has unsynced edits.
    keys.slice(CACHE_MAX).forEach((k) => { if (!isDirty(c[k])) delete c[k]; });
    for (let tries = 0; tries < 6; tries++) {
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); return true; }
      catch {
        const victim = Object.keys(c).filter((k) => !isDirty(c[k]))
          .sort((a, b) => (c[a].touched || 0) - (c[b].touched || 0))[0];
        if (!victim) return false;
        delete c[victim];
      }
    }
    return false;
  }
  function isDirty(r) { return !!(r && (r.dirtyText || Object.keys(r.dirtyInk || {}).length)); }
  function lastFace() { try { return localStorage.getItem(FACE_KEY) === "ink" ? "ink" : "type"; } catch { return "type"; } }
  function blank(key) {
    return { key, kind: { d: "day", w: "week", m: "month" }[key[0]], sections: {}, mode: lastFace(), rev: 0, ink: [] };
  }
  function rec(key) {
    const c = all();
    if (!c[key]) c[key] = { entry: blank(key), base: { sections: {} }, dirtyText: false, dirtyInk: {}, deleted: {}, fetchedAt: 0 };
    c[key].touched = Date.now();
    return c[key];
  }
  function inkPage(r, page) {
    let p = r.entry.ink.find((x) => x.page === page);
    if (!p) { p = { page, strokes: [], rev: 0 }; r.entry.ink.push(p); r.entry.ink.sort((a, b) => a.page - b.page); }
    return p;
  }

  async function fetchEntry(key, force) {
    const r = rec(key);
    if (!force && Date.now() - r.fetchedAt < REFETCH_MS) return;
    try {
      const res = await req("GET", enc(key));
      if (res.status !== 200 || !res.data) throw new Error("HTTP " + res.status);
      const s = res.data;
      // A page that doesn't exist on the server yet keeps the face it opened
      // in (the last one used); an existing page brings its own.
      const exists = s.rev > 0 || (s.ink || []).some((p) => p.strokes && p.strokes.length);
      if (!r.dirtyText) { r.entry.sections = s.sections || {}; r.entry.rev = s.rev; r.base = { sections: { ...(s.sections || {}) } }; if (exists && !r.fetchedAt) r.entry.mode = s.mode; }
      (s.ink || []).forEach((sp) => {
        if (r.dirtyInk[sp.page]) return; // our flush will merge
        const lp = inkPage(r, sp.page);
        lp.strokes = sp.strokes; lp.rev = sp.rev;
      });
      r.fetchedAt = Date.now();
      persist();
      if (isDirty(r)) flushAll(key);
    } catch {
      setStatus("offline — showing this device's copy");
    }
  }

  // ---------- text save ----------
  function markText(key) {
    const r = rec(key);
    r.dirtyText = true;
    persist();
    noteShown(key);
    setStatus("editing…");
    clearTimeout(timers["text:" + key]);
    timers["text:" + key] = setTimeout(() => flushText(key), TEXT_DEBOUNCE);
  }
  async function flushText(key) {
    const r = rec(key);
    if (!r.dirtyText || inflight["text:" + key]) return;
    inflight["text:" + key] = true;
    setStatus("saving…");
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const sent = JSON.stringify(r.entry.sections);
        const res = await req("PUT", enc(key), { sections: r.entry.sections, mode: r.entry.mode, base_rev: r.entry.rev });
        if (res.status === 200) {
          r.entry.rev = res.data.rev;
          r.base = { sections: JSON.parse(sent) };
          r.dirtyText = JSON.stringify(r.entry.sections) !== sent; // typed during the request?
          r.fetchedAt = Date.now();
          persist();
          setStatus("saved");
          if (r.dirtyText) markText(key);
          return;
        }
        if (res.status === 409 && res.data) {
          // Per-section merge: a section changed here keeps this device's
          // text; every other section takes the server's.
          const server = res.data.sections || {};
          const base = r.base.sections || {};
          const merged = {};
          new Set([...Object.keys(server), ...Object.keys(r.entry.sections)]).forEach((id) => {
            const local = r.entry.sections[id];
            const changedHere = (local || "") !== (base[id] || "");
            merged[id] = changedHere ? (local || "") : (server[id] || "");
          });
          r.entry.sections = merged;
          r.base = { sections: { ...server } };
          r.entry.rev = res.data.rev;
          setStatus("merged with another device");
          if (isOpen(key)) renderSoon();
          continue;
        }
        throw new Error("HTTP " + res.status + (res.data && res.data.error ? " — " + res.data.error : ""));
      }
    } catch (e) {
      setStatus(navigator.onLine === false ? "offline — saved on this device" : "not saved yet — " + (e.message || e));
    } finally {
      inflight["text:" + key] = false;
      persist();
    }
  }

  // ---------- ink save ----------
  function markInk(key, page) {
    const r = rec(key);
    r.dirtyInk[page] = true;
    persist();
    noteShown(key);
    clearTimeout(timers[`ink:${key}:${page}`]);
    timers[`ink:${key}:${page}`] = setTimeout(() => flushInk(key, page), INK_DEBOUNCE);
  }
  async function flushInk(key, page) {
    const r = rec(key);
    const id = `ink:${key}:${page}`;
    if (!r.dirtyInk[page] || inflight[id]) return;
    inflight[id] = true;
    setStatus("saving ink…");
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const lp = inkPage(r, page);
        const sentIds = lp.strokes.map((s) => s.id).join(",");
        const sentDeleted = (r.deleted[page] || []).slice();
        const res = await req("PUT", `${enc(key)}/ink/${page}`, { strokes: lp.strokes, base_rev: lp.rev });
        if (res.status === 200) {
          lp.rev = res.data.rev;
          r.deleted[page] = (r.deleted[page] || []).filter((x) => !sentDeleted.includes(x));
          const nowIds = lp.strokes.map((s) => s.id).join(",");
          if (nowIds === sentIds) delete r.dirtyInk[page];
          r.fetchedAt = Date.now();
          persist();
          setStatus("saved");
          if (r.dirtyInk[page]) markInk(key, page);
          return;
        }
        if (res.status === 409 && res.data) {
          // Union by stroke id, minus what was erased here.
          const gone = new Set(r.deleted[page] || []);
          const have = new Set(lp.strokes.map((s) => s.id));
          (res.data.strokes || []).forEach((s) => { if (!have.has(s.id) && !gone.has(s.id)) lp.strokes.push(s); });
          lp.rev = res.data.rev;
          setStatus("merged ink from another device");
          redrawPage(key, page);
          continue;
        }
        throw new Error("HTTP " + res.status + (res.data && res.data.error ? " — " + res.data.error : ""));
      }
    } catch (e) {
      setStatus(navigator.onLine === false ? "offline — ink saved on this device" : "ink not saved yet — " + (e.message || e));
    } finally {
      inflight[id] = false;
      persist();
    }
  }

  function flushAll(onlyKey) {
    const c = all();
    Object.keys(c).forEach((key) => {
      if (onlyKey && key !== onlyKey) return;
      const r = c[key];
      if (r.dirtyText) flushText(key);
      Object.keys(r.dirtyInk || {}).forEach((p) => flushInk(key, Number(p)));
    });
  }

  // ---------- index + CONCURSUS (for spreads) ----------
  function readIndex() { try { return JSON.parse(localStorage.getItem(INDEX_KEY)) || {}; } catch { return {}; } }
  function cachedIndex(range) { return readIndex()[`${range.from}|${range.to}`] || null; }
  function writeIndex(range, data) {
    const idx = readIndex();
    idx[`${range.from}|${range.to}`] = { fetchedAt: Date.now(), ...data };
    const keys = Object.keys(idx).sort((a, b) => idx[b].fetchedAt - idx[a].fetchedAt);
    keys.slice(INDEX_MAX).forEach((k) => delete idx[k]);
    try { localStorage.setItem(INDEX_KEY, JSON.stringify(idx)); } catch {}
  }
  // 4.6.2 — warm the cache for the spreads one tap away (this day's week and
  // month, and the days either side), so switching Month / Week / Day or
  // flipping a day draws once from cache instead of drawing, then redrawing
  // when the network answers. Quiet: no renders, no status changes.
  let prefetchedFor = "";
  async function prefetchAround() {
    const tag = view + "|" + anchor;
    if (prefetchedFor === tag || !getConfig()) return;
    prefetchedFor = tag;
    const keys = [keyFor("day", anchor), keyFor("week", anchor), keyFor("month", anchor),
      keyFor("day", addDays(anchor, 1)), keyFor("day", addDays(anchor, -1))];
    for (const k of keys) if (k !== currentKey()) await fetchEntry(k).catch(() => {});
    const saved = view;
    for (const v of ["day", "week", "month"]) {
      if (v === saved) continue;
      view = v;
      const range = rangeFor();
      view = saved;
      const c = cachedIndex(range);
      if (c && c.cal && Date.now() - c.fetchedAt < REFETCH_MS) continue;
      try { await fetchIndex(v, range, c); } catch {}
    }
  }

  // One round for a spread: day-page index, CONCURSUS, and (4.7) the
  // calendar — Outlook mirror + Google — flattened. A calendar failure keeps
  // the last copy rather than blanking the "scheduled" lines.
  async function fetchIndex(v, range, prev) {
    const [j, cc, cal] = await Promise.all([
      v === "day" ? Promise.resolve({ status: 200, data: { days: {} } }) : req("GET", `/api/journal?from=${range.from}&to=${range.to}`),
      req("GET", `/api/concursus?from=${range.from}&to=${range.to}`),
      req("GET", `/api/calendar?from=${range.from}&to=${range.to}`).catch(() => ({ status: 0 })),
    ]);
    if (j.status !== 200 || cc.status !== 200) throw new Error("index");
    let events = (prev && prev.cal) || [];
    if (cal.status === 200 && cal.data) {
      events = [...(cal.data.outlook ? cal.data.outlook.events : []), ...(cal.data.google ? cal.data.google.events : [])]
        .map((e) => ({ id: e.id || "", date: e.date, title: e.title, start: e.start, allDay: !!e.allDay, source: e.source }));
    }
    writeIndex(range, { days: j.data.days || {}, cc: cc.data.days || {}, cal: events });
  }

  async function loadIndex(force) {
    const range = rangeFor();
    const c = cachedIndex(range);
    if (!force && c && c.cal && Date.now() - c.fetchedAt < REFETCH_MS) return;
    try {
      await fetchIndex(view, range, c);
      if (rangeFor().from === range.from) renderSoon();
    } catch { /* spreads still render from cache + local history */ }
  }

  // Local truth for CONCURSUS: this device's history plus today's live
  // state. Server copy fills days this device never saw.
  function concursusFor(range) {
    const out = {};
    const idx = cachedIndex(range);
    if (idx && idx.cc) Object.assign(out, idx.cc);
    if (typeof CONCURSUS !== "undefined") {
      try {
        CONCURSUS.history(35).forEach((h) => { if (h.snapshot && h.date >= range.from && h.date <= range.to) out[h.date] = h.snapshot; });
        const st = CONCURSUS.status();
        if (st.roll !== null && st.date >= range.from && st.date <= range.to) {
          out[st.date] = { roll: st.roll, done: st.domains, notch: st.notch };
        }
      } catch {}
    }
    return out;
  }
  let ccPushTimer = null;
  function pushConcursus() {
    clearTimeout(ccPushTimer);
    ccPushTimer = setTimeout(async () => {
      if (typeof CONCURSUS === "undefined" || !getConfig()) return;
      const days = {};
      try {
        const today = todayISO();
        CONCURSUS.history(35).forEach((h) => {
          if (!h.snapshot) return;
          // Past days only fill gaps on the server ("0" sorts before any
          // real timestamp); today's live state carries a real clock.
          days[h.date] = { ...h.snapshot, at: h.date === today ? new Date().toISOString() : "0" };
        });
        const st = CONCURSUS.status();
        if (st.roll !== null) days[st.date] = { roll: st.roll, done: st.domains, notch: st.notch, at: new Date().toISOString() };
      } catch { return; }
      if (!Object.keys(days).length) return;
      try { await req("PUT", "/api/concursus", { days }); } catch {}
    }, 800);
  }
  function ccMarks(snap) {
    if (!snap) return "·····";
    return CC_DOMAINS.map((k) => (snap.done && snap.done[k] ? "■" : "□")).join("");
  }

  // ---------- DOM helpers ----------
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function button(cls, text, label, onClick) {
    const b = el("button", cls, text);
    b.type = "button";
    if (label) b.setAttribute("aria-label", label);
    b.addEventListener("click", onClick);
    return b;
  }
  function setStatus(s) {
    status = s;
    const k = root && root.querySelector(".jn-status");
    if (k) k.textContent = s ? " · " + s : "";
  }
  function isOpen(key) { return root && root.style.display !== "none" && currentKey() === key; }
  function currentKey() { return keyFor(view, anchor); }
  let renderQueued = false;
  // 4.6.2 — on e-ink every DOM rebuild is a full panel refresh you can see,
  // so a background sync that brings nothing new must not rebuild. The
  // signature covers everything a spread displays; renderSoon() only
  // rebuilds when it changed. Edits made on this page are already on screen,
  // so they move the baseline instead of triggering a rebuild.
  let lastSig = "";
  function hashStr(str) { let h = 0; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0; return h; }
  function viewSig() {
    const key = currentKey();
    const r = all()[key];
    const e = r ? r.entry : blank(key);
    const range = rangeFor();
    const idx = view === "day" ? null : cachedIndex(range);
    const inkIds = (e.ink || []).map((p) => p.page + ":" + hashStr(p.strokes.map((x) => x.id).join(","))).join("|");
    return [key, view, anchor, e.mode, tool, fingerInk, todayISO(),
      hashStr(JSON.stringify(e.sections || {})), inkIds,
      idx ? hashStr(JSON.stringify(idx.days || {})) : "",
      hashStr(JSON.stringify(((cachedIndex(range) || {}).cal) || [])),
      hashStr(JSON.stringify(dueInRange(range))),
      hashStr(JSON.stringify(concursusFor(range)))].join("§");
  }
  function dueInRange(range) {
    try { return getCache().filter((t) => { const d = dueDate(t.due); return d && d >= range.from && d <= range.to; }).map((t) => [t.id, t.title, t.due, t.priority]); }
    catch { return []; }
  }
  function noteShown(key) { if (root && key === currentKey()) lastSig = viewSig(); }
  let forceNext = false;
  function renderSoon(force) {
    if (force) forceNext = true;
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      if (!root || root.style.display === "none") return;
      // Don't yank a textarea out from under the cursor.
      const a = document.activeElement;
      if (a && root.contains(a) && (a.tagName === "TEXTAREA" || a.tagName === "INPUT")) return;
      if (viewSig() === lastSig && !forceNext) return;
      forceNext = false;
      render();
    });
  }

  // ---------- render ----------
  function render() {
    if (!root) return;
    const key = currentKey();
    const r = rec(key);
    applyDone(key, r);   // 4.7 — "> x" → "× x" for tasks finished elsewhere
    maybeLoadDone(r);
    lastSig = viewSig();
    canvases.length = 0;
    root.innerHTML = "";
    root.appendChild(buildHeader(r));
    const body = el("div", "jn-body");
    if (r.entry.mode === "ink") body.appendChild(buildInk(key, r));
    else if (view === "day") body.appendChild(buildDay(key, r));
    else if (view === "week") body.appendChild(buildWeek(key, r));
    else body.appendChild(buildMonth(key, r));
    root.appendChild(body);
    if (r.entry.mode === "ink") requestAnimationFrame(() => { canvases.forEach((c) => c.resize()); nativeStart(); });
    else nativeStop();
    todaySoon();
  }

  function titleFor() {
    const d = parseISO(anchor);
    if (view === "day") return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
    if (view === "month") return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
    const w = weekDays(anchor);
    const a = parseISO(w[0]), b = parseISO(w[6]);
    const span = a.getMonth() === b.getMonth()
      ? `${a.getDate()}–${b.getDate()} ${MONTHS[a.getMonth()].slice(0, 3)}`
      : `${a.getDate()} ${MONTHS[a.getMonth()].slice(0, 3)} – ${b.getDate()} ${MONTHS[b.getMonth()].slice(0, 3)}`;
    return `Week ${isoWeek(anchor).week} · ${span}`;
  }
  function kickerFor() {
    const label = { day: "Daily log", week: "Weekly spread", month: "Monthly log" }[view];
    return label;
  }

  function buildHeader(r) {
    const bar = el("div", "jn-headbar");
    const row = el("div", "jn-headbar-row");
    const heading = el("div", "jn-heading");
    const kick = el("div", "jn-kicker", kickerFor());
    kick.appendChild(el("span", "jn-status", status ? " · " + status : ""));
    heading.appendChild(kick);
    heading.appendChild(el("h1", "jn-title", titleFor()));
    row.appendChild(heading);
    const nav = el("div", "jn-nav");
    nav.appendChild(button("jn-nav-btn", "‹", "Previous", () => shift(-1)));
    const today = todayISO();
    const tb = button("jn-today-btn", "Today", "Go to today", () => go(view, today));
    if (keyFor(view, anchor) === keyFor(view, today)) tb.disabled = true;
    nav.appendChild(tb);
    nav.appendChild(button("jn-nav-btn", "›", "Next", () => shift(1)));
    const mode = button("mode-toggle", "", "Switch background mode", () => toggleTheme());
    mode.innerHTML = modeIcon(effectiveTheme());
    nav.appendChild(mode);
    row.appendChild(nav);
    bar.appendChild(row);

    const seg = el("div", "jn-seg-row");
    const views = el("div", "jn-seg");
    [["month", "Month"], ["week", "Week"], ["day", "Day"]].forEach(([v, label]) => {
      const b = button("jn-seg-btn" + (view === v ? " active" : ""), label, null, () => go(v, anchor));
      b.setAttribute("aria-pressed", String(view === v));
      views.appendChild(b);
    });
    seg.appendChild(views);
    const faces = el("div", "jn-seg");
    [["type", "Type"], ["ink", "Ink"]].forEach(([m, label]) => {
      const b = button("jn-seg-btn" + (r.entry.mode === m ? " active" : ""), label, null, () => setMode(m));
      b.setAttribute("aria-pressed", String(r.entry.mode === m));
      faces.appendChild(b);
    });
    seg.appendChild(faces);
    bar.appendChild(seg);
    return bar;
  }

  function setMode(m) {
    const key = currentKey();
    const r = rec(key);
    if (r.entry.mode === m) return;
    r.entry.mode = m;
    try { localStorage.setItem(FACE_KEY, m); } catch {}
    persist();
    render();
    // The face you last used is remembered per page, on every device.
    markText(key);
  }

  // ----- text sections -----
  function sectionLabel(text, hint) {
    const h = el("div", "jn-section-label", text);
    if (hint) h.appendChild(el("span", "jn-section-hint", hint));
    return h;
  }
  function textArea(key, r, id, placeholder, opts = {}) {
    const ta = el("textarea", "jn-text" + (opts.small ? " jn-text-small" : ""));
    ta.value = r.entry.sections[id] || "";
    ta.placeholder = placeholder || "";
    ta.rows = opts.rows || 3;
    ta.dataset.section = id;
    ta.dataset.key = key;
    ta.spellcheck = true;
    const fit = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + 2 + "px"; };
    ta.addEventListener("input", () => {
      r.entry.sections[id] = ta.value;
      fit();
      mirror(key, id, ta);
      markText(key);
      if (opts.onInput) opts.onInput();
    });
    ta.addEventListener("blur", () => { if (rec(key).dirtyText) { clearTimeout(timers["text:" + key]); flushText(key); } });
    requestAnimationFrame(fit);
    return ta;
  }
  // 4.8 — the same page can be open twice (Journal → Day for today and the
  // desktop Today pane). Typing in one updates its twin in place: no
  // rebuild, no lost caret.
  function mirror(key, id, src) {
    document.querySelectorAll("textarea.jn-text").forEach((t) => {
      if (t === src || t.dataset.key !== key || t.dataset.section !== id) return;
      t.value = src.value;
      t.style.height = "auto"; t.style.height = t.scrollHeight + 2 + "px";
    });
    fillSendRow();
  }
  function signifierBar(ta) {
    const bar = el("div", "jn-sigbar");
    SIGNIFIERS.forEach(([g, name]) => {
      const b = button("jn-sig-btn", g, name, () => {
        const tgt = typeof ta === "function" ? ta() : ta;
        if (!tgt) return;
        signify(tgt, g);
      });
      // Keep the focused line focused (and its caret) while tapping a glyph.
      b.addEventListener("pointerdown", (e) => e.preventDefault());
      bar.appendChild(b);
    });
    return bar;
  }
  function signify(ta, g) {
    const v = ta.value;
    const pos = ta.selectionStart || 0;
    const start = v.lastIndexOf("\n", pos - 1) + 1;
    let end = v.indexOf("\n", start); if (end < 0) end = v.length;
    const line = v.slice(start, end).replace(SIG_RE, "");
    const next = `${g} ${line}`;
    ta.value = v.slice(0, start) + next + v.slice(end);
    const caret = start + next.length;
    ta.focus();
    ta.setSelectionRange(caret, caret);
    ta.dispatchEvent(new Event("input"));
  }
  // Week and month: one bar for many lines — it acts on the line last touched.
  let lastField = null;
  function trackField(f) { f.addEventListener("focus", () => { lastField = f; }); return f; }
  // ---------- 4.7 links: journal ↔ Tasks / Calendar ----------
  // OUT  "• x" on a dated line → a Notch task due that date; "○ 14:00 x" →
  //      a Google Calendar event that date (no time = all day; no end = 1h).
  //      Dated lines: the day log, the week's seven day slots, the month's
  //      per-date lines. The month's Tasks list sends undated tasks.
  //      A sent line becomes "> x" — the bullet-journal mark for migrated.
  // IN   every date shows what Tasks and the calendar already hold for it,
  //      read-only, beside your own lines.
  // BACK the page remembers which task each sent line became (hidden
  //      section "_links"); when that task is done, "> x" becomes "× x".
  //      Edit the line and the link lets go quietly — it never guesses.
  const LINKS = "_links";
  const TASK_LINE = /^(\s*)•\s+(\S.*)$/;
  const EVENT_LINE = /^(\s*)○\s+(\S.*)$/;
  const MOVED_LINE = /^(\s*)>\s+(\S.*)$/;
  const EV_TIME = /^(\d{1,2})[:.](\d{2})(?:\s*[-–]\s*(\d{1,2})[:.](\d{2}))?\s+(\S.*)$/;

  function linksOf(r) {
    try { const l = JSON.parse(r.entry.sections[LINKS] || "[]"); return Array.isArray(l) ? l : []; } catch { return []; }
  }
  function setLinks(r, list) {
    if (list.length) r.entry.sections[LINKS] = JSON.stringify(list.slice(-200));
    else if (r.entry.sections[LINKS]) r.entry.sections[LINKS] = "";
  }
  // [sectionId, date | null] for the sections on this spread that can send.
  function datedSections() {
    if (view === "day") return [["log", anchor]];
    if (view === "week") return weekDays(anchor).map((d, i) => ["d" + i, d]);
    return monthDays(anchor).map((d) => ["l" + d.slice(8), d]).concat([["tasks", null]]);
  }
  const pad2 = (n) => String(n).padStart(2, "0");
  // "14:00 review" · "9.30-10:15 review" · "review" (all day). null = a time
  // that can't be a calendar slot (25:00, end before start).
  function parseEventText(rest) {
    const m = EV_TIME.exec(rest);
    if (!m) return { title: rest, start: null, end: null };
    const h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return null;
    const start = pad2(h) + ":" + pad2(mi);
    let end;
    if (m[3] !== undefined) {
      if (+m[3] > 23 || +m[4] > 59) return null;
      end = pad2(+m[3]) + ":" + pad2(+m[4]);
    } else {
      const t = Math.min(h * 60 + mi + 60, 23 * 60 + 59);
      end = pad2(Math.floor(t / 60)) + ":" + pad2(t % 60);
    }
    if (end <= start) return null;
    return { title: m[5].trim(), start, end };
  }
  function pendingIn(r, sections) {
    const out = [];
    (sections || datedSections()).forEach(([id, date]) => {
      (r.entry.sections[id] || "").split("\n").forEach((raw) => {
        let m = TASK_LINE.exec(raw);
        if (m) { out.push({ id, date, raw, indent: m[1], rest: m[2].trim(), kind: "task" }); return; }
        m = EVENT_LINE.exec(raw);
        if (m && date) out.push({ id, date, raw, indent: m[1], rest: m[2].trim(), kind: "event" });
      });
    });
    return out;
  }
  let sending = false;
  async function sendAll(key, r, btn, sections) {
    const items = pendingIn(r, sections);
    if (!items.length || sending) return;
    sending = true;
    btn.disabled = true;
    btn.textContent = "Sending…";
    const links = linksOf(r);
    let tasks = 0, events = 0, badTime = 0, googleOff = false;
    for (const it of items) {
      let res;
      try {
        if (it.kind === "task") {
          const payload = { title: it.rest.slice(0, 200), priority: "P3 - Medium" };
          if (it.date) payload.due = it.date;
          res = await req("POST", "/api/tasks", payload);
          if (res.status !== 201) throw new Error("HTTP " + res.status);
          try { setCache([res.data, ...getCache()]); } catch {}
          tasks++;
        } else {
          if (googleOff) continue;
          const ev = parseEventText(it.rest);
          if (!ev) { badTime++; continue; }
          const body = { title: ev.title.slice(0, 200), date: it.date };
          if (ev.start) { body.start = ev.start; body.end = ev.end; }
          res = await req("POST", "/api/calendar/events", body);
          if (res.status === 409) { googleOff = true; continue; }
          if (res.status !== 201) throw new Error("HTTP " + res.status);
          events++;
        }
      } catch { break; }
      // Re-find the line by its text: you may have typed while this ran.
      const lines = (r.entry.sections[it.id] || "").split("\n");
      const i = lines.indexOf(it.raw);
      if (i >= 0) lines[i] = `${it.indent}> ${it.rest}`;
      r.entry.sections[it.id] = lines.join("\n");
      links.push({ s: it.id, t: it.rest, id: (res.data && res.data.id) || "", k: it.kind });
    }
    sending = false;
    setLinks(r, links);
    markText(key);
    const left = items.length - tasks - events;
    const parts = [];
    if (tasks) parts.push(`${tasks} task${tasks === 1 ? "" : "s"} → Tasks`);
    if (events) parts.push(`${events} event${events === 1 ? "" : "s"} → Calendar`);
    if (googleOff) parts.push("Google isn't connected — ○ lines stayed");
    else if (badTime) parts.push(`${badTime} ○ line${badTime === 1 ? " has" : "s have"} a time that doesn't work`);
    if (left - badTime > 0 && !googleOff) parts.push(`${left - badTime} not sent — check your connection`);
    showToast(parts.join(" · ") || "Nothing sent");
    if (events) {
      // Every cached spread's calendar is now out of date, not just this one.
      try { localStorage.removeItem("calendar-cache-v1"); } catch {}
      try { const idx = readIndex(); Object.values(idx).forEach((v) => { v.fetchedAt = 0; }); localStorage.setItem(INDEX_KEY, JSON.stringify(idx)); } catch {}
      prefetchedFor = "";
      loadIndex(true);
    }
    renderTasksTab();
    if (root && root.style.display !== "none") render();
    renderToday();
  }
  function renderTasksTab() {
    // app.js's top-level render() is shadowed inside this module; reach it
    // through window (classic-script function declarations live there).
    try { const s = sortTasks(getCache()); renderChips(s); if (typeof window.render === "function") window.render(s); } catch {}
  }
  function sendLabel(r, sections) {
    const items = pendingIn(r, sections);
    const t = items.filter((x) => x.kind === "task").length;
    const e = items.length - t;
    if (!items.length) return ["• → Tasks · ○ → Calendar", false];
    return [`Send ${[t ? t + " •" : "", e ? e + " ○" : ""].filter(Boolean).join(" · ")} →`, true];
  }
  // A send row knows its own sections, so the main spread and the Today
  // pane (4.8) each get one.
  function makeSendRow(key, r, sections) {
    const row = el("div", "jn-actions");
    row._fill = () => {
      if (sending) return;
      const [label, on] = sendLabel(r, sections);
      const b = button("jn-link-btn", label, null, () => sendAll(key, r, b, sections));
      b.disabled = !on;
      row.replaceChildren(b);
    };
    row._fill();
    return row;
  }
  let sendRowEl = null;
  function sendRow(key, r) { sendRowEl = makeSendRow(key, r, datedSections()); return sendRowEl; }
  function fillSendRow() { if (sendRowEl) sendRowEl._fill(); if (todayPane.row) todayPane.row._fill(); }

  // BACK: a linked "> x" whose task is done becomes "× x". Runs inside
  // render() only, so it never edits text under a cursor.
  let doneIds = new Set(), doneAt = 0, doneLoading = false;
  function applyDone(key, r) {
    const links = linksOf(r);
    if (!links.length) return;
    const keep = [];
    let changed = false;
    links.forEach((l) => {
      const lines = (r.entry.sections[l.s] || "").split("\n");
      const i = lines.findIndex((x) => { const m = MOVED_LINE.exec(x); return m && m[2].trim() === l.t; });
      if (i < 0) { changed = true; return; } // line edited or gone: let go
      if (l.k === "task" && doneIds.has(l.id)) {
        lines[i] = lines[i].replace(/^(\s*)>/, "$1×");
        r.entry.sections[l.s] = lines.join("\n");
        changed = true;
        return;
      }
      keep.push(l);
    });
    if (!changed) return;
    setLinks(r, keep);
    markText(key);
  }
  function maybeLoadDone(r) {
    // The task cache can be stale (done on another device, or in Obsidian),
    // so ask the server — at most once a minute, only for pages with links.
    const waiting = linksOf(r).some((l) => l.k === "task" && l.id && !doneIds.has(l.id));
    if (!waiting || doneLoading || Date.now() - doneAt < REFETCH_MS || !getConfig()) return;
    doneLoading = true;
    req("GET", "/api/tasks/completed?days=120").then((res) => {
      if (res.status !== 200 || !res.data) return;
      doneIds = new Set((res.data.tasks || []).map((t) => t.id));
      doneAt = Date.now();
      const cur = all()[currentKey()];
      if (cur && linksOf(cur).some((l) => l.k === "task" && doneIds.has(l.id))) renderSoon(true);
      const td = all()[keyFor("day", todayISO())];
      if (td && linksOf(td).some((l) => l.k === "task" && doneIds.has(l.id))) todaySoon(true);
    }).catch(() => {}).finally(() => { doneLoading = false; });
  }

  // IN: what Tasks and the calendar hold for a date, minus what this page
  // itself sent (its "> x" line already stands for it).
  function timeOf(s) {
    const d = new Date(s);
    return isNaN(d) ? "" : pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }
  function scheduledFor(date, r, range) {
    range = range || rangeFor();
    const idx = cachedIndex(range);
    const sent = new Set(linksOf(r).map((l) => l.id).filter(Boolean));
    const evs = ((idx && idx.cal) || []).filter((e) => e.date === date && !sent.has(e.id))
      .sort((a, b) => (a.allDay !== b.allDay ? (a.allDay ? -1 : 1) : Date.parse(a.start) - Date.parse(b.start)));
    let tasks = [];
    try { tasks = sortTasks(getCache()).filter((t) => dueDate(t.due) === date && !sent.has(t.id)); } catch {}
    return { evs, tasks };
  }
  function evText(e) { return "○ " + (e.allDay ? "" : timeOf(e.start) + " ") + e.title; }
  function openTask(t) {
    if (typeof setActiveTab !== "function" || typeof openEditSheet !== "function") return;
    setActiveTab("tasks");
    openEditSheet(t, null);
  }
  function scheduledBlock(date, r, range) {
    const { evs, tasks } = scheduledFor(date, r, range);
    const wrap = el("div", "jn-sched");
    wrap.appendChild(sectionLabel("Scheduled", "from Calendar and Tasks · read-only"));
    if (!evs.length && !tasks.length) { wrap.appendChild(el("div", "jn-sched-none", "Nothing scheduled.")); return wrap; }
    evs.forEach((e) => {
      const row = el("div", "jn-sched-row");
      row.appendChild(el("span", "jn-sched-text", evText(e)));
      row.appendChild(el("span", "jn-sched-src", e.source === "google" ? "GOOGLE" : "OUTLOOK"));
      wrap.appendChild(row);
    });
    tasks.forEach((t) => {
      const row = button("jn-sched-row jn-sched-task", "", "Open task: " + t.title, () => openTask(t));
      row.appendChild(el("span", "jn-sched-text", "• " + t.title));
      row.appendChild(el("span", "jn-sched-src", (t.priority || "").slice(0, 2)));
      wrap.appendChild(row);
    });
    return wrap;
  }
  function scheduledLine(date, r, max) {
    const { evs, tasks } = scheduledFor(date, r);
    const items = [...evs.map(evText), ...tasks.map((t) => "• " + t.title)];
    if (!items.length) return null;
    const shown = items.slice(0, max);
    return shown.join(" · ") + (items.length > max ? ` · +${items.length - max}` : "");
  }
  function scheduledCounts(date, r) {
    const { evs, tasks } = scheduledFor(date, r);
    return [evs.length ? "○" + evs.length : "", tasks.length ? "•" + tasks.length : ""].filter(Boolean).join(" ");
  }

  function ccStrip(date) {
    const range = { from: date, to: date };
    const snap = concursusFor(range)[date];
    const strip = el("div", "jn-cc");
    strip.appendChild(el("span", "jn-cc-label", "CONCURSUS"));
    if (!snap) { strip.appendChild(el("span", "jn-cc-none", date === todayISO() ? "not rolled yet" : "no roll recorded")); return strip; }
    strip.appendChild(el("span", "jn-cc-marks", ccMarks(snap)));
    strip.appendChild(el("span", "jn-cc-roll", "d20 · " + snap.roll + (snap.notch ? " · notch" : "")));
    return strip;
  }

  function buildDay(key, r) {
    const wrap = el("div", "jn-page-type");
    wrap.appendChild(ccStrip(anchor));
    wrap.appendChild(scheduledBlock(anchor, r));
    wrap.appendChild(sectionLabel("Rapid log", "• task  ○ event  – note  × done  > migrated"));
    const ta = textArea(key, r, "log", "• call the venue\n○ 14:00 product review\n– idea: …", {
      rows: 10,
      onInput: () => fillSendRow(),
    });
    wrap.appendChild(signifierBar(ta));
    wrap.appendChild(ta);
    wrap.appendChild(sendRow(key, r));
    return wrap;
  }

  function buildWeek(key, r) {
    const range = rangeFor();
    const idx = cachedIndex(range);
    const cc = concursusFor(range);
    const wrap = el("div", "jn-page-type");
    wrap.appendChild(sectionLabel("Focus", "the one or two things this week is for"));
    wrap.appendChild(textArea(key, r, "focus", "", { rows: 2 }));
    wrap.appendChild(sectionLabel("Days", "• → Tasks · ○ 14:00 → Calendar, on that day"));
    lastField = null;
    const fields = [];
    wrap.appendChild(signifierBar(() => lastField || fields[0]));
    const today = todayISO();
    range.days.forEach((date, i) => {
      const row = el("div", "jn-day-row" + (date === today ? " today" : ""));
      const head = el("div", "jn-day-head");
      head.appendChild(el("span", "jn-day-name", shortDay(date)));
      const snap = cc[date];
      head.appendChild(el("span", "jn-cc-marks", ccMarks(snap)));
      if (snap) head.appendChild(el("span", "jn-cc-roll", "d" + snap.roll));
      head.appendChild(button("jn-day-open", "log ›", "Open " + shortDay(date) + " daily log", () => go("day", date)));
      row.appendChild(head);
      const sched = scheduledLine(date, r, 4);
      if (sched) row.appendChild(el("div", "jn-in", sched));
      const ta = trackField(textArea(key, r, "d" + i, "plan", { rows: 1, small: true, onInput: () => fillSendRow() }));
      fields.push(ta);
      row.appendChild(ta);
      const peek = idx && idx.days && idx.days[date];
      if (peek && (peek.first || peek.ink)) {
        row.appendChild(el("div", "jn-peek", (peek.ink ? "✎ " : "") + (peek.first || "handwritten")));
      }
      wrap.appendChild(row);
    });
    wrap.appendChild(sendRow(key, r));
    wrap.appendChild(sectionLabel("Review", "what moved · what didn't · what migrates"));
    wrap.appendChild(textArea(key, r, "review", "", { rows: 4 }));
    return wrap;
  }

  function buildMonth(key, r) {
    const range = rangeFor();
    const idx = cachedIndex(range);
    const cc = concursusFor(range);
    const wrap = el("div", "jn-page-type");
    wrap.appendChild(sectionLabel("Goals"));
    wrap.appendChild(textArea(key, r, "goals", "", { rows: 3 }));

    const rolled = range.days.filter((d) => cc[d]).length;
    const notch = range.days.filter((d) => cc[d] && cc[d].notch).length;
    wrap.appendChild(sectionLabel("Calendar", `CONCURSUS · ${rolled} rolled · ${notch} notch · ○ scheduled • due`));
    lastField = null;
    const fields = [];
    wrap.appendChild(signifierBar(() => lastField || fields[0]));
    const list = el("div", "jn-month-list");
    const today = todayISO();
    range.days.forEach((date) => {
      const d = parseISO(date);
      const row = el("div", "jn-month-row" + (date === today ? " today" : "") + (d.getDay() === 1 ? " monday" : ""));
      const label = button("jn-month-date", `${d.getDate()} ${DOW[d.getDay()][0]}`, "Open " + shortDay(date), () => go("day", date));
      row.appendChild(label);
      row.appendChild(el("span", "jn-cc-marks jn-cc-small", ccMarks(cc[date])));
      const line = el("input", "jn-month-line");
      line.type = "text";
      const id = "l" + String(d.getDate()).padStart(2, "0");
      line.value = r.entry.sections[id] || "";
      line.addEventListener("input", () => { r.entry.sections[id] = line.value; markText(key); fillSendRow(); });
      line.addEventListener("blur", () => { if (rec(key).dirtyText) { clearTimeout(timers["text:" + key]); flushText(key); } });
      trackField(line);
      fields.push(line);
      row.appendChild(line);
      const counts = scheduledCounts(date, r);
      const inEl = el("span", "jn-month-in", counts);
      const sched = counts ? scheduledLine(date, r, 6) : "";
      if (sched) inEl.title = sched;
      row.appendChild(inEl);
      const peek = idx && idx.days && idx.days[date];
      row.appendChild(el("span", "jn-month-peek", peek ? (peek.ink ? "✎" : "") + (peek.text ? "¶" : "") : ""));
      list.appendChild(row);
    });
    wrap.appendChild(list);

    wrap.appendChild(sectionLabel("Tasks", "this month's list — • lines go to Tasks with no date"));
    const ta = textArea(key, r, "tasks", "", { rows: 5, onInput: () => fillSendRow() });
    wrap.appendChild(signifierBar(ta));
    wrap.appendChild(ta);
    wrap.appendChild(sendRow(key, r));
    return wrap;
  }

  // ---------- INK ----------
  // Stroke encoding (stored and synced): { id, w, p } where p is a flat int
  // array — first point absolute [x, y, pressure], then deltas — in page
  // units (1000 × 1333), pressure 0–15. Small, sharp at any size, and the
  // Mac mirror turns it straight into SVG.
  function decode(p) {
    const out = [];
    let x = 0, y = 0, pr = 0;
    for (let i = 0; i + 2 < p.length; i += 3) {
      x += p[i]; y += p[i + 1]; pr += p[i + 2];
      out.push([x, y, pr]);
    }
    return out;
  }
  function encode(pts) {
    const p = [];
    let lx = 0, ly = 0, lp = 0;
    pts.forEach(([x, y, pr]) => { p.push(x - lx, y - ly, pr - lp); lx = x; ly = y; lp = pr; });
    return p;
  }
  function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function svgBackground(key, page) {
    const range = rangeFor();
    const cc = concursusFor(range);
    const parts = [];
    const dots = (x0, y0, x1, y1) => {
      let s = "";
      for (let y = y0; y <= y1; y += 40) for (let x = x0; x <= x1; x += 40) s += `M${x} ${y}h.01`;
      parts.push(`<path d="${s}" class="jn-dots"/>`);
    };
    const text = (x, y, t, cls, anchorAttr) => parts.push(`<text x="${x}" y="${y}" class="${cls}"${anchorAttr ? ` text-anchor="${anchorAttr}"` : ""}>${t.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text>`);
    const rule = (x0, y, x1) => parts.push(`<path d="M${x0} ${y}H${x1}" class="jn-rule"/>`);
    if (page > 0) {
      text(940, 50, `${titleFor()} · p.${page + 1}`, "jn-svg-small", "end");
      dots(60, 100, 940, 1300);
    } else if (view === "day") {
      text(60, 74, titleFor().toUpperCase(), "jn-svg-title");
      const snap = cc[anchor];
      text(940, 74, snap ? `${ccMarks(snap)}  d${snap.roll}` : "CONCURSUS · —", "jn-svg-small", "end");
      rule(60, 100, 940);
      dots(60, 140, 940, 1300);
    } else if (view === "week") {
      text(60, 70, titleFor().toUpperCase(), "jn-svg-title");
      text(60, 112, "FOCUS", "jn-svg-label");
      rule(60, 210, 940);
      const top = 210, band = 136;
      range.days.forEach((date, i) => {
        const y = top + i * band;
        const snap = cc[date];
        text(60, y + 32, shortDay(date).toUpperCase(), "jn-svg-label");
        text(940, y + 32, snap ? `${ccMarks(snap)}  d${snap.roll}` : "·····", "jn-svg-small", "end");
        rule(60, y + band, 940);
      });
      text(60, top + 7 * band + 34, "REVIEW", "jn-svg-label");
    } else {
      text(60, 70, titleFor().toUpperCase(), "jn-svg-title");
      const days = range.days;
      const top = 110, rowH = Math.min(38, Math.floor((1310 - top) / days.length));
      days.forEach((date, i) => {
        const d = parseISO(date);
        const y = top + (i + 1) * rowH;
        text(60, y - 10, `${d.getDate()} ${DOW[d.getDay()][0]}`, "jn-svg-small");
        text(140, y - 10, ccMarks(cc[date]), "jn-svg-tiny");
        rule(60, y, 470);
      });
      parts.push(`<path d="M500 100V1310" class="jn-rule"/>`);
      text(530, 132, "GOALS", "jn-svg-label");
      dots(540, 170, 940, 600);
      text(530, 660, "TASKS", "jn-svg-label");
      dots(540, 700, 940, 1300);
    }
    return `<svg viewBox="0 0 ${PAGE_W} ${PAGE_H}" class="jn-paper" aria-hidden="true">${parts.join("")}</svg>`;
  }

  function buildInk(key, r) {
    const wrap = el("div", "jn-ink");
    const tools = el("div", "jn-tools");
    // Tool switches flip the highlight in place — a rebuild would cost a
    // full e-ink refresh (and redraw every stroke) for one word changing.
    const setTool = (t) => {
      tool = t;
      pen.classList.toggle("active", t === "pen");
      eraser.classList.toggle("active", t === "eraser");
      if (nativeOn) { try { NI.eraser(t === "eraser"); } catch {} }
      noteShown(currentKey());
    };
    const pen = button("jn-tool" + (tool === "pen" ? " active" : ""), "Pen", "Pen", () => setTool("pen"));
    const eraser = button("jn-tool" + (tool === "eraser" ? " active" : ""), "Eraser", "Eraser", () => setTool("eraser"));
    const undo = button("jn-tool", "Undo", "Undo last stroke", () => undoLast());
    const finger = button("jn-tool" + (fingerInk ? " active" : ""), fingerInk ? "Finger draws" : "Finger scrolls", "Toggle finger drawing", () => {
      fingerInk = !fingerInk;
      try { localStorage.setItem(FINGER_KEY, fingerInk ? "1" : "0"); } catch {}
      finger.classList.toggle("active", fingerInk);
      finger.textContent = fingerInk ? "Finger draws" : "Finger scrolls";
      noteShown(currentKey());
    });
    [pen, eraser, undo, finger].forEach((b) => tools.appendChild(b));
    if (NI) tools.appendChild(el("span", "jn-engine", engineLabel()));
    wrap.appendChild(tools);

    const pages = Math.max(1, ...r.entry.ink.map((p) => p.page + 1));
    for (let page = 0; page < pages; page++) wrap.appendChild(buildInkPage(key, r, page));
    const add = button("jn-link-btn", "+ Page", "Add a page", () => {
      if (pages >= MAX_PAGES) { showToast(`Up to ${MAX_PAGES} pages per spread`); return; }
      inkPage(r, pages);
      persist();
      render();
      requestAnimationFrame(() => { const last = root.querySelector(".jn-sheet:last-of-type"); if (last) last.scrollIntoView({ block: "start" }); });
    });
    const actions = el("div", "jn-actions");
    actions.appendChild(add);
    wrap.appendChild(actions);
    return wrap;
  }

  const undoStack = []; // { key, page, add?: stroke, erased?: [strokes] }
  function undoLast() {
    const u = undoStack.pop();
    if (!u) return;
    const r = rec(u.key);
    const lp = inkPage(r, u.page);
    if (u.add) {
      lp.strokes = lp.strokes.filter((s) => s.id !== u.add.id);
      (r.deleted[u.page] = r.deleted[u.page] || []).push(u.add.id);
    }
    if (u.erased) {
      lp.strokes.push(...u.erased);
      const back = new Set(u.erased.map((s) => s.id));
      r.deleted[u.page] = (r.deleted[u.page] || []).filter((id) => !back.has(id));
    }
    markInk(u.key, u.page);
    redrawPage(u.key, u.page);
    nativeClearSoon();
  }

  function redrawPage(key, page) {
    canvases.forEach((c) => { if (c.key === key && c.page === page) c.redraw(); });
  }

  function buildInkPage(key, r, page) {
    const sheet = el("div", "jn-sheet");
    sheet.innerHTML = svgBackground(key, page);
    const canvas = el("canvas", "jn-canvas");
    sheet.appendChild(canvas);
    // desynchronized: lets Chrome skip the compositor for this canvas where
    // supported (a hint; ignored elsewhere). Matters for the non-Bigme path.
    const ctx = canvas.getContext("2d", { desynchronized: true }) || canvas.getContext("2d");
    let scale = 1;
    const inkColor = () => getComputedStyle(root).getPropertyValue("--ink").trim() || "#000";

    function widthFor(w, pr) { return Math.max(0.8, w * scale * (0.35 + 0.65 * (pr / 15))); }
    function strokeLine(a, b, w) {
      ctx.lineWidth = widthFor(w, (a[2] + b[2]) / 2);
      ctx.beginPath();
      ctx.moveTo(a[0] * scale, a[1] * scale);
      ctx.lineTo(b[0] * scale, b[1] * scale);
      ctx.stroke();
    }
    function drawStroke(s) {
      const pts = decode(s.p);
      if (pts.length === 1) {
        ctx.beginPath();
        ctx.arc(pts[0][0] * scale, pts[0][1] * scale, widthFor(s.w, pts[0][2]) / 2, 0, Math.PI * 2);
        ctx.fill();
        return;
      }
      for (let i = 1; i < pts.length; i++) strokeLine(pts[i - 1], pts[i], s.w);
    }
    function redraw() {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const c = inkColor();
      ctx.strokeStyle = c; ctx.fillStyle = c;
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      inkPage(r, page).strokes.forEach(drawStroke);
    }
    function resize() {
      const rect = sheet.getBoundingClientRect();
      if (!rect.width) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.width * dpr * PAGE_H / PAGE_W);
      scale = canvas.width / PAGE_W;
      redraw();
    }
    // Native strokes (Bigme fast ink) arrive in page units and are stored
    // exactly like canvas strokes.
    function addStroke(s) {
      inkPage(r, page).strokes.push(s);
      const c = inkColor();
      ctx.strokeStyle = c; ctx.fillStyle = c; ctx.lineCap = "round"; ctx.lineJoin = "round";
      drawStroke(s);
      undoStack.push({ key, page, add: s });
      if (undoStack.length > 200) undoStack.shift();
      markInk(key, page);
    }
    function erasePoints(list) {
      erasedNow = [];
      list.forEach((pt) => eraseAt(pt));
      if (erasedNow.length) { undoStack.push({ key, page, erased: erasedNow }); markInk(key, page); }
      erasedNow = [];
    }
    canvases.push({ key, page, redraw, resize, sheet, canvas, addStroke, erasePoints });

    // --- input ---
    // Pen and mouse always draw. A finger draws only when "Finger draws" is
    // on; otherwise it scrolls the page by hand (the canvas has to be
    // touch-action: none, or a stylus drag would scroll instead of ink).
    let active = null;     // { id, pts, w } while drawing
    let erasing = false;
    let erasedNow = [];
    let scrollY = null;
    function toPage(e) {
      const rect = canvas.getBoundingClientRect();
      const x = Math.round((e.clientX - rect.left) / rect.width * PAGE_W);
      const y = Math.round((e.clientY - rect.top) / rect.height * PAGE_H);
      const pr = e.pointerType === "mouse" || !e.pressure ? 8 : Math.max(1, Math.min(15, Math.round(e.pressure * 15)));
      return [x, y, pr];
    }
    function eraseAt(pt) {
      const lp = inkPage(r, page);
      const R2 = 18 * 18;
      const keep = [];
      let hit = false;
      lp.strokes.forEach((s) => {
        const near = decode(s.p).some(([x, y]) => (x - pt[0]) ** 2 + (y - pt[1]) ** 2 < R2);
        if (near) { erasedNow.push(s); (r.deleted[page] = r.deleted[page] || []).push(s.id); hit = true; }
        else keep.push(s);
      });
      if (hit) { lp.strokes = keep; redraw(); }
    }
    // Capture keeps a fast stroke that leaves the sheet edge alive. It can
    // throw for a pointer the browser already released — never fatal.
    function capture(e) { try { canvas.setPointerCapture(e.pointerId); } catch {} }
    canvas.addEventListener("pointerdown", (e) => {
      const isTouch = e.pointerType === "touch";
      if (isTouch && !fingerInk) { scrollY = e.clientY; capture(e); return; }
      // Fast ink owns the stylus: its strokes arrive via __notchInk.stroke.
      if (nativeOn && e.pointerType === "pen") { nativeWatch(); return; }
      if (e.button > 0 && !(e.button === 5 || (e.buttons & 32))) return;
      e.preventDefault();
      capture(e);
      const eraserEnd = (e.buttons & 32) === 32 || e.button === 5;
      if (tool === "eraser" || eraserEnd) {
        erasing = true; erasedNow = [];
        eraseAt(toPage(e));
        return;
      }
      const c = inkColor();
      ctx.strokeStyle = c; ctx.fillStyle = c; ctx.lineCap = "round"; ctx.lineJoin = "round";
      active = { id: newId(), w: 3.2, pts: [toPage(e)] };
    });
    canvas.addEventListener("pointermove", (e) => {
      if (scrollY !== null) { window.scrollBy(0, scrollY - e.clientY); scrollY = e.clientY; return; }
      if (erasing) { eraseAt(toPage(e)); return; }
      if (!active) return;
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      (evs.length ? evs : [e]).forEach((ev) => {
        const pt = toPage(ev);
        const last = active.pts[active.pts.length - 1];
        if ((pt[0] - last[0]) ** 2 + (pt[1] - last[1]) ** 2 < 2.25) return; // < 1.5 units: noise
        active.pts.push(pt);
        strokeLine(last, pt, active.w);
      });
    });
    const end = () => {
      if (scrollY !== null) { scrollY = null; return; }
      if (erasing) {
        erasing = false;
        if (erasedNow.length) { undoStack.push({ key, page, erased: erasedNow }); markInk(key, page); }
        erasedNow = [];
        return;
      }
      if (!active) return;
      const s = { id: active.id, w: active.w, p: encode(active.pts) };
      active = null;
      inkPage(r, page).strokes.push(s);
      if (decode(s.p).length === 1) redraw();
      undoStack.push({ key, page, add: s });
      if (undoStack.length > 200) undoStack.shift();
      markInk(key, page);
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    return sheet;
  }

  // ---------- fast ink (Bigme, inside the APK) ----------
  // 4.6.3 KILL SWITCH — fast ink froze the screen on the real Bigme B10 and
  // HiBreak (30 Oct). Off until it has been proven on the devices. With this
  // false the page never touches the APK's pen bridge — not even to probe
  // it — and Ink uses the web canvas, as in 4.6.0.
  const FAST_INK = false;
  const NI = (FAST_INK && typeof window !== "undefined" && window.NotchInk) || null;
  let nativeOn = false;        // the service is drawing the pen right now
  let nativeStatus = "";
  let nativeBroken = false;    // gave up for this session (watchdog)
  let lastNativeStroke = 0;
  let engineCache = null;      // NotchInk.engine() is a synchronous bridge call: ask once
  let nativeKey = null;        // page the service's ink belongs to
  let scrollTimer = null;
  let scrolling = false;
  function nativeEngine() {
    if (!NI || nativeBroken) return false;
    if (engineCache === null) { try { engineCache = NI.engine() === "bigme"; } catch { engineCache = false; } }
    return engineCache;
  }
  function engineLabel() {
    if (nativeBroken) return "Standard ink · fast ink off";
    if (!nativeEngine()) return "Standard ink";
    return nativeOn ? "Fast ink" : nativeStatus && nativeStatus !== "idle" && nativeStatus !== "ready" && nativeStatus !== "writing" ? "Standard ink · " + nativeStatus : "Fast ink…";
  }
  function paintLabel() {
    const l = root && root.querySelector(".jn-engine");
    if (l) l.textContent = engineLabel();
  }
  function inkGeometry() {
    // Writable area: the visible part of the sheets, below the sticky header
    // and above the floating tab bar, in physical (view) pixels.
    if (!canvases.length || !root || root.style.display === "none") return null;
    const dpr = window.devicePixelRatio || 1;
    const head = root.querySelector(".jn-headbar");
    const bar = document.getElementById("tabbar");
    const top = Math.max(head ? head.getBoundingClientRect().bottom : 0, 0);
    // (a fixed element has no offsetParent, so check display, not offsetParent)
    const barShown = bar && getComputedStyle(bar).display !== "none";
    const bottom = Math.min(barShown ? bar.getBoundingClientRect().top - 4 : window.innerHeight, window.innerHeight);
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity, w = 0;
    canvases.forEach((c) => {
      const rc = c.sheet.getBoundingClientRect();
      const vt = Math.max(rc.top, top), vb = Math.min(rc.bottom, bottom);
      if (vb <= vt) return;
      l = Math.min(l, rc.left); r = Math.max(r, rc.right); t = Math.min(t, vt); b = Math.max(b, vb);
      w = rc.width;
    });
    if (!isFinite(l) || !w) return null;
    return { l: Math.round(l * dpr), t: Math.round(t * dpr), r: Math.round(r * dpr), b: Math.round(b * dpr),
      width: 3.2 * (w / PAGE_W) * dpr };
  }
  function nativeStart() {
    if (!nativeEngine()) { paintLabel(); return; }
    const g = inkGeometry();
    if (!g) { nativeStop(); return; }
    const key = currentKey();
    try {
      NI.eraser(tool === "eraser");
      if (nativeOn) {
        // Already writing: just re-aim. Wipe only when the page changed —
        // the previous page's ink must not linger on the panel.
        NI.bounds(g.l, g.t, g.r, g.b);
        NI.width(g.width);
        if (nativeKey !== key) NI.clear();
      } else {
        NI.start(g.l, g.t, g.r, g.b, g.width);
        nativeOn = true;
      }
      nativeKey = key;
    } catch { nativeOn = false; }
    paintLabel();
  }
  function nativeStop() {
    if (!NI) return;
    if (nativeOn) { try { NI.stop(); } catch {} }
    nativeOn = false;
    nativeKey = null;
  }
  // After the web canvas has painted a change (undo, erase), drop the
  // service's copy of the ink so the panel shows the page as it now is.
  function nativeClearSoon() {
    if (!nativeOn) return;
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => { if (nativeOn) { try { NI.clear(); } catch {} } }, 120)));
  }
  // Watchdog: if the page sees a pen stroke but the service never sends one
  // back, fast ink isn't working on this firmware — fall back for the session.
  function nativeWatch() {
    const at = Date.now();
    setTimeout(() => {
      if (!nativeOn || lastNativeStroke >= at - 50) return;
      nativeBroken = true;
      nativeStop();
      showToast("Fast ink didn't respond — using standard ink");
      render();
    }, 2500);
  }
  function nativeStroke(kind, flat) {
    lastNativeStroke = Date.now();
    if (!canvases.length || !flat || flat.length < 3) return;
    const dpr = window.devicePixelRatio || 1;
    const x0 = flat[0] / dpr, y0 = flat[1] / dpr;
    // The page the stroke started on (nearest sheet if it began in a gap).
    let target = null, best = Infinity;
    canvases.forEach((c) => {
      const rc = c.sheet.getBoundingClientRect();
      const d = y0 < rc.top ? rc.top - y0 : y0 > rc.bottom ? y0 - rc.bottom : 0;
      if (d < best) { best = d; target = { c, rc }; }
    });
    if (!target) return;
    const { c, rc } = target;
    const pts = [];
    for (let i = 0; i + 2 < flat.length; i += 3) {
      const x = Math.round((flat[i] / dpr - rc.left) / rc.width * PAGE_W);
      const y = Math.round((flat[i + 1] / dpr - rc.top) / rc.height * PAGE_H);
      const pr = Math.max(1, Math.min(15, Math.round((flat[i + 2] || 0.5) * 15)));
      const last = pts[pts.length - 1];
      if (last && (x - last[0]) ** 2 + (y - last[1]) ** 2 < 2.25 && i + 3 < flat.length) continue;
      pts.push([x, y, pr]);
    }
    if (!pts.length) return;
    if (kind === "rubber") { c.erasePoints(pts); nativeClearSoon(); return; }
    c.addStroke({ id: newId(), w: 3.2, p: encode(pts) });
  }
  if (typeof window !== "undefined") {
    window.__notchInk = {
      state(s) {
        nativeStatus = (s && s.status) || "";
        // A failed start (or the service dropping us on rotation) turns fast
        // ink off; a late "stopped" echo from an earlier stop() must not.
        if (s && !s.active && nativeStatus !== "idle") { nativeOn = false; nativeKey = null; }
        if (s && !s.active && nativeStatus === "idle" && !nativeOn) nativeKey = null;
        paintLabel();
      },
      stroke(kind, flat) { try { nativeStroke(kind, flat); } catch (e) { console.warn("native stroke", e); } },
    };
    // The service's ink is pinned to the screen, the page isn't: wipe it the
    // moment the page scrolls (the canvas underneath has every stroke) and
    // re-aim the writing area once scrolling stops.
    window.addEventListener("scroll", () => {
      if (!nativeOn) return;
      if (!scrolling) { scrolling = true; try { NI.clear(); } catch {} }
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        scrolling = false;
        const g = inkGeometry();
        if (g && nativeOn) { try { NI.bounds(g.l, g.t, g.r, g.b); } catch {} }
      }, 160);
    }, { passive: true });
  }

  // ---------- 4.8 TODAY pane (desktop ≥1280px) ----------
  // A fixed right-hand column that always shows today: CONCURSUS, what's
  // scheduled (calendar + tasks due), and today's rapid log with its send
  // button. It edits the same page as Journal → Day for today — one record,
  // one sync path; twin fields mirror each other as you type.
  const todayPane = { el: null, row: null, sig: "", queued: false, force: false, timer: null, date: "" };
  function todayRange() { const d = todayISO(); return { from: d, to: d, days: [d] }; }
  function todaySig() {
    const d = todayISO();
    const key = keyFor("day", d);
    const rr = all()[key];
    const range = todayRange();
    const idx = cachedIndex(range);
    return [d, hashStr(JSON.stringify((rr && rr.entry.sections) || {})),
      hashStr(JSON.stringify((idx && idx.cal) || [])),
      hashStr(JSON.stringify(dueInRange(range))),
      hashStr(JSON.stringify(concursusFor(range)))].join("§");
  }
  function renderToday() {
    if (!todayPane.el) return;
    const d = todayISO();
    const key = keyFor("day", d);
    const r = rec(key);
    applyDone(key, r);
    maybeLoadDone(r);
    todayPane.sig = todaySig();
    todayPane.date = d;
    const pane = todayPane.el;
    pane.replaceChildren();
    const head = el("div", "td-head");
    const titles = el("div", "td-titles");
    titles.appendChild(el("div", "jn-kicker", "Today"));
    titles.appendChild(el("div", "td-title", parseISO(d).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })));
    head.appendChild(titles);
    head.appendChild(button("jn-day-open", "day ›", "Open today's daily log", () => {
      view = "day"; anchor = d; saveViewState();
      if (typeof setActiveTab === "function") setActiveTab("journal");
      go("day", d);
    }));
    pane.appendChild(head);
    const cc = ccStrip(d);
    cc.classList.add("td-cc");
    cc.setAttribute("role", "button");
    cc.tabIndex = 0;
    cc.setAttribute("aria-label", "Open CONCURSUS");
    const toCc = () => { if (typeof setActiveTab === "function") setActiveTab("concursus"); };
    cc.addEventListener("click", toCc);
    cc.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toCc(); } });
    pane.appendChild(cc);
    pane.appendChild(scheduledBlock(d, r, todayRange()));
    pane.appendChild(sectionLabel("Rapid log", "• task  ○ event  – note"));
    const ta = textArea(key, r, "log", "• call the venue\n○ 14:00 product review\n– idea: …", { rows: 6, onInput: () => fillSendRow() });
    ta.id = "today-log";
    pane.appendChild(signifierBar(ta));
    pane.appendChild(ta);
    todayPane.row = makeSendRow(key, r, [["log", d]]);
    pane.appendChild(todayPane.row);
  }
  function todaySoon(force) {
    if (!todayPane.el) return;
    if (force) todayPane.force = true;
    if (todayPane.queued) return;
    todayPane.queued = true;
    requestAnimationFrame(() => {
      todayPane.queued = false;
      if (!todayPane.el) return;
      // Never rebuild under the cursor; the twin-field mirror keeps it current.
      const a = document.activeElement;
      if (a && todayPane.el.contains(a) && (a.tagName === "TEXTAREA" || a.tagName === "INPUT")) return;
      if (!todayPane.force && todayPane.date === todayISO() && todaySig() === todayPane.sig) return;
      todayPane.force = false;
      renderToday();
    });
  }
  async function refreshToday(force) {
    if (!todayPane.el || !getConfig()) return;
    const range = todayRange();
    const key = keyFor("day", range.from);
    const c = cachedIndex(range);
    await Promise.all([
      fetchEntry(key, force).catch(() => {}),
      (force || !c || !c.cal || Date.now() - c.fetchedAt >= REFETCH_MS) ? fetchIndex("day", range, c).catch(() => {}) : null,
    ]);
    todaySoon();
  }
  function mountToday(node) {
    if (!node || todayPane.el === node) return;
    todayPane.el = node;
    renderToday();
    refreshToday();
    flushAll();
    if (typeof CONCURSUS !== "undefined") CONCURSUS.subscribe(() => todaySoon());
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshToday(); });
    clearInterval(todayPane.timer);
    // The calendar changes under us (new invites, the Mac's Outlook push).
    todayPane.timer = setInterval(() => { if (document.visibilityState === "visible") refreshToday(); }, 2 * 60 * 1000);
  }
  function unmountToday() {
    clearInterval(todayPane.timer);
    if (todayPane.el) todayPane.el.replaceChildren();
    todayPane.el = null; todayPane.row = null;
  }
  function focusToday() {
    const t = document.getElementById("today-log");
    if (!t || !t.offsetParent) return false;
    t.focus();
    // Jotting is the point: land on a fresh line.
    if (t.value && !t.value.endsWith("\n")) { t.value += "\n"; t.dispatchEvent(new Event("input")); }
    t.setSelectionRange(t.value.length, t.value.length);
    return true;
  }

  // ---------- navigation ----------
  function saveViewState() { try { sessionStorage.setItem(VIEW_KEY, JSON.stringify({ view, anchor })); } catch {} }
  // An untouched page (nothing typed, nothing inked, nothing pending) opens in
  // the face used last, whatever face it had when it was cached.
  function adoptFace() {
    const r = rec(currentKey());
    const e = r.entry;
    const empty = !isDirty(r) && !Object.values(e.sections || {}).some((t) => (t || "").trim())
      && !(e.ink || []).some((p) => p.strokes && p.strokes.length);
    if (empty) e.mode = lastFace();
  }
  function go(v, date) {
    view = v; anchor = date;
    saveViewState();
    adoptFace();
    undoStack.length = 0;
    render();
    fetchEntry(currentKey()).then(() => { if (!isDirtyNow()) renderSoon(); });
    loadIndex().then(() => setTimeout(prefetchAround, 300));
    window.scrollTo(0, 0);
  }
  function isDirtyNow() { return isDirty(rec(currentKey())); }
  function shift(n) {
    const d = parseISO(anchor);
    if (view === "day") d.setDate(d.getDate() + n);
    else if (view === "week") d.setDate(d.getDate() + 7 * n);
    else { d.setDate(1); d.setMonth(d.getMonth() + n); }
    go(view, localISO(d));
  }

  // ---------- public ----------
  function init(el0) {
    root = el0;
    if (!inited) {
      inited = true;
      try { fingerInk = localStorage.getItem(FINGER_KEY) === "1"; } catch {}
      try {
        const s = JSON.parse(sessionStorage.getItem(VIEW_KEY));
        if (s && ["day", "week", "month"].includes(s.view) && /^\d{4}-\d{2}-\d{2}$/.test(s.anchor)) { view = s.view; anchor = s.anchor; }
      } catch {}
      if (!anchor) anchor = todayISO();
      window.addEventListener("online", () => flushAll());
      window.addEventListener("resize", () => { canvases.forEach((c) => c.resize()); if (canvases.length) nativeStart(); });
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
          Object.keys(timers).forEach((k) => clearTimeout(timers[k]));
          flushAll();
          nativeStop();
        } else if (getConfig()) {
          flushAll();
          pushConcursus();
          if (canvases.length && root && root.style.display !== "none") setTimeout(nativeStart, 300);
        }
      });
      if (typeof CONCURSUS !== "undefined") CONCURSUS.subscribe(() => { pushConcursus(); if (root && root.style.display !== "none" && !isDirtyNow()) renderSoon(); });
    }
    // Coming back to the tab: the page is still in the DOM — reuse it unless
    // something it shows changed while away (4.6.2).
    if (!root.firstChild || viewSig() !== lastSig) render();
    else if (canvases.length) requestAnimationFrame(nativeStart);
    fetchEntry(currentKey()).then(() => renderSoon());
    loadIndex().then(() => setTimeout(prefetchAround, 300));
    flushAll();
    pushConcursus();
  }
  function refresh() { if (!root) return; fetchEntry(currentKey(), true).then(() => renderSoon()); loadIndex(true); }
  // Called by app.js on boot so CONCURSUS history reaches the server even if
  // the JOURNAL tab is never opened on this device.
  function background() { if (getConfig()) { pushConcursus(); flushAll(); } }

  return {
    init, refresh, background,
    mountToday, unmountToday, todaySoon, focusToday,
    pause: () => nativeStop(),
    openDay: (date) => { view = "day"; anchor = date; saveViewState(); },
    prev: () => shift(-1), next: () => shift(1), today: () => go(view, todayISO()),
    setView: (v) => go(v, anchor),
    // test hooks
    _encode: encode, _decode: decode, _isoWeek: isoWeek, _keyFor: keyFor,
  };
})();
