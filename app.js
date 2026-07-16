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
  document.getElementById("tabbar").style.display = "flex";
  document.getElementById("bottom-scrim").style.display = "block";
}

document.getElementById("cfg-save").addEventListener("click", () => {
  const url = document.getElementById("cfg-url").value.trim();
  const key = document.getElementById("cfg-key").value.trim();
  if (!url || !key) return;
  setConfig({ url, key });
  showApp();
  boot();
  initTabRouter();
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
document.querySelectorAll("#new-due-chips .due-chip[data-due]").forEach((btn) => {
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

  // Phase 3 req 7 -- the mandate ring is independent of Notion task state
  // and every Tasks view, so it renders on every call here, not gated on
  // whether the current view has any Notion tasks.
  renderMandateRing();

  list.innerHTML = "";
  // Phase 3 req 5 -- the CONCURSUS · TODAY group renders above every
  // Notion-backed group, in every view (All / Sunday Prep / Workday /
  // Weekend), independent of whether THIS view's Notion filter matches
  // anything. It's a no-op (renders nothing) when there's no roll today,
  // which is also why this must run before the empty-view early return
  // below -- an empty Notion view is not the same thing as nothing to show.
  renderConcursusGroup(list);

  if (!tasks.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = view.empty;
    list.appendChild(empty);
    return;
  }

  if (view.grouping === "area") {
    renderAreaGroups(list, tasks);
  } else {
    renderDateGroups(list, tasks);
  }
}

// --- Phase 3: CONCURSUS · TODAY projection (roll-to-Tasks) ---
// Synthetic, local-only rows. Never touches tasks-cache-v2, never calls
// apiFetch/api() -- completion here only ever calls CONCURSUS.toggleDomain(),
// which writes exclusively to concursus-state-v1 (req 10).

// 2.1 — Today's Mandate Ring. Replaces the old text strip
// (`CONCURSUS · Roll N · n/5`) outright; the two are never rendered
// together. One segmented donut, five mandate domains in fixed order —
// Intake → Synthesis → Exercise → Scripture → Family — distinguished by
// label and position, not five hues. Data comes exclusively from
// CONCURSUS.status(); zero Worker or Notion calls on this path.
const RING_DOMAINS = [
  ["intake", "Intake"],
  ["synthesis", "Synthesis"],
  ["exercise", "Exercise"],
  ["scripture", "Scripture"],
  ["family", "Family"],
];

// One-shot completion animation bookkeeping: a segment animates only when
// it flips incomplete → complete between two renders of the SAME local
// date (i.e. after a confirmed local write). Mount (lastRingDone === null),
// resume re-renders (no flip), midnight resets, and re-rolls (flips are
// true → false only) all render statically — no replay, per acceptance.
let lastRingDate = null;
let lastRingDone = null;

// 72° per segment, 10° gap → 62° arc, starting at 12 o'clock, clockwise.
// Butt caps, not round: flat print-style geometry per the Signature Lock.
function ringSegPath(i) {
  const c = 32, r = 26, span = 62;
  const start = -90 + i * 72 + 5;
  const a1 = (start * Math.PI) / 180;
  const a2 = ((start + span) * Math.PI) / 180;
  const p = (a) => (c + r * Math.cos(a)).toFixed(2) + " " + (c + r * Math.sin(a)).toFixed(2);
  return `M ${p(a1)} A ${r} ${r} 0 0 1 ${p(a2)}`;
}

function renderMandateRing() {
  const ring = document.getElementById("mandate-ring");
  if (!ring) return;
  // Defensive: boot() calls render() synchronously (before its first
  // await), which happens before concursus.js -- the next <script> tag --
  // has executed. CONCURSUS won't exist yet on that very first call. Every
  // later render() call (post-boot, post-DOMContentLoaded) is safe; this
  // guard only covers that one early window rather than relying on timing.
  if (typeof CONCURSUS === "undefined") return;
  const s = CONCURSUS.status();
  if (s.roll === null) {
    ring.classList.remove("show", "carpe");
    ring.innerHTML = "";
    ring.setAttribute("aria-label", "Open CONCURSUS");
    lastRingDate = null;
    lastRingDone = null;
    return;
  }

  const sameDay = lastRingDone !== null && lastRingDate === s.date;
  const justDone = new Set(
    RING_DOMAINS.filter(([k]) => sameDay && !lastRingDone[k] && s.domains[k]).map(([k]) => k)
  );
  lastRingDate = s.date;
  lastRingDone = { ...s.domains };

  // 2.1.1 — each segment is a neutral track plus a domain-colored arc in
  // the locked map (Intake teal / Synthesis charcoal / Exercise coral /
  // Scripture tan / Family burnt coral). Opacity carries state; the class
  // list, labels, and aria name still carry it without color.
  const segs = RING_DOMAINS.map(([key], i) =>
    `<path class="ring-track" d="${ringSegPath(i)}"/>` +
    `<path class="ring-seg dom-${key}${s.domains[key] ? " done" : ""}${justDone.has(key) ? " just-done" : ""}" d="${ringSegPath(i)}"/>`
  ).join("");

  const legend = RING_DOMAINS.map(([key, label]) => {
    const done = s.domains[key];
    return `<span class="ring-label${done ? " done" : ""}"><i class="ring-dot dom-${key}${done ? " done" : ""}" aria-hidden="true"></i>${label} <span class="ring-label-state">${done ? "✓" : "—"}</span></span>`;
  }).join("");

  // CARPE renders at 5/5 and only at 5/5.
  const carpeLine = s.carpe ? `<div class="ring-carpe">⚡ CARPE POINT EARNED</div>` : "";

  ring.innerHTML =
    `<svg class="ring-svg" viewBox="0 0 64 64" aria-hidden="true" focusable="false">${segs}` +
    `<text class="ring-count" x="32" y="32" text-anchor="middle" dominant-baseline="central">${s.done}/${s.total}</text></svg>` +
    `<div class="ring-body"><div class="ring-legend">${legend}</div>${carpeLine}</div>`;

  // The container is a single button; its accessible name carries every
  // segment's state directly, without relying on color or glyphs.
  const states = RING_DOMAINS.map(([key, label]) => `${label} ${s.domains[key] ? "complete" : "incomplete"}`).join(", ");
  ring.setAttribute("aria-label",
    `Mandate ring: ${s.done} of ${s.total} complete. ${states}.` +
    (s.carpe ? " Carpe point earned." : "") + " Opens CONCURSUS.");

  ring.classList.add("show");
  ring.classList.toggle("carpe", s.carpe);
}

// Fixed order (req 5): CONCURSUS.getProjectedTasks() already returns
// Intake, Synthesis, Exercise, Scripture, Family in that order (DOMAIN_KEYS
// in concursus.js, DM3-01) -- rendered here in the order given, not re-sorted.
function renderConcursusGroup(list) {
  if (typeof CONCURSUS === "undefined") return; // see renderConcursusStrip()
  const projected = CONCURSUS.getProjectedTasks(); // [] before a roll, or on a fail-closed resolution error
  if (!projected.length) return;

  const h = document.createElement("div");
  h.className = "section-label concursus-group-label";
  h.textContent = "CONCURSUS · TODAY";
  list.appendChild(h);
  projected.forEach((t) => list.appendChild(renderConcursusRow(t)));
}

function renderConcursusRow(task) {
  const row = document.createElement("div");
  row.className = "row concursus-row" + (task.completed ? " completed" : "");
  row.dataset.id = task.id;

  const check = document.createElement("button");
  check.className = "check" + (task.completed ? " checked" : "");
  check.setAttribute("aria-label",
    (task.completed ? "Mark incomplete: " : "Mark done: ") + task.title);
  check.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><polyline points="4,13 9,18 20,6"/></svg>`;
  check.addEventListener("click", (e) => {
    e.stopPropagation();
    // req 6 -- the only mutation path, shared with the CONCURSUS tab. Its
    // own subscribe notification (wired in initTabRouter) re-renders this
    // surface too, but re-render directly here as well so a same-tab tap
    // doesn't depend on that ordering to feel immediate.
    CONCURSUS.toggleDomain(task.domain);
    // AB-03: on a first-ever offline launch there's no cache metadata yet and
    // #list is showing the "Can't reach the server" state (see boot()). A
    // full render(all) here would silently replace that with an empty
    // "No open tasks" list. Preserve the connection-error state instead —
    // same gating boot() already applies.
    if (hasCacheMetadata()) {
      const all = sortTasks(getCache());
      render(all);
    }
  });

  const body = document.createElement("div");
  body.className = "row-body";
  // No click-to-edit listener: req 5 -- this group can't be reassigned,
  // reordered, or given a due date, so there's no edit sheet for it.
  body.style.cursor = "default";

  const eyebrow = document.createElement("div");
  eyebrow.className = "row-eyebrow";
  eyebrow.textContent = "CONCURSUS · " + task.domain.toUpperCase();

  const title = document.createElement("div");
  title.className = "row-title";
  title.textContent = task.title;

  const detail = document.createElement("div");
  detail.className = "row-detail";
  detail.textContent = task.detail;

  body.appendChild(eyebrow);
  body.appendChild(title);
  body.appendChild(detail);

  if (task.href) {
    const a = document.createElement("a");
    a.href = task.href;
    a.target = "_blank";
    a.rel = "noopener";
    a.className = "row-link";
    a.textContent = "Open Novaxa ↗";
    a.addEventListener("click", (e) => e.stopPropagation());
    body.appendChild(a);
  }

  row.appendChild(check);
  row.appendChild(body);
  return row;
}

document.getElementById("mandate-ring").addEventListener("click", () => setActiveTab("concursus"));
document.getElementById("mandate-ring").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    setActiveTab("concursus");
  }
});

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
  // 1.6: checkbox stays completion-only — stopPropagation so a tap here
  // never bubbles to the row body's click-to-edit listener below.
  check.addEventListener("click", (e) => {
    e.stopPropagation();
    completeTask(task, row, check);
  });

  const body = document.createElement("div");
  body.className = "row-body";
  body.addEventListener("click", () => openEditSheet(task, body));

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

// --- edit sheet (backlog 1.6): tap a row body to reschedule/retag it ---
// Title · Due · Priority · Area all ship in v1. Due reuses 1.5's working
// pattern verbatim (— / Today / Tmrw chips + a plain visible native date
// input) but keeps its own state (editDue) — the quick-add row's state
// must not leak into an open edit, and vice versa.
let editingTask = null;   // the task currently open in the sheet, or null
let editOriginal = null;  // pre-edit snapshot, for dirty-check + rollback
let editDue = "";         // "" means no due date
let editSaving = false;
let editTriggerEl = null; // the row-body that opened the sheet — focus returns here on close

// Notion may return a full datetime ("...T09:00:00+07:00"); the sheet only
// ever displays/edits the date part. editDue and every dirty/payload
// comparison below run through dueDate() on both sides, so an untouched
// Due field can never get flattened to date-only and shipped in a PATCH
// that wasn't asked for — a Title-only edit must never touch Due.
function openEditSheet(task, triggerEl) {
  editingTask = task;
  editOriginal = { ...task };
  editTriggerEl = triggerEl || null;
  editDue = task.due ? dueDate(task.due) : "";
  document.getElementById("edit-title").value = task.title || "";
  document.getElementById("edit-priority").value = task.priority || "P3 - Medium";
  document.getElementById("edit-area").value = task.area || "";
  renderEditDueChips();
  editSaving = false;
  showEditMsg("");
  updateSaveButton();
  document.body.classList.add("sheet-open"); // lock background scroll while open
  document.getElementById("edit-backdrop").classList.add("show");
  document.getElementById("edit-sheet").classList.add("show");
  // Focus the sheet container, not the Title input. Auto-focusing a text
  // field summons the iOS keyboard immediately, and the *first* tap outside
  // a focused field on iOS is consumed just to dismiss the keyboard rather
  // than registering on whatever was actually tapped — which silently ate
  // taps on Cancel and the drag handle, both near the bottom of the sheet.
  // The container (tabindex="-1" in the markup) still satisfies "initial
  // focus goes somewhere intentional" for the dialog without that cost;
  // the user taps Title deliberately if they want to edit it.
  document.getElementById("edit-sheet").focus();
}

function closeEditSheet() {
  editingTask = null;
  editOriginal = null;
  editDue = "";
  editSaving = false;
  // Blur whatever's focused (e.g. Title, if the user tapped into it) before
  // hiding the sheet — a focused-but-hidden input is its own source of
  // stray keyboard/focus weirdness on iOS.
  if (document.activeElement && typeof document.activeElement.blur === "function") {
    document.activeElement.blur();
  }
  document.body.classList.remove("sheet-open");
  document.getElementById("edit-backdrop").classList.remove("show");
  document.getElementById("edit-sheet").classList.remove("show");
  if (editTriggerEl && typeof editTriggerEl.focus === "function") editTriggerEl.focus();
  editTriggerEl = null;
}

function showEditMsg(msg, isError) {
  const el = document.getElementById("edit-sheet-msg");
  if (!el) return;
  el.textContent = msg || "";
  el.classList.toggle("error", !!isError);
}

// Trim, reject empty, cap at 200 — the same rule the Worker enforces
// server-side (BUG-07's validateInput()). Checked client-side so a bad
// title is a disabled button and an inline message, never a network
// round-trip that comes back 400.
function editTitleValidation() {
  const raw = document.getElementById("edit-title").value;
  const trimmed = raw.trim();
  if (!trimmed) return { valid: false, trimmed, message: "Title can't be empty." };
  if (trimmed.length > 200) return { valid: false, trimmed, message: "Title must be 200 characters or fewer." };
  return { valid: true, trimmed, message: "" };
}

// Save stays disabled until something actually changed — a no-op edit
// (open, look, close) must never call the Worker. Due is compared as
// dueDate(editDue) vs. dueDate(originalTask.due) on both sides, so a
// full Notion datetime the user never touched can't register as "dirty."
function isEditDirty() {
  if (!editingTask) return false;
  const { trimmed: title } = editTitleValidation();
  const priority = document.getElementById("edit-priority").value;
  const area = document.getElementById("edit-area").value;
  const origDue = editOriginal.due ? dueDate(editOriginal.due) : "";
  return (
    title !== (editOriginal.title || "") ||
    priority !== (editOriginal.priority || "") ||
    area !== (editOriginal.area || "") ||
    editDue !== origDue
  );
}

function updateSaveButton() {
  const btn = document.getElementById("edit-save");
  if (!btn) return;
  const validation = editTitleValidation();
  const dirty = isEditDirty();
  btn.disabled = editSaving || !dirty || !validation.valid;
  btn.textContent = editSaving ? "Saving…" : "Save";
  if (!editSaving) showEditMsg(validation.valid ? "" : validation.message, true);
}

function renderEditDueChips() {
  const wrap = document.getElementById("edit-due-chips");
  if (!wrap) return;
  const t = todayISO();
  const tm = tomorrowISO();
  wrap.querySelectorAll(".due-chip[data-due]").forEach((btn) => {
    const kind = btn.dataset.due;
    const val = kind === "today" ? t : kind === "tomorrow" ? tm : "";
    btn.classList.toggle("active", editDue === val);
  });
  const customInput = document.getElementById("edit-due-custom");
  const placeholder = document.getElementById("edit-due-placeholder");
  if (customInput) {
    const isCustom = editDue && editDue !== t && editDue !== tm;
    customInput.classList.toggle("active", !!isCustom);
    customInput.value = isCustom ? editDue : "";
    if (placeholder) placeholder.classList.toggle("hidden", !!customInput.value);
  }
  updateSaveButton();
}

document.querySelectorAll("#edit-due-chips .due-chip[data-due]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const kind = btn.dataset.due;
    editDue = kind === "today" ? todayISO() : kind === "tomorrow" ? tomorrowISO() : "";
    renderEditDueChips();
  });
});
document.getElementById("edit-due-custom").addEventListener("change", (e) => {
  if (!e.target.value) return;
  editDue = e.target.value;
  renderEditDueChips();
});
document.getElementById("edit-title").addEventListener("input", updateSaveButton);
document.getElementById("edit-priority").addEventListener("change", updateSaveButton);
document.getElementById("edit-area").addEventListener("change", updateSaveButton);

// Clean dismiss closes silently; a dirty dismiss confirms first. Cancel,
// backdrop tap, and swipe-down all route through here so the rule is
// enforced in exactly one place.
function requestCloseEditSheet() {
  if (!editingTask) return;
  if (isEditDirty()) {
    if (confirm("Discard changes?")) closeEditSheet();
  } else {
    closeEditSheet();
  }
}
document.getElementById("edit-cancel").addEventListener("click", requestCloseEditSheet);
document.getElementById("edit-backdrop").addEventListener("click", requestCloseEditSheet);

document.getElementById("edit-sheet").addEventListener("keydown", (e) => {
  if (!editingTask) return;
  if (e.key === "Escape") {
    e.preventDefault();
    requestCloseEditSheet();
    return;
  }
  // Light Tab trap — keeps focus inside the sheet while it's open, per
  // standard dialog behavior (role="dialog" aria-modal="true" in the markup).
  if (e.key !== "Tab") return;
  const items = Array.from(
    document.getElementById("edit-sheet").querySelectorAll("input, select, button")
  ).filter((el) => !el.disabled);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});

// Swipe-to-dismiss only starts from the drag handle — never from the sheet
// body, where the same gesture would collide with internal scrolling,
// native <select> menus, the native date picker, or a scroll while the
// keyboard is open. The handle is a small, inert 36x4px strip with no
// interactive children, so there's nothing else it could steal a gesture
// from.
(function initEditSwipe() {
  const handle = document.getElementById("edit-sheet-handle");
  if (!handle) return;
  let startY = null;
  handle.addEventListener("touchstart", (e) => { startY = e.touches[0].clientY; }, { passive: true });
  handle.addEventListener("touchend", (e) => {
    if (startY === null) return;
    const dy = e.changedTouches[0].clientY - startY;
    startY = null;
    if (dy > 70) requestCloseEditSheet(); // swipe-down beyond threshold
  }, { passive: true });
})();

function showToast(msg) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 200);
  }, 2200);
}

// Confirm-then-render: nothing changes in the cache, the list, or the sheet
// until the Worker confirms the write. An explicit Save doesn't get the
// benefit of the doubt the way completeTask()'s fire-and-fade does — a task
// disappearing from its view before Notion has actually agreed to the edit
// recreates the exact "did it save or vanish?" problem 1.5 already fixed
// once for due-chip quick-add.
async function saveEdit() {
  if (!editingTask || editSaving) return;
  const validation = editTitleValidation();
  if (!validation.valid) { showEditMsg(validation.message, true); return; }
  if (!isEditDirty()) return;

  const task = editingTask;
  const before = { ...editOriginal };
  const title = validation.trimmed;
  const priority = document.getElementById("edit-priority").value;
  const area = document.getElementById("edit-area").value;
  const due = editDue;
  const origDue = before.due ? dueDate(before.due) : "";

  // Exactly one PATCH, containing only the fields that actually changed —
  // acceptance check 2. Cleared Due/Area go through as explicit null
  // (Worker v4.1 already supports both — acceptance check 3). An untouched
  // Due on a full-datetime task never lands here: due === origDue because
  // both sides went through dueDate().
  const payload = {};
  if (title !== (before.title || "")) payload.title = title;
  if (priority !== (before.priority || "")) payload.priority = priority;
  if (area !== (before.area || "")) payload.area = area || null;
  if (due !== origDue) payload.due = due || null;
  if (!Object.keys(payload).length) { closeEditSheet(); return; }

  editSaving = true;
  updateSaveButton();
  showEditMsg("Saving…", false);

  try {
    // The cache is updated from the Worker's response, not from the local
    // draft — if Notion's write normalizes anything, the server's version
    // wins over what the sheet optimistically assumed.
    const updated = await apiFetch(`/api/tasks/${task.id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });

    const wasInView = viewTasks([before], activeView).length > 0;
    const stillInView = viewTasks([updated], activeView).length > 0;

    const cached = getCache().map((t) => (t.id === task.id ? updated : t));
    setCache(cached);
    const prev = captureRects();
    const all = sortTasks(cached);
    renderChips(all);
    render(all);
    playFlip(prev);
    closeEditSheet();

    // 1.5 fixed silent disappearance once already — a task leaving the
    // active view on a manual edit gets the same explicit confirmation.
    if (wasInView && !stillInView) {
      showToast(`Saved · moved out of ${getView(activeView).label}`);
    }
  } catch (e) {
    // Nothing was touched — cache, list, and sheet are exactly as they
    // were before Save was pressed. Just surface the failure and let the
    // user retry or dismiss.
    editSaving = false;
    updateSaveButton(); // recomputes disabled state and its own message first —
    showEditMsg("Couldn't save — try again.", true); // this write must be the last one, or the failure text gets clobbered
  }
}
document.getElementById("edit-save").addEventListener("click", saveEdit);

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
      // Phase 3 req 11 -- CONCURSUS is pure localStorage and works fully
      // offline even on a first-ever launch with zero synced Notion cache.
      // Render its ring/group before the "can't reach server" message
      // instead of overwriting #list wholesale, which used to hide it.
      renderMandateRing();
      const list = document.getElementById("list");
      list.innerHTML = "";
      renderConcursusGroup(list);
      const err = document.createElement("div");
      err.className = "empty";
      err.textContent = "Can't reach the server. Check your connection or Worker URL.";
      list.appendChild(err);
    }
  }
}

// iOS keeps PWAs alive for hours — a "reopen" is often just a resume, not a
// cold start. Re-resolve the clock-driven view on resume so Thursday-evening
// opens land on Sunday Prep even when the page never actually reloaded.
// Manual picks are left alone (session override holds).
// AB-02: this handler used to re-render only when the auto-resolved view
// changed (and never while a manual view pick was held). CONCURSUS rolls
// over at local midnight independent of the Tasks view, so a resident PWA
// left open past midnight on a held/unchanged view kept showing yesterday's
// CONCURSUS · TODAY rows with dead checkboxes until a tab or view switch
// forced a re-render. Track the date last rendered and compare it against
// CONCURSUS.status().date on every resume; on mismatch, force a full
// re-render regardless of view-change or manual-pick state.
let lastRenderedConcursusDate = null;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  const all = sortTasks(getCache());

  const concursusDateStale =
    typeof CONCURSUS !== "undefined" &&
    CONCURSUS.status().date !== lastRenderedConcursusDate;

  if (viewManual && !concursusDateStale) return;

  const before = activeView;
  if (!viewManual) applyAutoView(all);
  const viewChanged = activeView !== before;

  if (viewChanged || concursusDateStale) {
    if (viewChanged) {
      syncQuickAddArea();
      syncQuickAddDue();
    }
    const prev = captureRects();
    renderChips(all);
    render(all);
    playFlip(prev);
  }
});

// Keep the tracked date in sync with every render path that touches the
// CONCURSUS ring/group, not just this handler's own re-renders.
const _origRenderMandateRing = renderMandateRing;
renderMandateRing = function () {
  _origRenderMandateRing();
  if (typeof CONCURSUS !== "undefined") {
    lastRenderedConcursusDate = CONCURSUS.status().date;
  }
};

// --- tab router (Phase 1 req 5/6) ---
// app.js owns setActiveTab for both "tasks" and "concursus"; index.html
// owns only the <nav id="tabbar"> and #concursus-view markup, concursus.js
// owns nothing about routing. Cold launch defaults to Tasks unless a valid
// tab is recorded for the current session (sessionStorage, not localStorage
// — a fresh app open should default back to Tasks).
const TAB_SESSION_KEY = "app-tab-v1";
const VALID_TABS = ["tasks", "concursus"];

function setActiveTab(tab) {
  if (!VALID_TABS.includes(tab)) return;
  const appEl = document.getElementById("app");
  const ccEl = document.getElementById("concursus-view");
  const tabbarEl = document.getElementById("tabbar");

  tabbarEl.querySelectorAll(".tab-btn").forEach((btn) => {
    const isActive = btn.dataset.tab === tab;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", String(isActive));
  });
  document.body.classList.toggle("concursus-active", tab === "concursus");
  appEl.style.display = tab === "tasks" ? "block" : "none";
  ccEl.style.display = tab === "concursus" ? "block" : "none";

  try { sessionStorage.setItem(TAB_SESSION_KEY, tab); } catch { /* non-fatal */ }

  if (tab === "concursus") {
    CONCURSUS.init(ccEl); // idempotent — safe to call on every switch
  } else {
    // "Returning to Tasks triggers one Tasks render" (Phase 1 req 5) —
    // reuse the same cache-driven re-render the visibilitychange handler
    // already uses, not a network refetch.
    // AB-03: gate the same way boot() does — no cache metadata means #list
    // is showing the connection-error state, and this render(all) call must
    // not replace it with a false "No open tasks".
    const all = sortTasks(getCache());
    renderChips(all);
    if (hasCacheMetadata()) render(all);
  }
}

document.getElementById("tabbar").querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => setActiveTab(btn.dataset.tab));
});

let concursusSubscribed = false;

function initTabRouter() {
  // Phase 3 req 6/7 -- one subscription, fired on every committed CONCURSUS
  // mutation regardless of which tab caused it (roll, re-roll, toggle, or
  // the daily reset picked up on its next status() read). Keeps the Tasks
  // surface's hidden DOM in sync even while CONCURSUS is the visible tab,
  // not just at the moment of switching back. Guarded so a hypothetical
  // second initTabRouter() call never double-subscribes.
  if (!concursusSubscribed) {
    CONCURSUS.subscribe(() => {
      // AB-03: same gating as boot() — don't clobber the connection-error
      // state with an empty-list render when there's no cache metadata yet.
      if (!hasCacheMetadata()) return;
      const all = sortTasks(getCache());
      render(all);
    });
    concursusSubscribed = true;
  }

  let initialTab = "tasks";
  try {
    const stored = sessionStorage.getItem(TAB_SESSION_KEY);
    if (VALID_TABS.includes(stored)) initialTab = stored;
  } catch { /* default to tasks */ }
  setActiveTab(initialTab);
}

// Nav spec: hide the bar (and let capture ride alone) while the keyboard is
// up. body.keyboard-open is what styles.css keys off of for both rules.
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", () => {
    const keyboardUp = window.visualViewport.height < window.innerHeight * 0.75;
    document.body.classList.toggle("keyboard-open", keyboardUp);
  });
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js"));
}

const cfg = getConfig();
if (!cfg || !cfg.url || !cfg.key) {
  showSetup();
} else {
  showApp();
  boot();
  // Deferred: concursus.js (loaded as the next <script> tag) must finish
  // executing before initTabRouter() can safely call CONCURSUS.init() if
  // the remembered tab is "concursus". DOMContentLoaded fires only after
  // every synchronous script in the document has run.
  document.addEventListener("DOMContentLoaded", initTabRouter);
}
