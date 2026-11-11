// CALENDAR tab — 4.4 (21 Oct 2026)
//
// Month grid, 7-day and 3-day time grids, and a single-day agenda.
// Two signifiers, straight from the paper method:
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
  const VIEW_KEY = "calendar-view-v1";
  const VIEWS = { month: "Month", week: "7 days", three: "3 days", day: "Day" };
  const VIEW_DAYS = { week: 7, three: 3, day: 1 };
  const CACHE_MAX = 4;                    // months kept for offline launches
  const REFETCH_MS = 5 * 60 * 1000;
  const MONTHS = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"]; // Monday-first
  const CELL_LINES = 3;                   // entries shown per cell on desktop
  const DAY_MINUTES = 24 * 60;
  const INITIAL_GRID_HOUR = 7;

  let root = null;
  let viewYear, viewMonth;       // month on screen (month is 0-based)
  let view = "month";
  let selected = null;           // ISO date of the day log
  let loading = false;
  let loadError = null;
  let sheetBuilt = false;
  let saving = false;
  let editing = null;
  let calendarRevision = 0;
  const googleTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });

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

  function visibleEnd() {
    return addDays(selected, VIEW_DAYS[view] - 1);
  }

  function dataRange() {
    const month = gridRange(viewYear, viewMonth);
    if (view === "month" || view === "day" || !selected) return month;
    const end = visibleEnd();
    // Include the previous day so an overnight event can continue into the grid.
    const previous = addDays(selected, -1);
    return { from: previous < month.from ? previous : month.from, to: end > month.to ? end : month.to };
  }

  // ---------- cache ----------
  function readCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch { return {}; }
  }
  function cached(range) {
    return Object.entries(readCache()).reduce((newest, [key, entry]) => {
      const [from, to] = key.split("|");
      if (!entry.data || from > range.from || to < range.to) return newest;
      return !newest || newest.fetchedAt < entry.fetchedAt ? entry : newest;
    }, null);
  }
  function writeCache(range, data) {
    const all = readCache();
    all[`${range.from}|${range.to}`] = { fetchedAt: Date.now(), data };
    const keys = Object.keys(all).sort((a, b) => all[b].fetchedAt - all[a].fetchedAt);
    keys.slice(CACHE_MAX).forEach((k) => delete all[k]);
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(all)); } catch {}
  }
  function updateEventCache(id, event) {
    calendarRevision++;
    const all = readCache();
    for (const [key, entry] of Object.entries(all)) {
      const google = entry.data?.google;
      if (!google) continue;
      const [from, to] = key.split("|");
      google.events = google.events.filter((e) => e.id !== id);
      if (event && event.date >= from && event.date <= to) google.events.push(event);
    }
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(all)); } catch {}
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
    const range = dataRange();
    const c = cached(range);
    if (!force && c && Date.now() - c.fetchedAt < REFETCH_MS &&
        c.data.google?.events.every((e) => typeof e.editable === "boolean")) return;
    const revision = calendarRevision;
    // 4.6.2 — on e-ink a rebuild is a visible full refresh: show "syncing…"
    // by editing the kicker in place, and rebuild afterwards only if the
    // month actually changed (or there was nothing on screen yet).
    loading = true;
    const before = c ? JSON.stringify(c.data) : null;
    const prevError = loadError;
    if (!c) render(); else setKicker();
    let changed = !c;
    try {
      const data = await apiFetch(`/api/calendar?from=${range.from}&to=${range.to}`);
      if (revision !== calendarRevision) return;
      writeCache(range, data);
      loadError = null;
      changed = changed || JSON.stringify(data) !== before;
    } catch (e) {
      if (revision === calendarRevision) loadError = String((e && e.message) || e).replace("request failed: ", "HTTP ");
    } finally {
      loading = false;
      if (loadError !== prevError) changed = true;
      // only repaint if the user is still looking at this month
      const now = dataRange();
      if (now.from === range.from && now.to === range.to) { if (changed) render(); else setKicker(); }
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
    const today = todayISO();
    if (!selected) selected = today;
    const range = dataRange();
    const entry = cached(range);
    const data = entry ? entry.data : null;
    const tmap = tasksByDate();
    const previousGrid = root.querySelector(".cal-time-scroll");
    const gridTop = previousGrid?.scrollTop;
    const gridLeft = previousGrid?.dataset.start === selected ? previousGrid.scrollLeft : 0;

    root.innerHTML = "";
    root.appendChild(buildHeader(today));

    const body = el("div", "cal-body");
    if (view === "month") {
      body.appendChild(buildGrid(range, data, tmap, today));
      body.appendChild(buildDayLog(selected, data, tmap, today));
    } else if (view === "day") {
      const days = el("div", "cal-agenda-days");
      days.appendChild(buildDayLog(selected, data, tmap, today));
      bindSwipe(days);
      body.appendChild(days);
    } else {
      body.appendChild(buildTimeGrid(data, tmap, today));
    }
    body.appendChild(buildSources(entry));
    root.appendChild(body);
    const grid = body.querySelector(".cal-time-scroll");
    if (grid) {
      grid.scrollTop = gridTop ?? INITIAL_GRID_HOUR * 60;
      grid.scrollLeft = gridLeft;
    }
  }

  function kickerText() {
    return new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }) + (loading ? " · syncing…" : "");
  }
  function setKicker() {
    const k = root && root.querySelector(".cal-kicker");
    if (k) k.textContent = kickerText();
  }

  function viewTitle() {
    if (view === "month") return `${MONTHS[viewMonth]} ${viewYear}`;
    const fmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
    const start = parseISO(selected);
    if (view === "day") return fmt.format(start);
    const end = parseISO(visibleEnd());
    return fmt.formatRange ? fmt.formatRange(start, end) : fmt.format(start) + " – " + fmt.format(end);
  }

  function buildHeader(today) {
    const bar = el("div", "cal-headbar");
    const row = el("div", "cal-headbar-row");
    const heading = el("div", "cal-heading");
    heading.appendChild(el("div", "cal-kicker", kickerText()));
    heading.appendChild(el("h1", "cal-title", viewTitle()));
    row.appendChild(heading);

    const nav = el("div", "cal-nav");
    const span = VIEWS[view].toLowerCase();
    nav.appendChild(button("cal-nav-btn", "‹", `Previous ${span}`, () => shiftView(-1)));
    const todayBtn = button("cal-today-btn", "Today", "Go to today", goToday);
    if (selected === today) todayBtn.disabled = true;
    nav.appendChild(todayBtn);
    nav.appendChild(button("cal-nav-btn", "›", `Next ${span}`, () => shiftView(1)));
    const mode = button("mode-toggle", "", "Switch background mode", () => toggleTheme());
    mode.innerHTML = modeIcon(effectiveTheme());
    nav.appendChild(mode);
    row.appendChild(nav);
    bar.appendChild(row);
    const picker = el("div", "cal-view-picker");
    picker.setAttribute("role", "group");
    picker.setAttribute("aria-label", "Calendar view");
    for (const [key, label] of Object.entries(VIEWS)) {
      const option = button("cal-view-option", label, null, () => {
        if (view === key) return;
        view = key;
        try { localStorage.setItem(VIEW_KEY, view); } catch {}
        render();
        root.querySelector(`[data-calendar-view="${view}"]`)?.focus({ preventScroll: true });
        load();
      });
      option.dataset.calendarView = key;
      option.setAttribute("aria-pressed", String(key === view));
      picker.appendChild(option);
    }
    bar.appendChild(picker);
    return bar;
  }

  function selectDate(date) {
    selected = date;
    const d = parseISO(date);
    viewYear = d.getFullYear(); viewMonth = d.getMonth();
    render();
    load();
  }

  function shiftView(n) {
    if (view === "month") shiftMonth(n);
    else moveDay(n * VIEW_DAYS[view]);
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
      // 4.5 — wide screens have room for the entries themselves; CSS shows
      // this list instead of the counts at ≥900px (phones keep the counts).
      const lines = [
        ...eventsFor(data, date).map((e) => ({ sig: "○", text: (e.allDay ? "" : hhmm(e.start) + " ") + e.title })),
        ...(tmap[date] || []).map((t) => ({ sig: "•", text: t.title })),
      ];
      if (lines.length) {
        const list = el("span", "cal-lines");
        lines.slice(0, CELL_LINES).forEach((l) => {
          const li = el("span", "cal-line");
          li.appendChild(el("span", "cal-line-sig", l.sig));
          li.appendChild(document.createTextNode(l.text));
          list.appendChild(li);
        });
        if (lines.length > CELL_LINES) list.appendChild(el("span", "cal-line cal-line-more", `+${lines.length - CELL_LINES} more`));
        cell.appendChild(list);
      }
      cell.addEventListener("click", () => selectDate(date));
      grid.appendChild(cell);
    }
    wrap.appendChild(grid);
    bindSwipe(wrap);
    return wrap;
  }

  // Horizontal swipe pages the active view; vertical motion stays a scroll.
  function bindSwipe(node) {
    let x0 = null, y0 = null;
    node.addEventListener("touchstart", (e) => { const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; }, { passive: true });
    node.addEventListener("touchend", (e) => {
      if (x0 === null) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - x0, dy = t.clientY - y0;
      x0 = null;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) shiftView(dx < 0 ? 1 : -1);
    }, { passive: true });
  }

  function buildDayLog(date, data, tmap, today) {
    const box = el("section", "cal-day");
    const d = parseISO(date);
    const label = el("div", "section-label cal-day-label");
    const rel = date === today ? "TODAY · " : date === addDays(today, 1) ? "TOMORROW · " : "";
    const dayLabel = d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
    const heading = el("h2", "cal-day-heading", rel + dayLabel.toUpperCase());
    heading.id = "cal-day-" + date;
    label.appendChild(heading);
    box.setAttribute("aria-labelledby", heading.id);
    // 4.6 — the day's journal page is one tap away (the monthly log points
    // at the daily log, as on paper).
    const acts = el("span", "cal-day-acts");
    acts.appendChild(button("cal-add-btn", "LOG ›", `Open journal for ${dayLabel}`, () => {
      if (typeof NOTCH_JOURNAL === "undefined") return;
      NOTCH_JOURNAL.openDay(date);
      setActiveTab("journal");
    }));
    acts.appendChild(button("cal-add-btn", "+ EVENT", `Add an event on ${dayLabel}`, () => openSheet(null, date)));
    label.appendChild(acts);
    box.appendChild(label);

    const evs = eventsFor(data, date);
    const tasks = tmap[date] || [];
    if (!evs.length && !tasks.length) {
      box.appendChild(el("div", "cal-empty", data ? "Nothing logged." : (loading ? "Loading…" : "No calendar data yet.")));
      return box;
    }
    const now = Date.now();
    evs.forEach((e) => box.appendChild(eventRow(e, now)));
    tasks.forEach((t) => box.appendChild(taskRow(t, today)));
    return box;
  }

  function minuteLabel(minute) {
    const hour = String(Math.floor(minute / 60)).padStart(2, "0");
    return hour + ":" + String(minute % 60).padStart(2, "0");
  }

  function timedBlocks(events, date) {
    const midnight = Date.parse(date + "T00:00:00+07:00");
    const blocks = [];
    for (const event of events) {
      if (event.allDay) continue;
      const start = Math.max(0, (Date.parse(event.start) - midnight) / 60000);
      const end = Math.min(DAY_MINUTES, (Date.parse(event.end) - midnight) / 60000);
      if (end > start) blocks.push({ event, start, end });
    }
    blocks.sort((a, b) => a.start - b.start || b.end - a.end);

    // A cluster shares its maximum lane count. Adjacent events can reuse a lane.
    let cluster = [];
    let laneEnds = [];
    let clusterEnd = 0;
    function finishCluster() {
      for (const block of cluster) block.lanes = laneEnds.length;
      cluster = [];
      laneEnds = [];
    }
    for (const block of blocks) {
      if (block.start >= clusterEnd) finishCluster();
      block.lane = laneEnds.findIndex((end) => end <= block.start);
      if (block.lane === -1) block.lane = laneEnds.length;
      laneEnds[block.lane] = block.end;
      cluster.push(block);
      clusterEnd = Math.max(clusterEnd, block.end);
    }
    finishCluster();
    return blocks;
  }

  function buildTimeGrid(data, tmap, today) {
    const scroll = el("section", "cal-time-scroll cal-time-" + view);
    scroll.setAttribute("aria-label", VIEWS[view] + " calendar time grid, Jakarta time");
    scroll.tabIndex = 0;
    scroll.dataset.start = selected;
    scroll.style.setProperty("--cal-days", VIEW_DAYS[view]);
    const head = el("div", "cal-time-head");
    const dates = el("div", "cal-time-columns");
    const allDay = el("div", "cal-time-columns cal-all-day");
    const timeline = el("div", "cal-time-columns");
    dates.appendChild(el("div", "cal-time-axis cal-time-zone", "WIB"));
    allDay.appendChild(el("div", "cal-time-axis cal-all-day-label", "All day"));
    const hours = el("div", "cal-time-axis cal-time-hours");
    hours.setAttribute("aria-hidden", "true");
    for (let hour = 0; hour < 24; hour++) hours.appendChild(el("div", "cal-time-hour", minuteLabel(hour * 60)));
    timeline.appendChild(hours);

    for (let i = 0; i < VIEW_DAYS[view]; i++) {
      const date = addDays(selected, i);
      const day = parseISO(date);
      const label = day.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
      const dayHead = el("div", "cal-time-date");
      if (date === today) dayHead.classList.add("today");
      dayHead.appendChild(el("span", "cal-time-weekday", day.toLocaleDateString(undefined, { weekday: "short" })));
      dayHead.appendChild(el("span", "cal-time-date-number", String(day.getDate())));
      dayHead.appendChild(button("cal-time-add", "+", "Add an event on " + label, () => openSheet(null, date)));
      dates.appendChild(dayHead);

      const dayData = data || cached({ from: date, to: date })?.data;
      const allDayCell = el("div", "cal-all-day-cell");
      for (const event of eventsFor(dayData, date)) {
        if (event.allDay) allDayCell.appendChild(timeEventCard(event, label));
      }
      for (const task of tmap[date] || []) {
        const item = button("cal-time-task", "• " + task.title, "Edit task " + task.title, () => editCalendarTask(task));
        item.title = task.title;
        allDayCell.appendChild(item);
      }
      allDay.appendChild(allDayCell);

      const column = el("div", "cal-time-day");
      column.dataset.date = date;
      column.setAttribute("role", "group");
      column.setAttribute("aria-label", label);
      const timed = [...(dayData?.outlook?.events || []), ...(dayData?.google?.events || [])];
      for (const block of timedBlocks(timed, date)) {
        const card = timeEventCard(block.event, label);
        card.classList.add("cal-timed-event");
        card.style.top = block.start + "px";
        card.style.height = (block.end - block.start) + "px";
        card.style.left = (100 * block.lane / block.lanes) + "%";
        card.style.width = (100 / block.lanes) + "%";
        column.appendChild(card);
      }
      column.addEventListener("click", (e) => {
        if (e.target !== column) return;
        const y = e.clientY - column.getBoundingClientRect().top;
        const minute = Math.max(0, Math.min(DAY_MINUTES - 30, Math.floor(y / 30) * 30));
        openSheet(null, date, minuteLabel(minute));
      });
      timeline.appendChild(column);
    }
    head.append(dates, allDay);
    scroll.append(head, timeline);
    return scroll;
  }

  function timeEventCard(event, label) {
    const when = event.allDay ? "All day" :
      googleTime.format(new Date(event.start)) + "–" + googleTime.format(new Date(event.end));
    const card = eventAction(event, `${event.title}, ${label}, ${when}`);
    card.classList.add("cal-time-event");
    if (event.source === "outlook") card.classList.add("work");
    card.title = `${event.title} · ${when} · ${event.source === "outlook" ? "Work" : "Google"}`;
    card.appendChild(el("span", "cal-time-event-title", event.title));
    if (!event.allDay) card.appendChild(el("span", "cal-time-event-when", when));
    return card;
  }

  function eventRow(e, now) {
    const row = el("div", "row agenda-row cal-ev");
    if (!e.allDay && Date.parse(e.end) <= now) row.classList.add("past");
    if (!e.allDay && Date.parse(e.start) <= now && now < Date.parse(e.end)) row.classList.add("now");
    const time = el("div", "agenda-time", e.allDay ? "all day" : hhmm(e.start));
    if (!e.allDay) time.appendChild(el("span", null, hhmm(e.end)));
    row.appendChild(time);
    const body = eventAction(e);
    body.classList.add("row-body");
    const title = el("span", "row-title");
    title.appendChild(el("span", "cal-sig", "○"));
    title.appendChild(document.createTextNode(e.title));
    body.appendChild(title);
    row.appendChild(body);
    row.appendChild(el("div", "cal-src", e.source === "outlook" ? "work" : "google"));
    return row;
  }

  function eventAction(e, label = e.title) {
    const canEdit = e.source === "google" && e.id && e.editable;
    const googleLink = e.source === "google" &&
      /^https:\/\/(?:calendar\.google\.com\/|www\.google\.com\/calendar\/)/.test(e.htmlLink || "") ? e.htmlLink : "";
    const body = el(canEdit ? "button" : googleLink ? "a" : "div");
    if (canEdit) {
      body.type = "button";
      body.classList.add("cal-event-action");
      body.setAttribute("aria-label", `Edit ${label}`);
      body.addEventListener("click", () => openSheet(e));
    } else if (googleLink) {
      body.classList.add("cal-event-action");
      body.href = googleLink;
      body.setAttribute("aria-label", `Open ${label} in Google Calendar`);
    } else {
      body.style.cursor = "default";
    }
    return body;
  }

  function editCalendarTask(task) {
    setActiveTab("tasks");
    openEditSheet(task, null);
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
    body.addEventListener("click", () => editCalendarTask(t));
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
      gline.appendChild(el("span", null, "GOOGLE · connected"));
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
    // desktop only (CSS): the keyboard map
    box.appendChild(el("div", "cal-keys", "KEYS · ← → day · ↑ ↓ week · [ ] previous/next view · t today · e add event"));
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
  async function deleteEvent() {
    const e = editing;
    if (saving || !e || !confirm(`Delete "${e.title}" from Google Calendar?`)) return;
    setSaving(true);
    msg("Deleting…");
    try {
      await apiFetch(`/api/calendar/events/${encodeURIComponent(e.id)}`, { method: "DELETE" });
      updateEventCache(e.id, null);
      setSaving(false);
      closeSheet();
      showToast("Deleted");
      render();
      load(true);
      refreshAgenda();
    } catch (err) {
      setSaving(false);
      msg(err.detail || "Couldn't delete the event. Try again.", true);
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
        <input type="text" id="cal-ev-title" class="edit-title-input" aria-label="Event title" placeholder="Event title" maxlength="200" autocomplete="off">
        <label class="edit-field-label" for="cal-ev-date">Date</label>
        <input type="date" id="cal-ev-date" class="edit-select cal-input">
        <div class="edit-field-label">Time · WIB</div>
        <div class="capture-due cal-time-chips">
          <button type="button" class="due-chip" id="cal-ev-allday">All day</button>
          <button type="button" class="due-chip" id="cal-ev-timed">Timed</button>
        </div>
        <div class="cal-time-row" id="cal-ev-times">
          <input type="time" id="cal-ev-start" class="edit-select cal-input" aria-label="Start time">
          <span class="cal-time-sep">–</span>
          <input type="time" id="cal-ev-end" class="edit-select cal-input" aria-label="End time">
        </div>
        <div class="edit-sheet-msg" id="cal-ev-msg" role="status"></div>
        <div class="edit-sheet-actions">
          <button type="button" id="cal-ev-cancel" class="edit-btn edit-btn-cancel">Cancel</button>
          <button type="button" id="cal-ev-save" class="edit-btn edit-btn-save">Add to Google</button>
        </div>
        <button type="button" id="cal-ev-delete" class="cal-link-btn cal-event-delete" hidden>Delete event</button>
      </div>`;
    document.body.appendChild(backdrop);
    document.body.appendChild(sheet);
    document.getElementById("cal-ev-cancel").addEventListener("click", closeSheet);
    document.getElementById("cal-ev-save").addEventListener("click", saveEvent);
    document.getElementById("cal-ev-delete").addEventListener("click", deleteEvent);
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
    document.getElementById("cal-ev-allday").setAttribute("aria-pressed", String(!v));
    document.getElementById("cal-ev-timed").setAttribute("aria-pressed", String(v));
    document.getElementById("cal-ev-times").style.display = v ? "flex" : "none";
  }
  function plusHour(hm) {
    const [h, m] = hm.split(":").map(Number);
    return h >= 23 ? "23:59" : `${String(h + 1).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  function defaultStart(date) {
    if (date !== todayISO()) return "09:00";
    const h = Number(googleTime.format(new Date()).slice(0, 2)) + 1;
    return h > 22 ? "22:00" : `${String(h).padStart(2, "0")}:00`;
  }
  function msg(text, isError) {
    const m = document.getElementById("cal-ev-msg");
    m.textContent = text || "";
    m.classList.toggle("error", !!isError);
  }

  function setSaving(value) {
    saving = value;
    document.getElementById("cal-ev-save").disabled = value;
    document.getElementById("cal-ev-delete").disabled = value;
    document.getElementById("cal-ev-cancel").disabled = value;
  }

  function googleStatusNow(date) {
    const c = cached({ from: date, to: date });
    return c && c.data && c.data.google ? c.data.google.status : null;
  }

  function openSheet(event = null, date = event?.date || selected, slot = null) {
    if (saving || sheetOpen()) return;
    const st = googleStatusNow(date);
    if (st === "not_configured") { showToast("Google isn't set up on the Worker yet"); return; }
    if (st === "not_connected") {
      if (confirm("Events are added to your Google Calendar. Connect Google now?")) connectGoogle();
      return;
    }
    buildSheet();
    editing = event;
    document.getElementById("cal-ev-title").value = event ? event.title : "";
    document.getElementById("cal-ev-date").value = date;
    const hasTimes = event && !event.allDay;
    const start = hasTimes ? googleTime.format(new Date(event.start)) : slot || defaultStart(date);
    document.getElementById("cal-ev-start").value = start;
    document.getElementById("cal-ev-end").value = hasTimes ? googleTime.format(new Date(event.end)) : plusHour(start);
    setTimed(!event || !event.allDay);
    msg("");
    setSaving(false);
    document.getElementById("cal-ev-save").textContent = event ? "Save changes" : "Add to Google";
    document.getElementById("cal-ev-delete").hidden = !event;
    document.body.classList.add("sheet-open");
    document.getElementById("cal-backdrop").classList.add("show");
    const sheet = document.getElementById("cal-sheet");
    sheet.setAttribute("aria-label", event ? "Edit Google event" : "Add event");
    sheet.classList.add("show");
    sheet.focus(); // not the title — see openEditSheet() in app.js on iOS taps
  }
  function closeSheet() {
    if (saving || !sheetOpen()) return;
    editing = null;
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
    const event = editing;
    const changedTime = !event || date !== event.date || timed === event.allDay ||
      (timed && (start !== googleTime.format(new Date(event.start)) || end !== googleTime.format(new Date(event.end))));
    if (event && !changedTime && title === event.title) { closeSheet(); return; }
    const body = {};
    if (!event || title !== event.title) body.title = title;
    if (changedTime) {
      body.date = date;
      if (timed) Object.assign(body, { start, end });
    }
    if (event?.etag) body.etag = event.etag;
    setSaving(true);
    msg(event ? "Saving…" : "Adding…");
    try {
      const path = "/api/calendar/events" + (event ? "/" + encodeURIComponent(event.id) : "");
      const ev = await apiFetch(path, {
        method: event ? "PATCH" : "POST",
        body: JSON.stringify(body),
      });
      updateEventCache(event?.id || ev?.id, ev);
      setSaving(false);
      closeSheet();
      const savedDate = ev?.date || date;
      if (view === "month" || savedDate < selected || savedDate > visibleEnd()) {
        selected = savedDate;
        const d = parseISO(selected);
        viewYear = d.getFullYear(); viewMonth = d.getMonth();
      }
      render();
      load(true);
      refreshAgenda();
      showToast(event ? "Saved to Google Calendar" : "Added to Google Calendar");
    } catch (e) {
      setSaving(false);
      msg(e.detail || (event ? "Couldn't save changes. Try again." : "Couldn't add the event. Try again."), true);
      if (e.code === "event_changed" || e.code === "not_found" || e.code === "not_connected") load(true);
    }
  }

  // ---------- public ----------
  function init(container) {
    if (!root) {
      root = container;
      const t = new Date();
      viewYear = t.getFullYear();
      viewMonth = t.getMonth();
      try {
        const storedView = localStorage.getItem(VIEW_KEY);
        if (Object.hasOwn(VIEWS, storedView)) view = storedView;
      } catch {}
    }
    // 4.6.2 — re-entering the tab reuses the drawn month (a rebuild is a
    // visible e-ink refresh); load() rebuilds only if the data changed.
    // Tasks can change on the Tasks tab, so their marks are part of the check.
    const sig = todayISO() + "|" + JSON.stringify(tasksByDate());
    if (!root.firstChild || sig !== lastInitSig) render();
    lastInitSig = sig;
    load();
  }
  let lastInitSig = "";
  // Called on resume / after Google sign-in returns.
  function refresh(force) {
    if (!root) return;
    render();
    load(force);
  }
  // 4.5 — keyboard (app.js routes keys here only while CALENDAR is showing).
  function goToday() {
    selectDate(todayISO());
  }
  function moveDay(n) {
    selectDate(addDays(selected || todayISO(), n));
  }
  function sheetOpen() {
    const s = document.getElementById("cal-sheet");
    return !!(s && s.classList.contains("show"));
  }
  return {
    init, refresh, goToday, moveDay, sheetOpen,
    prev: () => shiftView(-1),
    next: () => shiftView(1),
    addEvent: () => openSheet(),
    closeSheet: () => closeSheet(),
  };
})();
