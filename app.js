// Tasks PWA — app logic
// Talks to a Cloudflare Worker proxy (see /worker), never to Notion directly
// (Notion's API has no browser CORS support, so something has to sit in between).

const CACHE_KEY = "tasks-cache-v1";
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
function todayISO() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}
function isOverdue(due) {
  return due && due < todayISO();
}
function isToday(due) {
  return due === todayISO();
}

// --- rendering ---
function render(tasks) {
  const list = document.getElementById("list");
  document.getElementById("task-count").textContent = tasks.length ? `· ${tasks.length} open` : "";
  document.getElementById("today-date").textContent = new Date().toLocaleDateString(undefined, {
    weekday: "long", month: "short", day: "numeric",
  });

  if (!tasks.length) {
    list.innerHTML = `<div class="empty">Nothing open. Clean slate.</div>`;
    return;
  }

  const overdue = tasks.filter((t) => isOverdue(t.due));
  const today = tasks.filter((t) => isToday(t.due));
  const upcoming = tasks.filter((t) => !isOverdue(t.due) && !isToday(t.due));

  list.innerHTML = "";
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
    dueTag.textContent = task.due;
    meta.appendChild(dueTag);
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
    setTimeout(() => rowEl.remove(), 260);
    const cached = getCache().filter((t) => t.id !== task.id);
    setCache(cached);
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
  const btn = document.getElementById("new-add");
  btn.disabled = true;
  try {
    const created = await apiFetch("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ title, priority }),
    });
    titleEl.value = "";
    const cached = [created, ...getCache()];
    setCache(cached);
    render(sortTasks(cached));
  } catch (e) {
    alert("Couldn't add — check your connection.");
  } finally {
    btn.disabled = false;
  }
}

// --- cache ---
function getCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || []; } catch { return []; }
}
function setCache(tasks) { localStorage.setItem(CACHE_KEY, JSON.stringify(tasks)); }

function sortTasks(tasks) {
  return [...tasks].sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
}

// --- boot ---
async function boot() {
  const cached = getCache();
  if (cached.length) render(sortTasks(cached));

  try {
    const { tasks } = await apiFetch("/api/tasks");
    document.getElementById("offline-banner").classList.remove("show");
    setCache(tasks);
    render(sortTasks(tasks));
  } catch (e) {
    if (cached.length) {
      document.getElementById("offline-banner").classList.add("show");
    } else {
      document.getElementById("list").innerHTML =
        `<div class="empty">Can't reach the server. Check your connection or Worker URL.</div>`;
    }
  }
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
}
