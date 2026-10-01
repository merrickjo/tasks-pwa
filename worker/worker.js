// Tasks API — Cloudflare Worker + D1
//
// v9 (1 Oct 2026): + /api/events calendar mirror (see bottom of file).
// v8 (28 Sep 2026): Notion retired. Tasks live in the D1 database bound as
// `DB` (schema: schema.sql). The HTTP contract is unchanged from the Notion
// era — same routes, same JSON shapes, same validation — so the PWA and the
// desktop view need no changes.
//
// Required secret:  APP_KEY — the PWA sends it on every call (x-app-key)
// Optional var:     ALLOWED_ORIGIN — your GitHub Pages origin

// BUG-01: Workers run on UTC; completion dates are Jakarta-local.
function jakartaISO(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(d);
}

// BUG-07: Worker-side validation — 400 { error, field } for bad input.
const AREA_NAMES = ["Church", "Blibli", "Fitness", "Family", "Personal"];
const PRIORITY_NAMES = ["P1 - Critical", "P2 - High", "P3 - Medium", "P4 - Low"];
const STATUS_NAMES = ["To do", "Done", "Canceled"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validationError(field, message) {
  const e = new Error(message);
  e.field = field;
  e.isValidation = true;
  return e;
}

function validateInput(input, { partial }) {
  if (!input || typeof input !== "object") {
    throw validationError("body", "request body must be a JSON object");
  }
  if (!partial || input.title !== undefined) {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title || title.length > 200) {
      throw validationError("title", "title must be a non-empty string of 200 characters or fewer");
    }
  }
  if (input.area !== undefined && input.area !== null && input.area !== "" && !AREA_NAMES.includes(input.area)) {
    throw validationError("area", "area must be one of: " + AREA_NAMES.join(", ") + ", or null to clear");
  }
  if (input.priority !== undefined && !PRIORITY_NAMES.includes(input.priority)) {
    throw validationError("priority", "priority must be one of: " + PRIORITY_NAMES.join(", "));
  }
  if (input.due !== undefined && input.due !== null && !DATE_RE.test(input.due)) {
    throw validationError("due", "due must be formatted YYYY-MM-DD, or null to clear");
  }
  if (input.status !== undefined && !STATUS_NAMES.includes(input.status)) {
    throw validationError("status", "status must be one of: " + STATUS_NAMES.join(", "));
  }
}

export function corsHeaders(env) {
  return {
    "access-control-allow-origin": env.ALLOWED_ORIGIN || "*",
    "access-control-allow-methods": "GET,POST,PATCH,PUT,OPTIONS",
    "access-control-allow-headers": "content-type,x-app-key",
  };
}

export function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(env) },
  });
}

// Row -> the exact shape the Notion-era worker returned.
function simplify(r) {
  let label = null;
  try { label = JSON.parse(r.labels || "[]")[0] || null; } catch { label = null; }
  return {
    id: r.id,
    title: r.title || "(untitled)",
    status: r.status || null,
    priority: r.priority || null,
    due: r.due || null,
    area: r.area || null,
    label,
    notes: r.notes || "",
    completedAt: r.completed_at || null,
  };
}

// Notion's ascending sort put empty dates last; keep that.
async function listOpenTasks(env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM tasks WHERE status NOT IN ('Done','Canceled')
     ORDER BY due IS NULL, substr(due,1,10), created_at`
  ).all();
  return results.map(simplify);
}

async function listCompletedTasks(env, days) {
  const since = jakartaISO(new Date(Date.now() - days * 86400000));
  const { results } = await env.DB.prepare(
    `SELECT * FROM tasks WHERE status = 'Done' AND completed_at >= ?1
     ORDER BY completed_at DESC, updated_at DESC`
  ).bind(since).all();
  return results.map(simplify);
}

async function getTask(env, id) {
  return env.DB.prepare(`SELECT * FROM tasks WHERE id = ?1`).bind(id).first();
}

async function createTask(env, input) {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO tasks (id, title, status, priority, due, area, notes, source, created_at, updated_at)
     VALUES (?1, ?2, 'To do', ?3, ?4, ?5, ?6, 'Manual', ?7, ?7)`
  ).bind(id, input.title, input.priority || "P3 - Medium", input.due || null,
         input.area || null, input.notes || "", now).run();
  return simplify(await getTask(env, id));
}

async function updateTask(env, id, input) {
  const sets = [];
  const vals = [];
  const set = (col, v) => { vals.push(v); sets.push(`${col} = ?${vals.length}`); };
  if (input.status) {
    set("status", input.status);
    set("completed_at", input.status === "Done" ? jakartaISO() : null); // BUG-01
  }
  if (input.title) set("title", input.title);
  if (input.due !== undefined) set("due", input.due || null);
  if (input.priority) set("priority", input.priority);
  if (input.area !== undefined) set("area", input.area || null);
  set("updated_at", new Date().toISOString());
  vals.push(id);
  const res = await env.DB.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?${vals.length}`)
    .bind(...vals).run();
  if (!res.meta.changes) return null;
  return simplify(await getTask(env, id));
}

// --- calendar mirror (v9, 1 Oct 2026) ---
// notch-cal on the Mac PUTs a window of days; the PWA GETs one day.
// Titles + times only — the exporter never sends anything else and the
// Worker would drop it anyway.
const MAX_EVENTS = 300;
const MAX_WINDOW_DAYS = 14;

function jakartaDateOf(iso) {
  if (DATE_RE.test(iso)) return iso; // all-day events are date-only already
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return jakartaISO(d);
}

function validateEventsPush(input) {
  if (!input || typeof input !== "object") throw validationError("body", "request body must be a JSON object");
  if (!DATE_RE.test(input.from || "")) throw validationError("from", "from must be YYYY-MM-DD");
  if (!DATE_RE.test(input.to || "")) throw validationError("to", "to must be YYYY-MM-DD");
  if (input.to < input.from) throw validationError("to", "to must not be before from");
  const span = (Date.parse(input.to) - Date.parse(input.from)) / 86400000;
  if (span > MAX_WINDOW_DAYS) throw validationError("to", `window must be ${MAX_WINDOW_DAYS} days or fewer`);
  if (!Array.isArray(input.events) || input.events.length > MAX_EVENTS) {
    throw validationError("events", `events must be an array of at most ${MAX_EVENTS}`);
  }
  return input.events.map((e, i) => {
    const title = typeof e.title === "string" ? e.title.trim().slice(0, 200) : "";
    const allDay = !!e.allDay;
    const start = typeof e.start === "string" ? e.start : "";
    const end = typeof e.end === "string" ? e.end : start;
    const date = jakartaDateOf(start);
    if (!date || (allDay ? !DATE_RE.test(start) : isNaN(Date.parse(start))) || isNaN(Date.parse(end))) {
      throw validationError(`events[${i}]`, "each event needs a valid start/end");
    }
    return { title: title || "(busy)", start, end, allDay, date };
  }).filter((e) => e.date >= input.from && e.date <= input.to);
}

async function replaceEvents(env, from, to, events) {
  const stmts = [env.DB.prepare(`DELETE FROM events WHERE date >= ?1 AND date <= ?2`).bind(from, to)];
  for (const e of events) {
    stmts.push(env.DB.prepare(
      `INSERT INTO events (date, start, end, all_day, title) VALUES (?1, ?2, ?3, ?4, ?5)`
    ).bind(e.date, e.start, e.end, e.allDay ? 1 : 0, e.title));
  }
  stmts.push(env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES ('events_synced_at', ?1)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(new Date().toISOString()));
  await env.DB.batch(stmts); // atomic: a failed push never leaves a half-empty day
}

async function listEvents(env, date) {
  const { results } = await env.DB.prepare(
    `SELECT start, end, all_day, title FROM events WHERE date = ?1 ORDER BY all_day DESC, start`
  ).bind(date).all();
  const meta = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'events_synced_at'`).first();
  return {
    date,
    syncedAt: meta ? meta.value : null,
    events: results.map((r) => ({ title: r.title, start: r.start, end: r.end, allDay: !!r.all_day })),
  };
}

async function readJson(request) {
  try { return await request.json(); } catch { return undefined; }
}

export async function handle(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(env) });
  }
  if (!env.APP_KEY || (request.headers.get("x-app-key") || "") !== env.APP_KEY) {
    return json({ error: "unauthorized" }, 401, env);
  }

  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);

  try {
    if (parts[0] === "api" && parts[1] === "tasks" && !parts[2] && request.method === "GET") {
      return json({ tasks: await listOpenTasks(env) }, 200, env);
    }
    if (parts[0] === "api" && parts[1] === "tasks" && parts[2] === "completed" && request.method === "GET") {
      const days = Math.min(Math.max(parseInt(url.searchParams.get("days") || "30", 10) || 30, 1), 365);
      return json({ tasks: await listCompletedTasks(env, days) }, 200, env);
    }
    if (parts[0] === "api" && parts[1] === "tasks" && !parts[2] && request.method === "POST") {
      const input = await readJson(request);
      if (input === undefined) return json({ error: "body must be valid JSON", field: "body" }, 400, env);
      try { validateInput(input, { partial: false }); }
      catch (e) { if (e.isValidation) return json({ error: e.message, field: e.field }, 400, env); throw e; }
      return json(await createTask(env, input), 201, env);
    }
    if (parts[0] === "api" && parts[1] === "tasks" && parts[2] && request.method === "PATCH") {
      if (!UUID_RE.test(parts[2])) return json({ error: "task id must be a UUID", field: "id" }, 400, env);
      const input = await readJson(request);
      if (input === undefined) return json({ error: "body must be valid JSON", field: "body" }, 400, env);
      try { validateInput(input, { partial: true }); }
      catch (e) { if (e.isValidation) return json({ error: e.message, field: e.field }, 400, env); throw e; }
      const task = await updateTask(env, parts[2], input);
      if (!task) return json({ error: "task not found", field: "id" }, 404, env);
      return json(task, 200, env);
    }
    if (parts[0] === "api" && parts[1] === "events" && !parts[2] && request.method === "GET") {
      const date = url.searchParams.get("date") || jakartaISO();
      if (!DATE_RE.test(date)) return json({ error: "date must be YYYY-MM-DD", field: "date" }, 400, env);
      return json(await listEvents(env, date), 200, env);
    }
    if (parts[0] === "api" && parts[1] === "events" && !parts[2] && request.method === "PUT") {
      const input = await readJson(request);
      if (input === undefined) return json({ error: "body must be valid JSON", field: "body" }, 400, env);
      let events;
      try { events = validateEventsPush(input); }
      catch (e) { if (e.isValidation) return json({ error: e.message, field: e.field }, 400, env); throw e; }
      await replaceEvents(env, input.from, input.to, events);
      return json({ ok: true, stored: events.length }, 200, env);
    }
    return json({ error: "not found" }, 404, env);
  } catch (e) {
    return json({ error: String(e) }, 500, env);
  }
}

export default { fetch: handle };
