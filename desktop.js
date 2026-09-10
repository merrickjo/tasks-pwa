// Carpe — desktop/web lite view
// Tasks only, no CONCURSUS. Shares localStorage keys with the mobile app
// (app.js) on purpose: same origin means the same browser that's already
// connected on the phone-installed PWA, or on index.html in this same
// browser, needs no separate setup here.
const CFG_KEY = "tasks-cfg-v1";
const CACHE_KEY = "tasks-cache-v2";

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
    headers: { "content-type": "application/json", "x-app-key": cfg.key, ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error("request failed: " + res.status);
  return res.json();
}

function getCacheEntry() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function setCacheEntry(entry) { localStorage.setItem(CACHE_KEY, JSON.stringify(entry)); }
function hasCacheMetadata() { return getCacheEntry() !== null; }
function getCache() { const e = getCacheEntry(); return e ? e.tasks : []; }
function setCache(tasks) { setCacheEntry({ syncedAt: new Date().toISOString(), tasks }); }

// --- date helpers (device local clock, same rule as app.js) ---
function localISO(d = new Date()) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function todayISO() { return localISO(); }
function dueDate(due) { return due ? due.slice(0, 10) : null; }
function parseLocalISODate(iso) {
  const d = dueDate(iso);
  if (!d) return null;
  const [y, m, day] = d.split("-").map((p) => parseInt(p, 10));
  return new Date(y, m - 1, day);
}
function dayDiff(iso) {
  const t = parseLocalISODate(iso), n = parseLocalISODate(todayISO());
  if (!t || !n) return null;
  return Math.round((t - n) / 86400000);
}
function dueLabel(due) {
  const d = dueDate(due);
  if (!d) return null;
  const diff = dayDiff(d);
  if (diff === null) return { text: d, overdue: false };
  if (diff < 0) return { text: `${Math.abs(diff)}d late`, overdue: true };
  if (diff === 0) return { text: "today", overdue: false };
  if (diff === 1) return { text: "tomorrow", overdue: false };
  return { text: parseLocalISODate(d).toLocaleDateString("en-US", { month: "short", day: "numeric" }), overdue: false };
}
function isOverdue(due) { const d = dueDate(due); return d && d < todayISO(); }
function isToday(due) { return dueDate(due) === todayISO(); }

const AREAS = [
  { name: "Church", emoji: "⛪" }, { name: "Blibli", emoji: "🛒" }, { name: "Fitness", emoji: "💪" },
  { name: "Family", emoji: "👨‍👩‍👦" }, { name: "Personal", emoji: "●" },
];

function dueBucket(due) {
  const d = dueDate(due);
  if (d === null) return 3;
  if (d < todayISO()) return 0;
  if (d === todayISO()) return 1;
  return 2;
}
function priorityRank(p) { const m = /^P([1-4])/.exec(p || ""); return m ? parseInt(m[1], 10) : 5; }
function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    const bd = dueBucket(a.due) - dueBucket(b.due);
    if (bd !== 0) return bd;
    const da = dueDate(a.due) || "9999-99-99", db = dueDate(b.due) || "9999-99-99";
    if (da !== db) return da.localeCompare(db);
    const pd = priorityRank(a.priority) - priorityRank(b.priority);
    if (pd !== 0) return pd;
    return (a.title || "").localeCompare(b.title || "");
  });
}

// --- setup flow ---
function showSetup() { el("setup").style.display = "block"; el("app").style.display = "none"; }
function showApp() { el("setup").style.display = "none"; el("app").style.display = "block"; }
function el(id) { return document.getElementById(id); }

el("cfg-save").addEventListener("click", () => {
  const url = el("cfg-url").value.trim(), key = el("cfg-key").value.trim();
  if (!url || !key) return;
  setConfig({ url, key });
  showApp();
  boot();
});

// --- render ---
let editingId = null;

function render(allTasks) {
  el("today-date").textContent = new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  el("task-count").textContent = allTasks.length ? `· ${allTasks.length} open` : "";

  const list = el("list");
  list.innerHTML = "";
  if (!allTasks.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "No open tasks.";
    list.appendChild(e);
    return;
  }

  const overdue = allTasks.filter((t) => isOverdue(t.due));
  const today = allTasks.filter((t) => isToday(t.due));
  const upcoming = allTasks.filter((t) => !isOverdue(t.due) && !isToday(t.due));

  [["Overdue", overdue], ["Today", today], ["Upcoming", upcoming]].forEach(([label, group]) => {
    if (!group.length) return;
    const h = document.createElement("div");
    h.className = "section-label";
    h.textContent = label;
    list.appendChild(h);
    group.forEach((t) => {
      list.appendChild(renderRow(t));
      if (editingId === t.id) list.appendChild(renderEditPanel(t));
    });
  });
}

function renderRow(task) {
  const row = document.createElement("div");
  row.className = "row" + (isOverdue(task.due) ? " overdue-row" : "");
  row.dataset.id = task.id;

  const check = document.createElement("button");
  check.className = "check";
  check.setAttribute("aria-label", "Mark done");
  check.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="4,13 9,18 20,6"/></svg>`;
  check.addEventListener("click", (e) => { e.stopPropagation(); completeTask(task, row, check); });

  const body = document.createElement("div");
  body.className = "row-body";
  body.addEventListener("click", () => {
    editingId = editingId === task.id ? null : task.id;
    render(sortTasks(getCache()));
  });

  const title = document.createElement("div");
  title.className = "row-title";
  title.textContent = task.title;

  const meta = document.createElement("div");
  meta.className = "row-meta";
  const prCode = (task.priority || "").slice(0, 2).toLowerCase();
  const prTag = document.createElement("span");
  prTag.className = "tag" + (prCode === "p1" ? " p1" : "");
  prTag.textContent = prCode || "p3";
  meta.appendChild(prTag);

  const info = dueLabel(task.due);
  if (info) {
    const t = document.createElement("span");
    t.className = "tag" + (info.overdue ? " due-overdue" : "");
    t.textContent = info.text;
    meta.appendChild(t);
  }
  if (task.area) {
    const a = AREAS.find((x) => x.name === task.area);
    const t = document.createElement("span");
    t.className = "tag";
    t.textContent = a ? `${a.emoji} ${task.area}` : task.area;
    meta.appendChild(t);
  }

  body.appendChild(title);
  body.appendChild(meta);
  row.appendChild(check);
  row.appendChild(body);
  return row;
}

function renderEditPanel(task) {
  const panel = document.createElement("div");
  panel.className = "edit-panel";

  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.value = task.title || "";

  const prioSel = document.createElement("select");
  [["P1 - Critical", "P1"], ["P2 - High", "P2"], ["P3 - Medium", "P3"], ["P4 - Low", "P4"]].forEach(([v, l]) => {
    const o = document.createElement("option"); o.value = v; o.textContent = l;
    if (v === task.priority) o.selected = true;
    prioSel.appendChild(o);
  });

  const areaSel = document.createElement("select");
  const noneOpt = document.createElement("option"); noneOpt.value = ""; noneOpt.textContent = "No area";
  areaSel.appendChild(noneOpt);
  AREAS.forEach((a) => {
    const o = document.createElement("option"); o.value = a.name; o.textContent = `${a.emoji} ${a.name}`;
    if (a.name === task.area) o.selected = true;
    areaSel.appendChild(o);
  });

  const dueInput = document.createElement("input");
  dueInput.type = "date";
  dueInput.value = task.due ? dueDate(task.due) : "";

  const save = document.createElement("button");
  save.className = "save"; save.type = "button"; save.textContent = "Save";
  save.addEventListener("click", async () => {
    const payload = {};
    if (titleInput.value.trim() !== (task.title || "")) payload.title = titleInput.value.trim();
    if (prioSel.value !== (task.priority || "")) payload.priority = prioSel.value;
    if (areaSel.value !== (task.area || "")) payload.area = areaSel.value || null;
    const origDue = task.due ? dueDate(task.due) : "";
    if (dueInput.value !== origDue) payload.due = dueInput.value || null;
    if (!Object.keys(payload).length) { editingId = null; render(sortTasks(getCache())); return; }
    save.disabled = true;
    try {
      const updated = await apiFetch(`/api/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      const cached = getCache().map((t) => (t.id === task.id ? updated : t));
      setCache(cached);
      editingId = null;
      render(sortTasks(cached));
    } catch {
      save.disabled = false;
      alert("Couldn't save — try again.");
    }
  });

  const cancel = document.createElement("button");
  cancel.className = "cancel"; cancel.type = "button"; cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => { editingId = null; render(sortTasks(getCache())); });

  panel.appendChild(titleInput);
  panel.appendChild(prioSel);
  panel.appendChild(areaSel);
  panel.appendChild(dueInput);
  panel.appendChild(save);
  panel.appendChild(cancel);
  return panel;
}

async function completeTask(task, rowEl, checkEl) {
  checkEl.classList.add("checked");
  rowEl.classList.add("done");
  try {
    await apiFetch(`/api/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({ status: "Done" }) });
    const cached = getCache().filter((t) => t.id !== task.id);
    setCache(cached);
    render(sortTasks(cached));
  } catch {
    checkEl.classList.remove("checked");
    rowEl.classList.remove("done");
    alert("Couldn't reach the server — try again when back online.");
  }
}

el("capture-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const titleEl = el("new-title");
  const title = titleEl.value.trim();
  if (!title) return;
  const priority = el("new-priority").value;
  const area = el("new-area").value;
  const due = el("new-due").value;
  const btn = el("new-add");
  btn.disabled = true;
  try {
    const payload = { title, priority };
    if (area) payload.area = area;
    if (due) payload.due = due;
    const created = await apiFetch("/api/tasks", { method: "POST", body: JSON.stringify(payload) });
    titleEl.value = "";
    el("new-due").value = "";
    const cached = [created, ...getCache()];
    setCache(cached);
    render(sortTasks(cached));
  } catch {
    alert("Couldn't add — check your connection.");
  } finally {
    btn.disabled = false;
  }
});

// --- boot ---
async function boot() {
  const cached = sortTasks(getCache());
  if (hasCacheMetadata()) render(cached);

  try {
    const { tasks } = await apiFetch("/api/tasks");
    el("offline-banner").classList.remove("show");
    setCache(tasks);
    render(sortTasks(tasks));
  } catch {
    if (hasCacheMetadata()) {
      el("offline-banner").classList.add("show");
    } else {
      const list = el("list");
      list.innerHTML = "";
      const err = document.createElement("div");
      err.className = "empty";
      err.textContent = "Can't reach the server. Check your connection or Worker URL.";
      list.appendChild(err);
    }
  }
}

const cfg = getConfig();
if (!cfg || !cfg.url || !cfg.key) {
  showSetup();
} else {
  showApp();
  boot();
}
