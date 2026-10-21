// CALENDAR tab — 4.4 (21 Oct 2026)
//
// The bullet-journal MONTHLY LOG: a month grid on top, the selected day's
// log underneath. Two signifiers, straight from the paper method:
//   ○  an event   (Outlook work meetings via the Mac mirror + Google, live)
//   •  a task     (open Notch tasks due that day, from the Tasks cache)
// Cells carry counts ("○3 •2"), never colour, so the grid reads the same on
// the HiBreak's e-ink panel as on cream or charcoal.
//
// Writes go to Google only (primary calendar). Outlook stays read-only —
// the calendar of record for work is Outlook, and the mirror only ever
// holds titles + times for the next 7 days.
//
// Load order: after app.js (uses its globals: apiFetch, getCache, sortTasks,
// todayISO, localISO, hhmm, showToast, effectiveTheme/modeIcon/toggleTheme,
// setActiveTab, openEditSheet). app.js owns routing; this file owns only
// what's inside #calendar-view plus its own add-event sheet.

const NOTCH_CAL = (function () {
  const CACHE_KEY = "calendar-cache-v1";  // { "<from>|<to>": { fetchedAt, data } }
  const CACHE_MAX = 4;                    // months kept for offline launches
  const REFETCH_MS = 5 * 60 * 1000;
  const MONTHS = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"]; // Monday-first

  let root = null;
  let viewYear, viewMonth;       // month on screen (month is 0-based)
  let selected = null;           // ISO date of the day log
  let loading = false;
  let loadError = null;
  let sheetBuilt = false;
  let saving = false;

  // ---------- dates (device-local, never toISOString) ----------
  function iso(y, m, d) { return localISO(new Date(y, m, d)); }
  function parseISO(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
  function addDays(s, n) { const d = parseISO(s); d.setDate(d.getDate() + n); return localISO(d); }

  function gridRange(y, m) {
    const first = new Date(y, m, 1);
    const lead = (first.getDay() + 6) % 7;            // Monday-first offset
    const start = new Date(y, m, 1 - lead);
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const cells = Math.ceil((lead + daysInMonth) / 7) * 7;
    const end = new Date(start); end.setDate(start.getDate() + cells - 1);
    return { from: localISO(start), to: localISO(end), cells };
  }

  // ---------- cache ----------
  function readCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch { return {}; }
  }
  function cached(range) {
    const c = readCache()[`${range.from}|${range.to}`];
    return c && c.data ? c : null;
  }
  function writeCache(range, data) {
    const all = readCache();
    all[`${range.from}|${range.to}`] = { fetchedAt: Date.now(), data };
    const keys = Object.keys(all).sort((a, b) => all[b].fetchedAt - all[a].fetchedAt);
    keys.slice(CACHE_MAX).forEach((k) => delete all[k]);
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(all)); } catch {}
  }
  function patchCache(range, fn) {
    const c = cached(range);
    if (!c) return;
    fn(c.data);
    writeCache(range, c.data);
  }

  // ---------- data ----------
  function eventsFor(data, date) {
    if (!data) return [];
    const evs = [...(data.outlook ? data.outlook.events : []), ...(data.google ? data.google.events : [])]
      .filter((e) => e.date === date);
    return evs.sort((a, b) => (a.allDay !== b.allDay ? (a.allDay ? -1 : 1) : Date.parse(a.start) - Date.parse(b.start)));
  }
  function tasksByDate() {
    const map = {};
    let tasks = [];
    try { tasks = sortTasks(getCache()); } catch {}
    tasks.forEach((t) => {
      const d = (t.due || "").slice(0, 10);
      if (!d) return;
      (map[d] = map[d] || []).push(t);
    });
    return map;
  }

  async function load(force) {
    const range = gridRange(viewYear, viewMonth);
    const c = cached(range);
    if (!force && c && Date.now() - c.fetchedAt < REFETCH_MS) return;
    loading = true;
    render();
    try {
      const data = await apiFetch(`/api/calendar?from=${range.from}&to=${range.to}`);
      writeCache(range, data);
      loadError = null;
    } catch (e) {
      loadError = String((e && e.message) || e).replace("request failed: ", "HTTP ");
    } finally {
      loading = false;
      // only repaint if the user is still looking at this month
      const now = gridRange(viewYear, viewMonth);
      if (now.from === range.from) render();
    }
  }

  // ---------- small DOM helper ----------
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

  // ---------- render ----------
  function render() {
    if (!root) return;
    const range = gridRange(viewYear, viewMonth);
    const entry = cached(range);
    const data = entry ? entry.data : null;
    const tmap = tasksByDate();
    const today = todayISO();
    if (!selected) selected = today;

    root.innerHTML = "";
    root.appendChild(buildHeader(today));

    const body = el("div", "cal-body");
    body.appendChild(buildGrid(range, data, tmap, today));
    body.appendChild(buildDayLog(data, tmap, today));
    body.appendChild(buildSources(entry));
    root.appendChild(body);
  }

  function buildHeader(today) {
    const bar = el("div", "cal-headbar");
    const row = el("div", "cal-headbar-row");
    const heading = el("div", "cal-heading");
    heading.appendChild(el("div", "cal-kicker", new Date().toLocaleDateString(undefined, {
      weekday: "long", month: "short", day: "numeric",
    }) + (loading ? " · syncing…" : "")));
    heading.appendChild(el("h1", "cal-title", `${MONTHS[viewMonth]} ${viewYear}`));
    row.appendChild(heading);

    const nav = el("div", "cal-nav");
    nav.appendChild(button("cal-nav-btn", "‹", "Previous month", () => shiftMonth(-1)));
    const t = new Date();
    const onToday = viewYear === t.getFullYear() && viewMonth === t.getMonth() && selected === today;
    const todayBtn = button("cal-today-btn", "Today", "Go to today", () => {
      viewYear = t.getFullYear(); viewMonth = t.getMonth(); selected = today;
      render(); load();
    });
    if (onToday) todayBtn.disabled = true;
    nav.appendChild(todayBtn);
    nav.appendChild(button("cal-nav-btn", "›", "Next month", () => shiftMonth(1)));
    const mode = button("mode-toggle", "", "Switch background mode", () => toggleTheme());
    mode.innerHTML = modeIcon(effectiveTheme());
    nav.appendChild(mode);
    row.appendChild(nav);
    bar.appendChild(row);
    return bar;
  }

  function shiftMonth(n) {
    const d = new Date(viewYear, viewMonth + n, 1);
    viewYear = d.getFullYear(); viewMonth = d.getMonth();
    // keep the day log inside the month you're looking at
    const t = new Date();
    selected = (viewYear === t.getFullYear() && viewMonth === t.getMonth()) ? todayISO() : iso(viewYear, viewMonth, 1);
    render();
    load();
  }

  function buildGrid(range, data, tmap, today) {
    const wrap = el("div", "cal-grid-wrap");
    const head = el("div", "cal-grid cal-weekdays");
    WEEKDAYS.forEach((w) => head.appendChild(el("div", "cal-wd", w)));
    wrap.appendChild(head);

    const grid = el("div", "cal-grid");
    grid.setAttribute("role", "grid");
    for (let i = 0; i < range.cells; i++) {
      const date = addDays(range.from, i);
      const d = parseISO(date);
      const inMonth = d.getMonth() === viewMonth;
      const evN = eventsFor(data, date).length;
      const tkN = (tmap[date] || []).length;
      const cell = el("button", "cal-cell");
      cell.type = "button";
      if (!inMonth) cell.classList.add("out");
      if (date === today) cell.classList.add("today");
      if (date === selected) cell.classList.add("selected");
      if (date < today && tkN) cell.classList.add("overdue");
      const parts = [];
      if (evN) parts.push(`${evN} event${evN > 1 ? "s" : ""}`);
      if (tkN) parts.push(`${tkN} task${tkN > 1 ? "s" : ""}`);
      cell.setAttribute("aria-label", d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }) +
        (parts.length ? ", " + parts.join(", ") : ""));
      cell.appendChild(el("span", "cal-num", String(d.getDate())));
      const marks = el("span", "cal-marks");
      if (evN) marks.appendChild(el("span", "cal-mark", `○${evN}`));
      if (tkN) marks.appendChild(el("span", "cal-mark", `•${tkN}`));
      cell.appendChild(marks);
      cell.addEventListener("click", () => {
        if (!inMonth) { viewYear = d.getFullYear(); viewMonth = d.getMonth(); selected = date; render(); load(); return; }
        selected = date;
        render();
      });
      grid.appendChild(cell);
    }
    wrap.appendChild(grid);
    bindSwipe(wrap);
    return wrap;
  }

  // Horizontal swipe on the grid flips months; vertical motion stays a scroll.
  function bindSwipe(node) {
    let x0 = null, y0 = null;
    node.addEventListener("touchstart", (e) => { const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; }, { passive: true });
    node.addEventListener("touchend", (e) => {
      if (x0 === null) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - x0, dy = t.clientY - y0;
      x0 = null;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) shiftMonth(dx < 0 ? 1 : -1);
    }, { passive: true });
  }

  function buildDayLog(data, tmap, today) {
    const box = el("section", "cal-day");
    const d = parseISO(selected);
    const label = el("div", "section-label cal-day-label");
    const rel = selected === today ? "TODAY · " : selected === addDays(today, 1) ? "TOMORROW · " : "";
    label.appendChild(el("span", null, rel + d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }).toUpperCase()));
    label.appendChild(button("cal-add-btn", "+ EVENT", "Add an event on this day", () => openSheet()));
    box.appendChild(label);

    const evs = eventsFor(data, selected);
    const tasks = tmap[selected] || [];
    if (!evs.length && !tasks.length) {
      box.appendChild(el("div", "cal-empty", data ? "Nothing logged." : (loading ? "Loading…" : "No calendar data yet.")));
      return box;
    }
    const now = Date.now();
    evs.forEach((e) => box.appendChild(eventRow(e, now)));
    tasks.forEach((t) => box.appendChild(taskRow(t, today)));
    return box;
  }

  function eventRow(e, now) {
    const row = el("div", "row agenda-row cal-ev");
    if (!e.allDay && Date.parse(e.end) <= now) row.classList.add("past");
    if (!e.allDay && Date.parse(e.start) <= now && now < Date.parse(e.end)) row.classList.add("now");
    const time = el("div", "agenda-time", e.allDay ? "all day" : hhmm(e.start));
    if (!e.allDay) time.appendChild(el("span", null, hhmm(e.end)));
    row.appendChild(time);
    const body = el("div", "row-body");
    const title = el("div", "row-title");
    title.appendChild(el("span", "cal-sig", "○"));
    title.appendChild(document.createTextNode(e.title));
    body.appendChild(title);
    row.appendChild(body);
    row.appendChild(el("div", "cal-src", e.source === "outlook" ? "work" : "google"));
    if (e.source === "google" && e.id) {
      body.addEventListener("click", () => deleteEvent(e));
    } else {
      body.style.cursor = "default";
    }
    return row;
  }

  function taskRow(t, today) {
    const row = el("div", "row cal-task");
    if (selected < today) row.classList.add("overdue");
    row.appendChild(el("div", "agenda-time", t.priority ? t.priority.slice(0, 2) : ""));
    const body = el("div", "row-body");
    const title = el("div", "row-title");
    title.appendChild(el("span", "cal-sig", "•"));
    title.appendChild(document.createTextNode(t.title));
    body.appendChild(title);
    if (t.area) body.appendChild(el("div", "cal-task-meta", t.area));
    body.addEventListener("click", () => {
      // Tasks own their edit sheet — hop over and open it there.
      setActiveTab("tasks");
      openEditSheet(t, null);
    });
    row.appendChild(body);
    return row;
  }

  function buildSources(entry) {
    const box = el("div", "cal-sources");
    const data = entry ? entry.data : null;
    if (loadError) {
      const line = el("div", "cal-src-line");
      line.appendChild(el("span", null, `Couldn't refresh (${loadError})` + (entry ? " · showing last sync" : "")));
      line.appendChild(button("cal-link-btn", "Retry", null, () => load(true)));
      box.appendChild(line);
    }
    const g = data && data.google ? data.google : null;
    const gline = el("div", "cal-src-line");
    if (!g) {
      gline.appendChild(el("span", null, "GOOGLE · —"));
    } else if (g.status === "connected") {
      gline.appendChild(el("span", null, "GOOGLE · connected · tap an event to delete it"));
      gline.appendChild(button("cal-link-btn", "Disconnect", "Disconnect Google Calendar", disconnectGoogle));
    } else if (g.status === "not_connected") {
      gline.appendChild(el("span", null, "GOOGLE · not connected"));
      gline.appendChild(button("cal-link-btn", "Connect", "Connect Google Calendar", connectGoogle));
    } else if (g.status === "not_configured") {
      gline.appendChild(el("span", null, "GOOGLE · not set up on the Worker yet"));
    } else {
      gline.appendChild(el("span", null, `GOOGLE · couldn't load (${g.error || "error"})`));
      gline.appendChild(button("cal-link-btn", "Retry", null, () => load(true)));
    }
    box.appendChild(gline);
    const o = data && data.outlook;
    const synced = o && o.syncedAt ? ` · synced ${new Date(o.syncedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${hhmm(o.syncedAt)}` : "";
    box.appendChild(el("div", "cal-src-line", `WORK · Outlook, next 7 days only${synced}`));
    return box;
  }

  // ---------- Google ----------
  async function connectGoogle() {
    try {
      const { url } = await apiFetch("/api/google/connect", { method: "POST" });
      window.location.href = url;
    } catch (e) {
      showToast("Couldn't start Google sign-in");
    }
  }
  async function disconnectGoogle() {
    if (!confirm("Disconnect Google Calendar from Notch?")) return;
    try {
      await apiFetch("/api/google/disconnect", { method: "POST" });
      showToast("Google disconnected");
    } catch { showToast("Couldn't disconnect"); }
    load(true);
  }
  async function deleteEvent(e) {
    if (!confirm(`Delete "${e.title}" from Google Calendar?`)) return;
    try {
      await apiFetch(`/api/calendar/events/${encodeURIComponent(e.id)}`, { method: "DELETE" });
      patchCache(gridRange(viewYear, viewMonth), (d) => { d.google.events = d.google.events.filter((x) => x.id !== e.id); });
      showToast("Deleted");
      render();
    } catch (err) {
      showToast("Couldn't delete");
      load(true);
    }
  }

  // ---------- add-event sheet (reuses the Tasks edit-sheet look) ----------
  function buildSheet() {
    if (sheetBuilt) return;
    sheetBuilt = true;
    const backdrop = el("div", "edit-backdrop");
    backdrop.id = "cal-backdrop";
    backdrop.addEventListener("click", closeSheet);
    const sheet = el("div", "edit-sheet");
    sheet.id = "cal-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", "Add event");
    sheet.tabIndex = -1;
    sheet.innerHTML = `
      <div class="edit-sheet-handle"></div>
      <div class="edit-sheet-body">
        <input type="text" id="cal-ev-title" class="edit-title-input" placeholder="Event title" maxlength="200" autocomplete="off">
        <div class="edit-field-label">Date</div>
        <input type="date" id="cal-ev-date" class="edit-select cal-input">
        <div class="edit-field-label">Time</div>
        <div class="capture-due cal-time-chips">
          <button type="button" class="due-chip" id="cal-ev-allday">All day</button>
          <button type="button" class="due-chip" id="cal-ev-timed">Timed</button>
        </div>
        <div class="cal-time-row" id="cal-ev-times">
          <input type="time" id="cal-ev-start" class="edit-select cal-input" aria-label="Start time">
          <span class="cal-time-sep">–</span>
          <input type="time" id="cal-ev-end" class="edit-select cal-input" aria-label="End time">
        </div>
        <div class="edit-sheet-msg" id="cal-ev-msg"></div>
        <div class="edit-sheet-actions">
          <button type="button" id="cal-ev-cancel" class="edit-btn edit-btn-cancel">Cancel</button>
          <button type="button" id="cal-ev-save" class="edit-btn edit-btn-save">Add to Google</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    document.body.appendChild(sheet);
    document.getElementById("cal-ev-cancel").addEventListener("click", closeSheet);
    document.getElementById("cal-ev-save").addEventListener("click", saveEvent);
    document.getElementById("cal-ev-allday").addEventListener("click", () => setTimed(false));
    document.getElementById("cal-ev-timed").addEventListener("click", () => setTimed(true));
    document.getElementById("cal-ev-title").addEventListener("keydown", (e) => { if (e.key === "Enter") saveEvent(); });
    document.getElementById("cal-ev-start").addEventListener("change", () => {
      const s = document.getElementById("cal-ev-start").value;
      const endEl = document.getElementById("cal-ev-end");
      if (s && (!endEl.value || endEl.value <= s)) endEl.value = plusHour(s);
    });
  }
  let timed = true;
  function setTimed(v) {
    timed = v;
    document.getElementById("cal-ev-allday").classList.toggle("active", !v);
    document.getElementById("cal-ev-timed").classList.toggle("active", v);
    document.getElementById("cal-ev-times").style.display = v ? "flex" : "none";
  }
  function plusHour(hm) {
    const [h, m] = hm.split(":").map(Number);
    return h >= 23 ? "23:59" : `${String(h + 1).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  function defaultStart() {
    if (selected !== todayISO()) return "09:00";
    const h = new Date().getHours() + 1;
    return h > 22 ? "22:00" : `${String(h).padStart(2, "0")}:00`;
  }
  function msg(text, isError) {
    const m = document.getElementById("cal-ev-msg");
    m.textContent = text || "";
    m.classList.toggle("error", !!isError);
  }

  function googleStatusNow() {
    const c = cached(gridRange(viewYear, viewMonth));
    return c && c.data && c.data.google ? c.data.google.status : null;
  }

  function openSheet() {
    const st = googleStatusNow();
    if (st === "not_configured") { showToast("Google isn't set up on the Worker yet"); return; }
    if (st === "not_connected") {
      if (confirm("Events are added to your Google Calendar. Connect Google now?")) connectGoogle();
      return;
    }
    buildSheet();
    saving = false;
    document.getElementById("cal-ev-title").value = "";
    document.getElementById("cal-ev-date").value = selected;
    const s = defaultStart();
    document.getElementById("cal-ev-start").value = s;
    document.getElementById("cal-ev-end").value = plusHour(s);
    setTimed(true);
    msg("");
    document.getElementById("cal-ev-save").disabled = false;
    document.body.classList.add("sheet-open");
    document.getElementById("cal-backdrop").classList.add("show");
    const sheet = document.getElementById("cal-sheet");
    sheet.classList.add("show");
    sheet.focus(); // not the title — see openEditSheet() in app.js on iOS taps
  }
  function closeSheet() {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    document.body.classList.remove("sheet-open");
    const b = document.getElementById("cal-backdrop");
    const s = document.getElementById("cal-sheet");
    if (b) b.classList.remove("show");
    if (s) s.classList.remove("show");
  }

  async function saveEvent() {
    if (saving) return;
    const title = document.getElementById("cal-ev-title").value.trim();
    const date = document.getElementById("cal-ev-date").value;
    const start = document.getElementById("cal-ev-start").value;
    const end = document.getElementById("cal-ev-end").value;
    if (!title) { msg("Give it a title.", true); return; }
    if (!date) { msg("Pick a date.", true); return; }
    if (timed && (!start || !end || end <= start)) { msg("End must be after start.", true); return; }
    saving = true;
    document.getElementById("cal-ev-save").disabled = true;
    msg("Adding…");
    try {
      const ev = await apiFetch("/api/calendar/events", {
        method: "POST",
        body: JSON.stringify(timed ? { title, date, start, end } : { title, date }),
      });
      // Confirm-then-render (same rule as task edits): the event shows up
      // only after Google has it.
      const range = gridRange(viewYear, viewMonth);
      if (ev && date >= range.from && date <= range.to) {
        patchCache(range, (d) => { d.google.events.push(ev); });
      }
      closeSheet();
      selected = date;
      const d = parseISO(date);
      if (d.getMonth() !== viewMonth || d.getFullYear() !== viewYear) {
        viewYear = d.getFullYear(); viewMonth = d.getMonth();
        load(true);
      }
      render();
      showToast("Added to Google Calendar");
    } catch (e) {
      saving = false;
      document.getElementById("cal-ev-save").disabled = false;
      msg("Couldn't add it — " + String((e && e.message) || e).replace("request failed: ", "HTTP "), true);
    }
  }

  // ---------- public ----------
  function init(container) {
    if (!root) {
      root = container;
      const t = new Date();
      viewYear = t.getFullYear();
      viewMonth = t.getMonth();
    }
    render();
    load();
  }
  // Called on resume / after Google sign-in returns.
  function refresh(force) {
    if (!root) return;
    render();
    load(force);
  }
  return { init, refresh };
})();
