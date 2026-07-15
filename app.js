// Tasks PWA — app logic
// Talks to a Cloudflare Worker proxy (see /worker), never to Notion directly
// (Notion's API has no browser CORS support, so something has to sit in between).

// BUG-05: cache shape carries syncedAt metadata alongside tasks, so an
// offline boot can tell "legitimately empty synced list" (metadata present,
// zero tasks) from "no cache at all" (metadata absent) — getCache() used to
// return [] for both, which rendered a connection error over a real "No
// open tasks" state. One-time fallback reads the old bare-array key.
const CACHE_KEY = "tasks-cache-v2";
const LEGACY_CACHE_KEY = "tasks-cache-v1";
const CFG_KEY = "tasks-cfg-v1";

function getConfig() {
  try { return JSON.parse(localStorage.getItem(CFG_KEY)); } catch { return null; }
}
function setConfig(cfg) { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); }

function api(path) {
  const cfg = getConfig();
  return cfg.url.replace(/\/$/, "") + path;
}

async function apiFetch(path, opts = {}) {
  const cfg = getConfig();
  const res = await fetch(api(path), {
    ...opts,
    headers: {
      "content-type": "application/json",
      "x-app-key": cfg.key,
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error("request failed: " + res.status);
  return res.json();
}

// --- setup flow ---
function showSetup() {
  document.getElementById("setup").style.display = "block";
  document.getElementById("app").style.display = "none";
}
function showApp() {
  document.getElementById("setup").style.display = "none";
  document.getElementById("app").style.display = "block";
}

document.getElementById("cfg-save").addEventListener("click", () => {
  const url = document.getElementById("cfg-url").value.trim();
  const key = document.getElementById("cfg-key").value.trim();
  if (!url || !key) return;
  setConfig({ url, key });
  showApp();
  boot();
});

// --- date helpers ---
// All date logic runs on the DEVICE LOCAL clock (Asia/Jakarta in practice).
// Never use toISOString() for "today" — it returns the UTC date, which in
// UTC+7 is *yesterday* between 00:00 and 07:00 local. That bug lived in v2.
function localISO(d = new Date()) {
  return d.getFullYear() + "-" +
    String(d.getMonth() + 1).padStart(2, "0") + "-" +
    String(d.getDate()).padStart(2, "0");
}
function todayISO() { return localISO(); }
// Upcoming Sunday, inclusive of today when today is Sunday.
function nextSundayISO() {
  const d = new Date();
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
  return localISO(d);
}
function tomorrowISO() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return localISO(d);
}
// Notion can return full datetimes ("2026-07-19T00:00:00.000+07:00") — compare/display date part only
function dueDate(due) {
  return due ? due.slice(0, 10) : null;
}
function isOverdue(due) {
  const d = dueDate(due);
  return d && d < todayISO();
}
function isToday(due) {
  return dueDate(due) === todayISO();
}

// --- areas (data vocabulary; used for tags, grouping, quick-add) ---
const AREAS = [
  { name: "Church", emoji: "⛪", cls: "a-church" },
  { name: "Blibli", emoji: "🛒", cls: "a-blibli" },
  { name: "Fitness", emoji: "💪", cls: "a-fitness" },
  { name: "Family", emoji: "👨‍👩‍👦", cls: "a-family" },
  { name: "Personal", emoji: "●", cls: "a-personal" },
];
function areaCls(name) {
  const a = AREAS.find((x) => x.name === name);
  return a ? a.cls : "";
}

// --- smart view system (backlog 1.3, absorbs 1.2) ---
// One chip row, views only — the 1.1 Area chips are retired. Undated tasks
// are EXCLUDED from smart views (date views stay date-honest); they live in
// All, grouped under their Area.
const VIEWS = [
  {
    id: "All", label: "All", defaultArea: "",
    grouping: "area",
    empty: "No open tasks.",
    match: () => true,
  },
  {
    id: "SundayPrep", label: "Sunday Prep", defaultArea: "Church",
    grouping: "date",
    empty: "Sunday Prep is clear. Nothing between you and the sermon.",
    match: (t) => t.area === "Church" && dueDate(t.due) !== null && dueDate(t.due) <= nextSundayISO(),
  },
  {
    id: "Workday", label: "Workday", defaultArea: "Blibli",
    grouping: "date",
    empty: "Workday clear. Blibli owes you nothing today.",
    match: (t) => t.area === "Blibli" && dueDate(t.due) !== null && dueDate(t.due) <= todayISO(),
  },
  {
    id: "Weekend", label: "Weekend", defaultArea: "Family",
    grouping: "date",
    empty: "Weekend is open. Go live it.",
    match: (t) => (t.area === "Family" || t.area === "Fitness") && dueDate(t.due) !== null && dueDate(t.due) <= nextSundayISO(),
  },
];
function getView(id) { return VIEWS.find((v) => v.id === id) || VIEWS[0]; }
function viewTasks(all, id) { return all.filter(getView(id).match); }

// Time-aware default view. Precedence mirrors the backlog schedule table,
// top to bottom; first match wins.
function resolveDefaultView(d = new Date()) {
  const day = d.getDay(); // 0 = Sun … 6 = Sat
  const h = d.getHours() + d.getMinutes() / 60;
  if (day >= 1 && day <= 5 && h >= 8 && h < 18) return "Workday";      // Mon–Fri 08:00–18:00
  if ((day === 4 || day === 5) && h >= 18) return "SundayPrep";        // Thu & Fri from 18:00
  if ((day === 6 && h >= 18) || (day === 0 && h < 13)) return "SundayPrep"; // Sat 18:00 → Sun 13:00
  if (day === 6 && h >= 8 && h < 18) return "Weekend";                 // Sat 08:00–18:00
  if (day === 0 && h >= 13 && h < 17) return "Weekend";                // Sun 13:00–17:00
  if (day === 0 && h >= 17) return "All";                              // Sun from 17:00 — BuJo lens
  return "All";                                                        // all other hours
}

// Manual selection holds for the current session only (sessionStorage —
// a killed-and-reopened app is a fresh session, so cold opens re-resolve
// from the clock, exactly as 1.3 specifies).
const VIEW_SESSION_KEY = "tasks-view-v1";
let activeView = "All";
let viewManual = false;
(function initViewState() {
  try {
    const s = JSON.parse(sessionStorage.getItem(VIEW_SESSION_KEY));
    if (s && s.view && getView(s.view).id === s.view) {
      activeView = s.view;
      viewManual = !!s.manual;
      return;
    }
  } catch { /* fall through */ }
  activeView = resolveDefaultView();
})();
function saveViewState() {
  sessionStorage.setItem(VIEW_SESSION_KEY, JSON.stringify({ view: activeView, manual: viewManual }));
}

// Empty-view fallback: if the *scheduled* default view has zero tasks, open
// All instead (biweekly church prep makes an empty Sunday Prep legitimate).
// Only applies while the view is clock-driven — a manual pick is respected
// even when empty, because an empty smart view is a message, not an error.
function applyAutoView(all) {
  if (viewManual) return;
  let v = resolveDefaultView();
  if (v !== "All" && viewTasks(all, v).length === 0) v = "All";
  activeView = v;
  saveViewState();
}

// --- view chips ---
function renderChips(allTasks) {
  const wrap = document.getElementById("view-chips");
  wrap.innerHTML = "";
  VIEWS.forEach((v) => {
    const btn = document.createElement("button");
    btn.className = "chip" + (activeView === v.id ? " active" : "");
    btn.textContent = v.label;
    const n = viewTasks(allTasks, v.id).length;
    if (v.id !== "All" && n > 0) {
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = n;
      btn.appendChild(b);
    }
    btn.addEventListener("click", () => switchView(v.id));
    wrap.appendChild(btn);
  });
}

function switchView(id) {
  if (id === activeView) return;
  activeView = id;
  viewManual = true; // holds for this session
  saveViewState();
  syncQuickAddArea();
  syncQuickAddDue();
  const prev = captureRects();
  const all = sortTasks(getCache());
  renderChips(all);
  render(all);
  playFlip(prev);
}

function syncQuickAddArea() {
  const sel = document.getElementById("new-area");
  if (sel) sel.value = getView(activeView).defaultArea;
}

// backlog 1.5: due-date quick-add. Same pattern as Area — the active view
// supplies a context default, an explicit chip pick always wins, and the
// default re-syncs on every view switch (not on every render, so a manual
// pick holds until the view actually changes — same lifecycle as Area).
let quickAddDue = "";
function viewDefaultDue(viewId) {
  if (viewId === "Workday") return todayISO();
  if (viewId === "SundayPrep") return nextSundayISO();
  if (viewId === "Weekend") return nextSundayISO(); // "Sunday" per spec
  return ""; // All → none
}
function syncQuickAddDue() {
  quickAddDue = viewDefaultDue(activeView);
  renderDueChips();
}
// FIX v4 (15 Jul): three attempts at disguising/hiding the native iOS date
// control (off-screen input, transparent overlay-on-label) were all
// unreliable on iOS WebKit/Brave — the browser can silently refuse to open
// a picker it doesn't consider a genuine, visible tap target. #new-due-custom
// is now a plain, visible <input type="date"> — no hiding, no overlay, no
// showPicker()/.click() script anywhere. The user taps the real control.
function renderDueChips() {
  const wrap = document.getElementById("new-due-chips");
  if (!wrap) return;
  const t = todayISO();
  const tm = tomorrowISO();
  wrap.querySelectorAll(".due-chip[data-due]").forEach((btn) => {
    const kind = btn.dataset.due;
    const val = kind === "today" ? t : kind === "tomorrow" ? tm : "";
    btn.classList.toggle("active", quickAddDue === val);
  });
  const customInput = document.getElementById("new-due-custom");
  const placeholder = document.getElementById("due-date-placeholder");
  if (customInput) {
    const isCustom = quickAddDue && quickAddDue !== t && quickAddDue !== tm;
    customInput.classList.toggle("active", !!isCustom);
    if (!isCustom) customInput.value = ""; // clear the visible field when a fixed chip wins
    // FIX v5: <input type="date"> has no working placeholder attribute in
    // any browser, so the field read as an unlabeled empty box. The "Date"
    // label sits under it and hides only once the field genuinely has a
    // value — driven from here since this is the one place both the chip
    // clicks and the native picker's change event already funnel through.
    if (placeholder) placeholder.classList.toggle("hidden", !!customInput.value);
  }
}
document.querySelectorAll(".due-chip[data-due]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const kind = btn.dataset.due;
    quickAddDue = kind === "today" ? todayISO() : kind === "tomorrow" ? tomorrowISO() : "";
    renderDueChips();
  });
});
document.getElementById("new-due-custom").addEventListener("change", (e) => {
  if (!e.target.value) return;
  quickAddDue = e.target.value;
  renderDueChips();
});

// --- FLIP regroup animation (≤250ms budget, backlog 3.2) ---
// Same tasks, new lens — the animation IS the feedback. Rows are matched
// across renders by task id; moved rows glide, entering rows fade in.
function captureRects() {
  const m = new Map();
  document.querySelectorAll("#list .row").forEach((r) => m.set(r.dataset.id, r.getBoundingClientRect()));
  return m;
}
function playFlip(prev) {
  if (!prev || !("animate" in Element.prototype)) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  document.querySelectorAll("#list .row").forEach((r) => {
    const old = prev.get(r.dataset.id);
    if (!old) {
      r.animate(
        [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }],
        { duration: 180, easing: "ease-out" }
      );
      return;
    }
    const now = r.getBoundingClientRect();
    const dx = old.left - now.left;
    const dy = old.top - now.top;
    if (dx || dy) {
      r.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
        { duration: 220, easing: "cubic-bezier(0.2, 0, 0, 1)" }
      );
    }
  });
}

// --- Area-group collapse state (persists across sessions; UI preference,
// not task state — the ground rule concerns data Notion can't see, and
// Notion never needs to see which groups you folded on your phone) ---
const COLLAPSE_KEY = "tasks-groups-collapsed-v1";
function getCollapsed() {
  try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY)) || {}; } catch { return {}; }
}
function setCollapsed(map) { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(map)); }

// --- rendering ---
function render(allTasks) {
  const view = getView(activeView);
  const tasks = viewTasks(allTasks, view.id);
  const list = document.getElementById("list");

  document.getElementById("view-title").textContent = view.id === "All" ? "All" : view.label;
  const countText = view.id === "All"
    ? (tasks.length ? `· ${tasks.length} open` : "")
    : `· ${tasks.length} of ${allTasks.length} open`;
  document.getElementById("task-count").textContent = countText;
  document.getElementById("today-date").textContent = new Date().toLocaleDateString(undefined, {
    weekday: "long", month: "short", day: "numeric",
  });

  if (!tasks.length) {
    list.innerHTML = `<div class="empty">${view.empty}</div>`;
    return;
  }

  list.innerHTML = "";
  if (view.grouping === "area") {
    renderAreaGroups(list, tasks);
  } else {
    renderDateGroups(list, tasks);
  }
}

// Smart views: fixed date grouping — Overdue / Today / Upcoming.
function renderDateGroups(list, tasks) {
  const overdue = tasks.filter((t) => isOverdue(t.due));
  const today = tasks.filter((t) => isToday(t.due));
  const upcoming = tasks.filter((t) => !isOverdue(t.due) && !isToday(t.due));
  [
    ["Overdue", overdue],
    ["Today", today],
    ["Upcoming", upcoming],
  ].forEach(([label, group]) => {
    if (!group.length) return;
    const h = document.createElement("div");
    h.className = "section-label";
    h.textContent = label;
    list.appendChild(h);
    group.forEach((t) => list.appendChild(renderRow(t)));
  });
}

// All view: fixed Area grouping. Empty groups stay visible ("Family — 0") —
// that IS the domain balance signal, previewing 2.2 before it ships.
// Tasks with no Area land in a trailing "No Area" group (shown only when
// nonempty — an empty triage bucket carries no signal).
function renderAreaGroups(list, tasks) {
  const collapsed = getCollapsed();
  const groups = AREAS.map((a) => ({
    key: a.name,
    label: a.name,
    emoji: a.emoji,
    cls: a.cls,
    items: tasks.filter((t) => t.area === a.name),
    alwaysShow: true,
  }));
  const noArea = tasks.filter((t) => !t.area);
  if (noArea.length) {
    groups.push({ key: "NoArea", label: "No Area", emoji: "", cls: "", items: noArea, alwaysShow: false });
  }

  groups.forEach((g) => {
    if (!g.items.length && !g.alwaysShow) return;
    const isCollapsed = !!collapsed[g.key];

    const head = document.createElement("button");
    head.className = "area-head " + g.cls + (isCollapsed ? " collapsed" : "") + (!g.items.length ? " zero" : "");
    head.innerHTML =
      `<span class="area-dot"></span>` +
      `<span class="area-name">${g.emoji ? g.emoji + " " : ""}${g.label}</span>` +
      `<span class="area-count">${g.items.length}</span>` +
      `<svg class="area-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6,9 12,15 18,9"/></svg>`;

    const bodyWrap = document.createElement("div");
    bodyWrap.className = "group-body" + (isCollapsed ? " collapsed" : "");
    g.items.forEach((t) => bodyWrap.appendChild(renderRow(t)));

    head.addEventListener("click", () => {
      const map = getCollapsed();
      map[g.key] = !map[g.key];
      setCollapsed(map);
      head.classList.toggle("collapsed", map[g.key]);
      bodyWrap.classList.toggle("collapsed", map[g.key]);
    });

    list.appendChild(head);
    list.appendChild(bodyWrap);
  });
}

function renderRow(task) {
  const row = document.createElement("div");
  row.className = "row";
  row.dataset.id = task.id;

  const check = document.createElement("button");
  check.className = "check";
  check.setAttribute("aria-label", "Mark done");
  check.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><polyline points="4,13 9,18 20,6"/></svg>`;
  check.addEventListener("click", () => completeTask(task, row, check));

  const body = document.createElement("div");
  body.className = "row-body";

  const title = document.createElement("div");
  title.className = "row-title";
  title.textContent = task.title;

  const meta = document.createElement("div");
  meta.className = "row-meta";

  const prTag = document.createElement("span");
  const prCode = (task.priority || "").slice(0, 2).toLowerCase();
  prTag.className = "tag " + (prCode === "p1" ? "p1" : prCode === "p2" ? "p2" : "");
  prTag.textContent = prCode || "p3";
  meta.appendChild(prTag);

  if (task.due) {
    const dueTag = document.createElement("span");
    dueTag.className = "tag" + (isOverdue(task.due) ? " due-overdue" : "");
    dueTag.textContent = dueDate(task.due);
    meta.appendChild(dueTag);
  }

  if (task.area) {
    const areaTag = document.createElement("span");
    areaTag.className = "tag area " + areaCls(task.area);
    const a = AREAS.find((x) => x.name === task.area);
    areaTag.textContent = a && a.emoji ? `${a.emoji} ${task.area}` : task.area;
    meta.appendChild(areaTag);
  }

  if (task.label) {
    const labelTag = document.createElement("span");
    labelTag.className = "tag";
    labelTag.textContent = task.label;
    meta.appendChild(labelTag);
  }

  body.appendChild(title);
  body.appendChild(meta);
  row.appendChild(check);
  row.appendChild(body);
  return row;
}

// --- actions ---
async function completeTask(task, rowEl, checkEl) {
  checkEl.classList.add("checking");
  rowEl.classList.add("done");
  try {
    await apiFetch(`/api/tasks/${task.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "Done" }),
    });
    // BUG-02: wait for the fade-out, then run the exact same
    // cache-update + full-render path addTask() already uses — completing
    // a task used to call renderChips() but never render(), so header
    // counts, date sections, and empty state all went stale (worst case:
    // completing the last task in a view left its section header floating
    // over nothing).
    setTimeout(() => {
      const cached = getCache().filter((t) => t.id !== task.id);
      setCache(cached);
      const all = sortTasks(cached);
      renderChips(all);
      render(all);
    }, 260);
  } catch (e) {
    checkEl.classList.remove("checking");
    rowEl.classList.remove("done");
    alert("Couldn't reach the server — try again when back online.");
  }
}

document.getElementById("new-add").addEventListener("click", addTask);
document.getElementById("new-title").addEventListener("keydown", (e) => {
  if (e.key === "Enter") addTask();
});

async function addTask() {
  const titleEl = document.getElementById("new-title");
  const title = titleEl.value.trim();
  if (!title) return;
  const priority = document.getElementById("new-priority").value;
  const areaSel = document.getElementById("new-area");
  // Explicit pick wins; otherwise the active view's context area
  // (Sunday Prep → Church, Workday → Blibli, Weekend → Family, All → none).
  const area = areaSel.value || getView(activeView).defaultArea;
  const btn = document.getElementById("new-add");
  btn.disabled = true;
  try {
    const payload = { title, priority };
    if (area) payload.area = area;
    if (quickAddDue) payload.due = quickAddDue; // backlog 1.5
    const created = await apiFetch("/api/tasks", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    titleEl.value = "";
    const cached = [created, ...getCache()];
    setCache(cached);
    const all = sortTasks(cached);
    renderChips(all);
    render(all);
  } catch (e) {
    alert("Couldn't add — check your connection.");
  } finally {
    btn.disabled = false;
  }
}

// --- cache ---
// BUG-05: { syncedAt, tasks } lets boot() tell "synced and legitimately
// empty" from "never synced" — a bare [] used to mean both.
function getCacheEntry() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* fall through to legacy check */ }
  try {
    const legacyRaw = localStorage.getItem(LEGACY_CACHE_KEY);
    if (legacyRaw) {
      const legacyTasks = JSON.parse(legacyRaw);
      if (Array.isArray(legacyTasks)) {
        const entry = { syncedAt: null, tasks: legacyTasks };
        setCacheEntry(entry);
        localStorage.removeItem(LEGACY_CACHE_KEY);
        return entry;
      }
    }
  } catch { /* no usable cache either way */ }
  return null;
}
function setCacheEntry(entry) { localStorage.setItem(CACHE_KEY, JSON.stringify(entry)); }
function hasCacheMetadata() { return getCacheEntry() !== null; }
function getCache() {
  const entry = getCacheEntry();
  return entry ? entry.tasks : [];
}
function setCache(tasks) { setCacheEntry({ syncedAt: new Date().toISOString(), tasks }); }

// BUG-04: due-state bucket first (overdue → today → upcoming → undated),
// then due date, then priority P1→P4, then title as a stable tie-break.
// Previously only compared `due`, so a P4 could outrank a P1 on the same day.
function dueBucket(due) {
  const d = dueDate(due);
  if (d === null) return 3;
  if (d < todayISO()) return 0;
  if (d === todayISO()) return 1;
  return 2;
}
function priorityRank(priority) {
  const m = /^P([1-4])/.exec(priority || "");
  return m ? parseInt(m[1], 10) : 5; // unrecognized priority sorts last, never crashes
}
function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    const bucketDiff = dueBucket(a.due) - dueBucket(b.due);
    if (bucketDiff !== 0) return bucketDiff;
    const da = dueDate(a.due) || "9999-99-99";
    const db = dueDate(b.due) || "9999-99-99";
    if (da !== db) return da.localeCompare(db);
    const prDiff = priorityRank(a.priority) - priorityRank(b.priority);
    if (prDiff !== 0) return prDiff;
    return (a.title || "").localeCompare(b.title || "");
  });
}

// --- boot ---
async function boot() {
  const cached = sortTasks(getCache());
  applyAutoView(cached);
  syncQuickAddArea();
  syncQuickAddDue();
  renderChips(cached);
  // BUG-05: render whenever cache metadata exists, even with zero tasks —
  // that's a legitimate "No open tasks", not the absence of a cache.
  if (hasCacheMetadata()) render(cached);

  try {
    const { tasks } = await apiFetch("/api/tasks");
    document.getElementById("offline-banner").classList.remove("show");
    setCache(tasks);
    const all = sortTasks(tasks);
    applyAutoView(all); // fresh data may change the empty-view fallback verdict
    syncQuickAddArea();
    syncQuickAddDue();
    renderChips(all);
    render(all);
  } catch (e) {
    if (hasCacheMetadata()) {
      document.getElementById("offline-banner").classList.add("show");
    } else {
      document.getElementById("list").innerHTML =
        `<div class="empty">Can't reach the server. Check your connection or Worker URL.</div>`;
    }
  }
}

// iOS keeps PWAs alive for hours — a "reopen" is often just a resume, not a
// cold start. Re-resolve the clock-driven view on resume so Thursday-evening
// opens land on Sunday Prep even when the page never actually reloaded.
// Manual picks are left alone (session override holds).
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || viewManual) return;
  const all = sortTasks(getCache());
  const before = activeView;
  applyAutoView(all);
  if (activeView !== before) {
    syncQuickAddArea();
    syncQuickAddDue();
    const prev = captureRects();
    renderChips(all);
    render(all);
    playFlip(prev);
  }
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js"));
}

const cfg = getConfig();
if (!cfg || !cfg.url || !cfg.key) {
  showSetup();
} else {
  showApp();
  boot();
}
