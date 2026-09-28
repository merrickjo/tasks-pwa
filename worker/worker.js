// Tasks API — Cloudflare Worker + D1
//
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
    "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
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
    return json({ error: "not found" }, 404, env);
  } catch (e) {
    return json({ error: String(e) }, 500, env);
  }
}

export default { fetch: handle };
