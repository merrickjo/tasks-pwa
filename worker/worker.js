// Tasks API — Cloudflare Worker + D1
//
// v12.1: edit one-off Google Calendar events.
// v12 (3 Nov 2026): + projects. Tasks carry `projectId` (the project's
//   uuid, same id as the `id` property on the Obsidian project note).
//   /api/projects (list, create), /api/projects/:id (edit), and
//   /api/sync/projects (Mac mirror). Needs migrations/0012_projects.sql.
// v11.1 (1 Nov 2026): journal index ignores "_"-prefixed sections (4.7 links).
// v11 (30 Oct 2026): + journal — /api/journal (range index), /api/journal/:key
//   (page get/put, optimistic rev), /api/journal/:key/ink/:page (handwriting),
//   /api/concursus (durable CONCURSUS history), /api/sync/journal (Mac mirror).
// v10 (21 Oct 2026): + Google Calendar — /api/calendar (month range,
//   Outlook mirror + live Google), /api/calendar/events (add/delete in
//   Google), /api/google/* (connect/status/disconnect), and the OAuth
//   callback at /oauth/google/callback. /api/agenda now includes Google.
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
const SPACE_NAMES = ["work", "ministry", "study"];
const PROJECT_STATUS = ["Active", "Paused", "Done"];
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
  if (input.projectId !== undefined && input.projectId !== null && input.projectId !== "" && !UUID_RE.test(input.projectId)) {
    throw validationError("projectId", "projectId must be a project uuid, or null to clear");
  }
}

export function corsHeaders(env) {
  return {
    "access-control-allow-origin": env.ALLOWED_ORIGIN || "*",
    "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
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
    projectId: r.project_id || null,
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
    `INSERT INTO tasks (id, title, status, priority, due, area, notes, source, project_id, created_at, updated_at)
     VALUES (?1, ?2, 'To do', ?3, ?4, ?5, ?6, 'Manual', ?7, ?8, ?8)`
  ).bind(id, input.title, input.priority || "P3 - Medium", input.due || null,
         input.area || null, input.notes || "", input.projectId || null, now).run();
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
  if (input.projectId !== undefined) set("project_id", input.projectId || null);
  set("updated_at", new Date().toISOString());
  vals.push(id);
  const res = await env.DB.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?${vals.length}`)
    .bind(...vals).run();
  if (!res.meta.changes) return null;
  return simplify(await getTask(env, id));
}

// --- calendar mirror (v9, 1 Oct 2026) ---
// v9.1: served at /api/agenda too. Ad/tracker blockers (Brave Shields,
// EasyPrivacy lists) block any URL ending in /api/events as analytics, so
// the PWA got "Failed to fetch". /api/events stays as an alias for the
// Mac exporter, which runs under curl with no blocker.
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

// ── Obsidian sync (v5.0) ───────────────────────────────────────────────────
// The Obsidian vault (Notch/Tasks) is the source of truth; D1 is the phone
// cache. notch-tasks-sync on the Mac reconciles the two through these three
// routes. They take full rows (labels as an array) and keep the caller's
// updated_at, so the sync can do last-write-wins without guessing.
const SYNC_STATUS = ["To do", "Done", "Canceled"];
async function listAllForSync(env) {
  const { results } = await env.DB.prepare(`SELECT * FROM tasks ORDER BY created_at`).all();
  return results;
}
async function upsertForSync(env, id, t) {
  if (!t || typeof t !== "object") throw validationError("body", "request body must be a JSON object");
  const title = typeof t.title === "string" ? t.title.trim().slice(0, 200) : "";
  if (!title) throw validationError("title", "title is required");
  const status = SYNC_STATUS.includes(t.status) ? t.status : "To do";
  const priority = PRIORITY_NAMES.includes(t.priority) ? t.priority : null;
  const area = AREA_NAMES.includes(t.area) ? t.area : null;
  const due = typeof t.due === "string" && DATE_RE.test(t.due.slice(0, 10)) ? t.due : null;
  const done = typeof t.completed_at === "string" && DATE_RE.test(t.completed_at.slice(0, 10)) ? t.completed_at.slice(0, 10) : null;
  const labels = JSON.stringify(Array.isArray(t.labels) ? t.labels.filter((x) => typeof x === "string").slice(0, 20) : []);
  const now = new Date().toISOString();
  const created = typeof t.created_at === "string" && t.created_at ? t.created_at : now;
  const updated = typeof t.updated_at === "string" && t.updated_at ? t.updated_at : now;
  // v12: project_id rides along. A caller that predates v12 (no key at all)
  // leaves the stored link alone instead of wiping it.
  const hasProject = Object.prototype.hasOwnProperty.call(t, "project_id");
  const projectId = typeof t.project_id === "string" && UUID_RE.test(t.project_id) ? t.project_id : null;
  await env.DB.prepare(
    `INSERT INTO tasks (id, title, status, priority, due, area, labels, notes, completed_at, source, recurrence, created_at, updated_at, project_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, status = excluded.status, priority = excluded.priority,
       due = excluded.due, area = excluded.area, labels = excluded.labels, notes = excluded.notes,
       completed_at = excluded.completed_at, source = excluded.source, recurrence = excluded.recurrence,
       updated_at = excluded.updated_at` + (hasProject ? `, project_id = excluded.project_id` : ``)
  ).bind(id, title, status, priority, due, area, labels, typeof t.notes === "string" ? t.notes : "",
    done, typeof t.source === "string" ? t.source.slice(0, 60) : null,
    typeof t.recurrence === "string" ? t.recurrence : null, created, updated, projectId).run();
  return getTask(env, id);
}
async function deleteForSync(env, id) {
  const res = await env.DB.prepare(`DELETE FROM tasks WHERE id = ?1`).bind(id).run();
  return res.meta.changes;
}

// ── Projects (v12, 3 Nov 2026) ─────────────────────────────────────────────
// The Obsidian project notes (type: project) are the source of truth; this
// table is the phone's copy, kept in step by notch-tasks-sync. The phone may
// edit next step / dates / status / description and link tasks; the Mac sync
// carries those edits back by updated_at (last write wins).
function simplifyProject(r) {
  return {
    id: r.id, title: r.title, space: r.space || null, status: r.status || "Active",
    description: r.description || "", next: r.next || "", nextDue: r.next_due || null,
    due: r.due || null, updatedAt: r.updated_at,
  };
}
function cleanProject(input, { partial }) {
  if (!input || typeof input !== "object") throw validationError("body", "request body must be a JSON object");
  const out = {};
  if (!partial || input.title !== undefined) {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title || title.length > 200) throw validationError("title", "title must be a non-empty string of 200 characters or fewer");
    out.title = title;
  }
  if (input.space !== undefined) {
    if (input.space !== null && !SPACE_NAMES.includes(input.space)) throw validationError("space", "space must be one of: " + SPACE_NAMES.join(", "));
    out.space = input.space;
  }
  if (input.status !== undefined) {
    if (!PROJECT_STATUS.includes(input.status)) throw validationError("status", "status must be one of: " + PROJECT_STATUS.join(", "));
    out.status = input.status;
  }
  for (const [k, max] of [["description", 4000], ["next", 300]]) {
    if (input[k] !== undefined) {
      if (input[k] !== null && typeof input[k] !== "string") throw validationError(k, k + " must be a string");
      out[k] = (input[k] || "").slice(0, max);
    }
  }
  for (const [k, col] of [["nextDue", "next_due"], ["due", "due"]]) {
    if (input[k] !== undefined) {
      if (input[k] !== null && input[k] !== "" && !DATE_RE.test(input[k])) throw validationError(k, k + " must be YYYY-MM-DD, or null to clear");
      out[col] = input[k] || null;
    }
  }
  return out;
}
async function listProjects(env) {
  const { results } = await env.DB.prepare(
    `SELECT p.*, (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'To do') AS open_count
     FROM projects p WHERE p.status != 'Done' ORDER BY p.next_due IS NULL, p.next_due, p.title`
  ).all();
  return results.map((r) => ({ ...simplifyProject(r), openCount: r.open_count || 0 }));
}
async function getProject(env, id) {
  return env.DB.prepare(`SELECT * FROM projects WHERE id = ?1`).bind(id).first();
}
async function createProject(env, input) {
  const v = cleanProject(input, { partial: false });
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO projects (id, title, space, status, description, next, next_due, due, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
  ).bind(id, v.title, v.space || null, v.status || "Active", v.description || "", v.next || "",
    v.next_due || null, v.due || null, now).run();
  return simplifyProject(await getProject(env, id));
}
async function updateProject(env, id, input) {
  const v = cleanProject(input, { partial: true });
  const sets = [], vals = [];
  for (const [col, val] of Object.entries(v)) { vals.push(val); sets.push(`${col} = ?${vals.length}`); }
  vals.push(new Date().toISOString()); sets.push(`updated_at = ?${vals.length}`);
  vals.push(id);
  const res = await env.DB.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?${vals.length}`).bind(...vals).run();
  if (!res.meta.changes) return null;
  return simplifyProject(await getProject(env, id));
}
// Mac mirror: full rows, the caller's updated_at kept.
async function upsertProjectForSync(env, id, p) {
  const v = cleanProject(p, { partial: false });
  const updated = typeof p.updated_at === "string" && p.updated_at ? p.updated_at : new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO projects (id, title, space, status, description, next, next_due, due, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, space = excluded.space, status = excluded.status,
       description = excluded.description, next = excluded.next, next_due = excluded.next_due,
       due = excluded.due, updated_at = excluded.updated_at`
  ).bind(id, v.title, v.space || null, v.status || "Active", v.description || "", v.next || "",
    v.next_due || null, v.due || null, updated).run();
  return getProject(env, id);
}
async function deleteProjectForSync(env, id) {
  await env.DB.prepare(`UPDATE tasks SET project_id = NULL WHERE project_id = ?1`).bind(id).run();
  const res = await env.DB.prepare(`DELETE FROM projects WHERE id = ?1`).bind(id).run();
  return res.meta.changes;
}

// ── Journal (v11, 30 Oct 2026) ─────────────────────────────────────────────
// Bullet journal pages + handwriting + durable CONCURSUS history. See
// schema.sql for the row shapes. Writes are optimistic: the client sends the
// rev it started from; a stale rev gets 409 and the current row so the
// client can merge (ink: union of strokes by id; text: per section).
const JKEY_RE = /^(d:\d{4}-\d{2}-\d{2}|w:\d{4}-W\d{2}|m:\d{4}-\d{2})$/;
const SECTION_ID_RE = /^[a-z0-9_-]{1,32}$/;
const MAX_SECTIONS_BYTES = 200 * 1024;
const MAX_INK_BYTES = 1536 * 1024;
const MAX_INK_PAGES = 12;
const KIND_OF = { d: "day", w: "week", m: "month" };

function emptyEntry(key) {
  return { key, kind: KIND_OF[key[0]], sections: {}, mode: "type", rev: 0, updated_at: null, ink: [] };
}
function rowToEntry(r) {
  let sections = {};
  try { sections = JSON.parse(r.sections) || {}; } catch {}
  return { key: r.key, kind: r.kind, sections, mode: r.mode, rev: r.rev, updated_at: r.updated_at };
}
function rowToInk(r) {
  let strokes = [];
  try { strokes = JSON.parse(r.strokes) || []; } catch {}
  return { page: r.page, strokes, rev: r.rev, updated_at: r.updated_at };
}

function validateSections(input) {
  const sec = input && input.sections;
  if (!sec || typeof sec !== "object" || Array.isArray(sec)) throw validationError("sections", "sections must be an object");
  const keys = Object.keys(sec);
  if (keys.length > 60) throw validationError("sections", "too many sections");
  for (const k of keys) {
    if (!SECTION_ID_RE.test(k)) throw validationError("sections", "bad section id: " + k);
    if (typeof sec[k] !== "string") throw validationError("sections", "section " + k + " must be a string");
  }
  const raw = JSON.stringify(sec);
  if (raw.length > MAX_SECTIONS_BYTES) throw validationError("sections", "journal page text is over 200 KB");
  const mode = input.mode === "ink" ? "ink" : "type";
  const base = Number.isInteger(input.base_rev) ? input.base_rev : -1;
  return { raw, mode, base };
}
function validateInk(input) {
  const st = input && input.strokes;
  if (!Array.isArray(st)) throw validationError("strokes", "strokes must be an array");
  for (const s of st) {
    if (!s || typeof s.id !== "string" || s.id.length > 24 || !Array.isArray(s.p) || typeof s.w !== "number") {
      throw validationError("strokes", "each stroke needs id, w and p");
    }
  }
  const raw = JSON.stringify(st);
  if (raw.length > MAX_INK_BYTES) throw validationError("strokes", "ink page is over 1.5 MB — add a new page");
  const base = Number.isInteger(input.base_rev) ? input.base_rev : -1;
  return { raw, base };
}

async function getJournal(env, key) {
  const r = await env.DB.prepare(`SELECT * FROM journal WHERE key = ?1`).bind(key).first();
  const entry = r ? rowToEntry(r) : emptyEntry(key);
  const { results } = await env.DB.prepare(`SELECT * FROM journal_ink WHERE key = ?1 ORDER BY page`).bind(key).all();
  entry.ink = results.map(rowToInk);
  return entry;
}
async function putJournal(env, key, input) {
  const v = validateSections(input);
  const cur = await env.DB.prepare(`SELECT rev FROM journal WHERE key = ?1`).bind(key).first();
  const curRev = cur ? cur.rev : 0;
  if (v.base !== curRev) return { conflict: true, entry: await getJournal(env, key) };
  const now = new Date().toISOString();
  // Guarded write: the WHERE rev check makes a race between two devices
  // lose cleanly (0 changes → conflict) instead of silently overwriting.
  let res;
  if (!cur) {
    res = await env.DB.prepare(
      `INSERT OR IGNORE INTO journal (key, kind, sections, mode, rev, updated_at) VALUES (?1, ?2, ?3, ?4, 1, ?5)`
    ).bind(key, KIND_OF[key[0]], v.raw, v.mode, now).run();
  } else {
    res = await env.DB.prepare(
      `UPDATE journal SET sections = ?2, mode = ?3, rev = rev + 1, updated_at = ?4 WHERE key = ?1 AND rev = ?5`
    ).bind(key, v.raw, v.mode, now, curRev).run();
  }
  if (!res.meta.changes) return { conflict: true, entry: await getJournal(env, key) };
  return { entry: await getJournal(env, key) };
}
async function putInk(env, key, page, input) {
  const v = validateInk(input);
  const cur = await env.DB.prepare(`SELECT rev FROM journal_ink WHERE key = ?1 AND page = ?2`).bind(key, page).first();
  const curRev = cur ? cur.rev : 0;
  const pageNow = async () => {
    const r = await env.DB.prepare(`SELECT * FROM journal_ink WHERE key = ?1 AND page = ?2`).bind(key, page).first();
    return r ? rowToInk(r) : { page, strokes: [], rev: 0, updated_at: null };
  };
  if (v.base !== curRev) return { conflict: true, page: await pageNow() };
  const now = new Date().toISOString();
  let res;
  if (!cur) {
    res = await env.DB.prepare(
      `INSERT OR IGNORE INTO journal_ink (key, page, strokes, rev, updated_at) VALUES (?1, ?2, ?3, 1, ?4)`
    ).bind(key, page, v.raw, now).run();
  } else {
    res = await env.DB.prepare(
      `UPDATE journal_ink SET strokes = ?3, rev = rev + 1, updated_at = ?4 WHERE key = ?1 AND page = ?2 AND rev = ?5`
    ).bind(key, page, v.raw, now, curRev).run();
  }
  if (!res.meta.changes) return { conflict: true, page: await pageNow() };
  // The page row's own clock moves; touch the entry so "updated since"
  // sync (the Mac mirror) sees the page changed.
  await env.DB.prepare(
    `INSERT INTO journal (key, kind, sections, mode, rev, updated_at) VALUES (?1, ?2, '{}', 'ink', 0, ?3)
     ON CONFLICT(key) DO UPDATE SET updated_at = excluded.updated_at`
  ).bind(key, KIND_OF[key[0]], now).run();
  return { page: await pageNow() };
}
// Overview for a date range: which day pages have text / ink, so the
// monthly and weekly spreads can mark them without loading every page.
async function journalIndex(env, from, to) {
  const { results: rows } = await env.DB.prepare(
    `SELECT key, sections FROM journal WHERE key >= ?1 AND key <= ?2`
  ).bind("d:" + from, "d:" + to).all();
  const { results: inks } = await env.DB.prepare(
    `SELECT key, SUM(LENGTH(strokes) > 2) AS pages FROM journal_ink WHERE key >= ?1 AND key <= ?2 GROUP BY key`
  ).bind("d:" + from, "d:" + to).all();
  const out = {};
  for (const r of rows) {
    let sec = {};
    try { sec = JSON.parse(r.sections) || {}; } catch {}
    // v11.1: "_"-prefixed sections are app data (4.7's _links), not writing.
    const text = Object.entries(sec).filter(([k]) => !k.startsWith("_")).map(([, v]) => v).join("\n");
    const first = text.split("\n").map((l) => l.trim()).find((l) => l) || "";
    out[r.key.slice(2)] = { text: !!text.trim(), first: first.slice(0, 120), ink: 0 };
  }
  for (const i of inks) {
    const d = i.key.slice(2);
    out[d] = out[d] || { text: false, first: "", ink: 0 };
    out[d].ink = i.pages || 0;
  }
  return out;
}

const CC_DOMAINS_RE = /^[a-z]{1,16}$/;
function validateConcursus(input) {
  const days = input && input.days;
  if (!days || typeof days !== "object" || Array.isArray(days)) throw validationError("days", "days must be an object");
  const out = [];
  for (const [date, s] of Object.entries(days).slice(0, 400)) {
    if (!DATE_RE.test(date) || !s || typeof s !== "object") continue;
    if (!(Number.isInteger(s.roll) && s.roll >= 1 && s.roll <= 20)) continue;
    if (!s.done || typeof s.done !== "object") continue;
    const done = {};
    for (const [k, v] of Object.entries(s.done)) if (CC_DOMAINS_RE.test(k) && typeof v === "boolean") done[k] = v;
    const at = typeof s.at === "string" && s.at ? s.at.slice(0, 40) : new Date().toISOString();
    const fp = ["T", "B", "E"].includes(s.familyPerson) ? s.familyPerson : null;
    out.push([date, s.roll, JSON.stringify(done), fp, s.notch ? 1 : 0, at]);
  }
  return out;
}
async function upsertConcursus(env, rows) {
  if (!rows.length) return 0;
  await env.DB.batch(rows.map((r) => env.DB.prepare(
    `INSERT INTO concursus_days (date, roll, done, family_person, notch, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(date) DO UPDATE SET roll = excluded.roll, done = excluded.done,
       family_person = excluded.family_person, notch = excluded.notch, at = excluded.at
     WHERE excluded.at > concursus_days.at`
  ).bind(...r)));
  return rows.length;
}
async function listConcursus(env, from, to) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM concursus_days WHERE date >= ?1 AND date <= ?2 ORDER BY date`
  ).bind(from, to).all();
  const out = {};
  for (const r of results) {
    let done = {};
    try { done = JSON.parse(r.done) || {}; } catch {}
    out[r.date] = { roll: r.roll, done, familyPerson: r.family_person, notch: !!r.notch, at: r.at };
  }
  return out;
}
// The Mac mirror's feed: every page touched since `since`, ink included.
async function journalSince(env, since) {
  const { results } = await env.DB.prepare(
    `SELECT key FROM journal WHERE updated_at > ?1 ORDER BY updated_at LIMIT 200`
  ).bind(since).all();
  const entries = [];
  for (const r of results) entries.push(await getJournal(env, r.key));
  return entries;
}
function plainRange(url) {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!DATE_RE.test(from || "") || !DATE_RE.test(to || "") || from > to) {
    throw validationError("from", "from and to must be YYYY-MM-DD with from <= to");
  }
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > 400) throw validationError("to", "range is limited to 400 days");
  return { from, to };
}

// ── Google Calendar (v10, 21 Oct 2026) ─────────────────────────────────────
// Merrick's own Google calendar (primary only), read live — never mirrored
// into the events table, so the Outlook push's window-replace can't touch it.
// The Worker holds the OAuth refresh token (D1 meta), exactly as it holds
// every other Notch credential; the PWA only ever sees event titles + times.
//
// Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (wrangler secret put …)
// Var:     APP_URL — where the OAuth callback sends the browser back to.
const G_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const G_TOKEN_URL = "https://oauth2.googleapis.com/token";
const G_API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const G_TIMEOUT_MS = 6000;
const TZ = "Asia/Jakarta";
const MAX_RANGE_DAYS = 62;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

async function getMeta(env, key) {
  const r = await env.DB.prepare(`SELECT value FROM meta WHERE key = ?1`).bind(key).first();
  return r ? r.value : null;
}
function setMetaStmt(env, key, value) {
  return env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(key, value);
}
async function setMeta(env, key, value) { await setMetaStmt(env, key, value).run(); }
async function delMeta(env, ...keys) {
  await env.DB.batch(keys.map((k) => env.DB.prepare(`DELETE FROM meta WHERE key = ?1`).bind(k)));
}

function googleConfigured(env) { return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET); }
function googleRedirect(url) { return `${url.origin}/oauth/google/callback`; }

function gError(code, message) {
  const e = new Error(message || code);
  e.gcode = code;
  return e;
}

async function gFetch(input, init = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), G_TIMEOUT_MS);
  try { return await fetch(input, { ...init, signal: ctl.signal }); }
  catch (e) { throw gError("google_unreachable", "Google didn't answer in time"); }
  finally { clearTimeout(t); }
}

async function googleStatus(env) {
  if (!googleConfigured(env)) return "not_configured";
  return (await getMeta(env, "google_refresh_token")) ? "connected" : "not_connected";
}

// Single-use state, 10-minute life. The callback is the one route that can't
// carry x-app-key (Google's redirect is a plain browser navigation), so this
// state is what proves the round trip started from Notch.
async function googleConnectUrl(env, url) {
  if (!googleConfigured(env)) throw gError("not_configured", "Google isn't set up on the Worker yet");
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const state = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  await setMeta(env, "google_oauth_state", `${state}|${Date.now() + 10 * 60 * 1000}`);
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: googleRedirect(url),
    response_type: "code",
    scope: G_SCOPE,
    access_type: "offline",
    prompt: "consent",            // always returns a refresh token
    include_granted_scopes: "true",
    state,
  });
  return "https://accounts.google.com/o/oauth2/v2/auth?" + q.toString();
}

function appUrl(env) {
  return env.APP_URL || ((env.ALLOWED_ORIGIN || "https://merrickjo.github.io") + "/tasks-pwa/");
}
function backToApp(env, result) {
  // A hash, not a query string: the service worker serves "./" cache-first,
  // and a ?query would miss that cache entry.
  return Response.redirect(appUrl(env) + "#google=" + encodeURIComponent(result), 302);
}

async function googleCallback(env, url) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") || "";
  const saved = (await getMeta(env, "google_oauth_state")) || "";
  await delMeta(env, "google_oauth_state"); // single use, pass or fail
  const [savedState, exp] = saved.split("|");
  if (!savedState || state !== savedState || Date.now() > Number(exp)) return backToApp(env, "expired");
  if (url.searchParams.get("error") || !code) return backToApp(env, "denied");

  const res = await gFetch(G_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: googleRedirect(url),
      grant_type: "authorization_code",
    }),
  });
  const tok = await res.json().catch(() => ({}));
  if (!res.ok || !tok.refresh_token) return backToApp(env, "failed");
  await env.DB.batch([
    setMetaStmt(env, "google_refresh_token", tok.refresh_token),
    setMetaStmt(env, "google_access_token", `${tok.access_token}|${Date.now() + (tok.expires_in || 3600) * 1000}`),
  ]);
  return backToApp(env, "connected");
}

async function googleAccessToken(env) {
  const cached = (await getMeta(env, "google_access_token")) || "";
  const [tokenVal, exp] = cached.split("|");
  if (tokenVal && Date.now() < Number(exp) - 60000) return tokenVal;
  const refresh = await getMeta(env, "google_refresh_token");
  if (!refresh) throw gError("not_connected", "Google isn't connected");
  const res = await gFetch(G_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refresh,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: "refresh_token",
    }),
  });
  const tok = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (tok.error === "invalid_grant") {
      // Revoked or expired — forget it so the app offers Connect again
      // instead of failing on every load.
      await delMeta(env, "google_refresh_token", "google_access_token");
      throw gError("not_connected", "Google access was revoked — connect again");
    }
    throw gError("google_error", `Google token refresh failed (${res.status})`);
  }
  await setMeta(env, "google_access_token", `${tok.access_token}|${Date.now() + (tok.expires_in || 3600) * 1000}`);
  return tok.access_token;
}

async function googleApi(env, path, init = {}) {
  const token = await googleAccessToken(env);
  const res = await gFetch(G_API + path, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers || {}) },
  });
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (body.error && body.error.message) || `HTTP ${res.status}`;
    if (res.status === 412) throw gError("event_changed", "This event changed in Google Calendar. Reopen it and try again.");
    throw gError(res.status === 404 || res.status === 410 ? "not_found" : "google_error", `Google: ${msg}`);
  }
  return body;
}

function addDaysISO(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function editableGoogleEvent(g) {
  if (!g.organizer?.self || g.locked || g.recurringEventId || g.recurrence?.length ||
      g.attendees?.some((attendee) => !attendee.self) || (g.eventType && g.eventType !== "default")) return false;
  if (g.start?.date) return g.end?.date === addDaysISO(g.start.date, 1);
  const start = g.start?.dateTime;
  const end = g.end?.dateTime;
  return !!(start && end && jakartaDateOf(start) === jakartaDateOf(end));
}

// Google event -> one row per day it touches (all-day spans are expanded so a
// three-day trip marks three cells; timed events sit on their start day).
// Titles + times only. Declined invitations and working-location markers
// are dropped — they aren't things on the day.
function mapGoogleEvent(g, from, to) {
  if (!g || g.status === "cancelled" || g.eventType === "workingLocation") return [];
  const me = (g.attendees || []).find((a) => a.self);
  if (me && me.responseStatus === "declined") return [];
  const allDay = !!(g.start && g.start.date);
  const start = allDay ? g.start.date : g.start && g.start.dateTime;
  const end = allDay ? g.end.date : (g.end && g.end.dateTime) || start;
  if (!start) return [];
  const base = {
    id: g.id, title: (g.summary || "").trim().slice(0, 200) || "(no title)",
    start, end, allDay, source: "google", editable: editableGoogleEvent(g),
    etag: g.etag, htmlLink: g.htmlLink,
  };
  if (!allDay) {
    const date = jakartaDateOf(start);
    return date >= from && date <= to ? [{ ...base, date }] : [];
  }
  const out = [];
  for (let d = start, i = 0; d < end && i < 62; d = addDaysISO(d, 1), i++) {
    if (d >= from && d <= to) out.push({ ...base, date: d });
  }
  return out;
}

async function googleEventsInRange(env, from, to) {
  const q = new URLSearchParams({
    timeMin: `${from}T00:00:00+07:00`,
    timeMax: `${addDaysISO(to, 1)}T00:00:00+07:00`,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "500",
    timeZone: TZ,
    fields: "items(id,status,summary,start,end,eventType,attendees(self,responseStatus),organizer(self),locked,recurringEventId,recurrence,etag,htmlLink)",
  });
  const body = await googleApi(env, "?" + q.toString());
  return (body.items || []).flatMap((g) => mapGoogleEvent(g, from, to));
}

// Never throws: the calendar degrades to Outlook-only with a reason.
async function googleBlock(env, from, to) {
  const status = await googleStatus(env);
  if (status !== "connected") return { status, events: [] };
  try {
    return { status, events: await googleEventsInRange(env, from, to) };
  } catch (e) {
    const s = e.gcode === "not_connected" ? "not_connected" : "error";
    return { status: s, error: e.message, events: [] };
  }
}

async function outlookInRange(env, from, to) {
  const { results } = await env.DB.prepare(
    `SELECT date, start, end, all_day, title FROM events WHERE date >= ?1 AND date <= ?2 ORDER BY date, all_day DESC, start`
  ).bind(from, to).all();
  const syncedAt = await getMeta(env, "events_synced_at");
  return {
    syncedAt,
    events: results.map((r) => ({ date: r.date, title: r.title, start: r.start, end: r.end, allDay: !!r.all_day, source: "outlook" })),
  };
}

function validateRange(url) {
  const from = url.searchParams.get("from") || "";
  const to = url.searchParams.get("to") || "";
  if (!DATE_RE.test(from)) throw validationError("from", "from must be YYYY-MM-DD");
  if (!DATE_RE.test(to)) throw validationError("to", "to must be YYYY-MM-DD");
  if (to < from) throw validationError("to", "to must not be before from");
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > MAX_RANGE_DAYS) {
    throw validationError("to", `range must be ${MAX_RANGE_DAYS} days or fewer`);
  }
  return { from, to };
}

async function calendarRange(env, from, to) {
  const [outlook, google] = await Promise.all([outlookInRange(env, from, to), googleBlock(env, from, to)]);
  return { from, to, outlook, google };
}

function validateEventTitle(value) {
  const title = typeof value === "string" ? value.trim() : "";
  if (!title || title.length > 200) throw validationError("title", "title must be 1–200 characters");
  return title;
}

function validateNewEvent(input) {
  if (!input || typeof input !== "object") throw validationError("body", "request body must be a JSON object");
  return { title: validateEventTitle(input.title), ...validateEventSchedule(input) };
}

function validateEventSchedule(input) {
  const date = Date.parse(`${input.date}T00:00:00Z`);
  if (!DATE_RE.test(input.date || "") || !Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== input.date) {
    throw validationError("date", "date must be a valid YYYY-MM-DD");
  }
  const timed = input.start !== undefined && input.start !== null && input.start !== "";
  if (!timed) return { date: input.date, allDay: true };
  if (!TIME_RE.test(input.start)) throw validationError("start", "start must be HH:MM");
  if (!TIME_RE.test(input.end || "")) throw validationError("end", "end must be HH:MM");
  if (input.end <= input.start) throw validationError("end", "end must be after start");
  return { date: input.date, allDay: false, start: input.start, end: input.end };
}

function googleEventTimes(ev) {
  return ev.allDay
    ? { start: { date: ev.date }, end: { date: addDaysISO(ev.date, 1) } }
    : {
        start: { dateTime: `${ev.date}T${ev.start}:00`, timeZone: TZ },
        end: { dateTime: `${ev.date}T${ev.end}:00`, timeZone: TZ },
      };
}

async function createGoogleEvent(env, ev) {
  const body = { summary: ev.title, ...googleEventTimes(ev) };
  const g = await googleApi(env, "", { method: "POST", body: JSON.stringify(body) });
  return mapGoogleEvent(g, ev.date, ev.date)[0] || null;
}

async function updateGoogleEvent(env, id, input) {
  if (!input || typeof input !== "object") throw validationError("body", "request body must be a JSON object");
  const body = {};
  if (input.title !== undefined) body.summary = validateEventTitle(input.title);
  if (input.date !== undefined) Object.assign(body, googleEventTimes(validateEventSchedule(input)));
  if (!Object.keys(body).length) throw validationError("body", "Provide an event title or schedule");
  const path = "/" + encodeURIComponent(id);
  const existing = await googleApi(env, path);
  if (!editableGoogleEvent(existing)) throw gError("use_google", "Edit this event in Google Calendar");
  if (input.etag && input.etag !== existing.etag) throw gError("event_changed", "This event changed in Google Calendar. Reopen it and try again.");
  const g = await googleApi(env, path, {
    method: "PATCH", body: JSON.stringify(body),
    headers: existing.etag ? { "if-match": existing.etag } : {},
  });
  const date = g.start.date || jakartaDateOf(g.start.dateTime);
  return mapGoogleEvent(g, date, date)[0] || null;
}

// The Tasks tab's AGENDA · TODAY: Outlook mirror + Google, one list.
async function agendaForDay(env, date) {
  const base = await listEvents(env, date);
  const outlook = base.events.map((e) => ({ ...e, source: "outlook" }));
  const g = await googleBlock(env, date, date);
  const events = [...outlook, ...g.events.map(({ date: _d, ...e }) => e)].sort((a, b) =>
    a.allDay !== b.allDay ? (a.allDay ? -1 : 1) : Date.parse(a.start) - Date.parse(b.start));
  return { ...base, events, google: g.status, googleError: g.error || null };
}

function gErrorResponse(e, env) {
  if (e.gcode === "not_configured" || e.gcode === "not_connected") return json({ error: e.message, code: e.gcode }, 409, env);
  if (e.gcode === "use_google" || e.gcode === "event_changed") return json({ error: e.message, code: e.gcode }, 409, env);
  if (e.gcode === "not_found") return json({ error: "This event is no longer on your Google Calendar.", code: e.gcode }, 404, env);
  if (e.gcode) return json({ error: e.message, code: e.gcode }, 502, env);
  return null;
}

export async function handle(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(env) });
  }

  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);

  // The one unauthenticated route: Google's redirect back after consent.
  // It is guarded by the single-use state minted in /api/google/connect.
  if (parts[0] === "oauth" && parts[1] === "google" && parts[2] === "callback" && request.method === "GET") {
    if (!googleConfigured(env)) return backToApp(env, "not_configured");
    try { return await googleCallback(env, url); }
    catch (e) { return backToApp(env, "failed"); }
  }

  if (!env.APP_KEY || (request.headers.get("x-app-key") || "") !== env.APP_KEY) {
    return json({ error: "unauthorized" }, 401, env);
  }

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
    if (parts[0] === "api" && (parts[1] === "agenda" || parts[1] === "events") && !parts[2] && request.method === "GET") {
      const date = url.searchParams.get("date") || jakartaISO();
      if (!DATE_RE.test(date)) return json({ error: "date must be YYYY-MM-DD", field: "date" }, 400, env);
      return json(await agendaForDay(env, date), 200, env);
    }
    if (parts[0] === "api" && parts[1] === "calendar" && !parts[2] && request.method === "GET") {
      let range;
      try { range = validateRange(url); }
      catch (e) { if (e.isValidation) return json({ error: e.message, field: e.field }, 400, env); throw e; }
      return json(await calendarRange(env, range.from, range.to), 200, env);
    }
    if (parts[0] === "api" && parts[1] === "calendar" && parts[2] === "events" && !parts[3] && request.method === "POST") {
      const input = await readJson(request);
      if (input === undefined) return json({ error: "body must be valid JSON", field: "body" }, 400, env);
      let ev;
      try { ev = validateNewEvent(input); }
      catch (e) { if (e.isValidation) return json({ error: e.message, field: e.field }, 400, env); throw e; }
      try { return json(await createGoogleEvent(env, ev), 201, env); }
      catch (e) { const r = gErrorResponse(e, env); if (r) return r; throw e; }
    }
    if (parts[0] === "api" && parts[1] === "calendar" && parts[2] === "events" && parts[3] && !parts[4] && request.method === "PATCH") {
      if (!/^[A-Za-z0-9_-]{1,1024}$/.test(parts[3])) return json({ error: "bad event id", field: "id" }, 400, env);
      const input = await readJson(request);
      try { return json(await updateGoogleEvent(env, parts[3], input), 200, env); }
      catch (e) {
        if (e.isValidation) return json({ error: e.message, field: e.field }, 400, env);
        const r = gErrorResponse(e, env); if (r) return r; throw e;
      }
    }
    if (parts[0] === "api" && parts[1] === "calendar" && parts[2] === "events" && parts[3] && !parts[4] && request.method === "DELETE") {
      if (!/^[A-Za-z0-9_-]{1,1024}$/.test(parts[3])) return json({ error: "bad event id", field: "id" }, 400, env);
      try { await googleApi(env, "/" + encodeURIComponent(parts[3]), { method: "DELETE" }); return json({ ok: true }, 200, env); }
      catch (e) { const r = gErrorResponse(e, env); if (r) return r; throw e; }
    }
    if (parts[0] === "api" && parts[1] === "google" && parts[2] === "status" && request.method === "GET") {
      return json({ status: await googleStatus(env) }, 200, env);
    }
    if (parts[0] === "api" && parts[1] === "google" && parts[2] === "connect" && request.method === "POST") {
      try { return json({ url: await googleConnectUrl(env, url) }, 200, env); }
      catch (e) { const r = gErrorResponse(e, env); if (r) return r; throw e; }
    }
    if (parts[0] === "api" && parts[1] === "google" && parts[2] === "disconnect" && request.method === "POST") {
      const refresh = await getMeta(env, "google_refresh_token");
      if (refresh) {
        try {
          await gFetch("https://oauth2.googleapis.com/revoke", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token: refresh }),
          });
        } catch { /* forget locally even if Google is unreachable */ }
      }
      await delMeta(env, "google_refresh_token", "google_access_token", "google_oauth_state");
      return json({ ok: true, status: await googleStatus(env) }, 200, env);
    }
    if (parts[0] === "api" && (parts[1] === "agenda" || parts[1] === "events") && !parts[2] && request.method === "PUT") {
      const input = await readJson(request);
      if (input === undefined) return json({ error: "body must be valid JSON", field: "body" }, 400, env);
      let events;
      try { events = validateEventsPush(input); }
      catch (e) { if (e.isValidation) return json({ error: e.message, field: e.field }, 400, env); throw e; }
      await replaceEvents(env, input.from, input.to, events);
      return json({ ok: true, stored: events.length }, 200, env);
    }
    // ── v12 projects ──
    if (parts[0] === "api" && parts[1] === "projects" && !parts[2] && request.method === "GET") {
      return json({ projects: await listProjects(env) }, 200, env);
    }
    if (parts[0] === "api" && parts[1] === "projects" && !parts[2] && request.method === "POST") {
      const input = await readJson(request);
      if (input === undefined) return json({ error: "body must be valid JSON", field: "body" }, 400, env);
      try { return json(await createProject(env, input), 201, env); }
      catch (e) { if (e.isValidation) return json({ error: e.message, field: e.field }, 400, env); throw e; }
    }
    if (parts[0] === "api" && parts[1] === "projects" && parts[2] && !parts[3] && request.method === "PATCH") {
      if (!UUID_RE.test(parts[2])) return json({ error: "project id must be a UUID", field: "id" }, 400, env);
      const input = await readJson(request);
      if (input === undefined) return json({ error: "body must be valid JSON", field: "body" }, 400, env);
      try {
        const p = await updateProject(env, parts[2], input);
        return p ? json(p, 200, env) : json({ error: "not found" }, 404, env);
      } catch (e) { if (e.isValidation) return json({ error: e.message, field: e.field }, 400, env); throw e; }
    }
    if (parts[0] === "api" && parts[1] === "sync" && parts[2] === "projects" && !parts[3] && request.method === "GET") {
      const { results } = await env.DB.prepare(`SELECT * FROM projects ORDER BY title`).all();
      return json({ projects: results }, 200, env);
    }
    if (parts[0] === "api" && parts[1] === "sync" && parts[2] === "projects" && parts[3] && (request.method === "PUT" || request.method === "DELETE")) {
      if (!UUID_RE.test(parts[3])) return json({ error: "project id must be a UUID", field: "id" }, 400, env);
      if (request.method === "DELETE") return json({ ok: true, deleted: await deleteProjectForSync(env, parts[3]) }, 200, env);
      const input = await readJson(request);
      if (input === undefined) return json({ error: "body must be valid JSON", field: "body" }, 400, env);
      try { return json(await upsertProjectForSync(env, parts[3], input), 200, env); }
      catch (e) { if (e.isValidation) return json({ error: e.message, field: e.field }, 400, env); throw e; }
    }
    if (parts[0] === "api" && parts[1] === "sync" && parts[2] === "tasks" && !parts[3] && request.method === "GET") {
      return json({ tasks: await listAllForSync(env) }, 200, env);
    }
    if (parts[0] === "api" && parts[1] === "sync" && parts[2] === "tasks" && parts[3] && (request.method === "PUT" || request.method === "DELETE")) {
      if (!UUID_RE.test(parts[3])) return json({ error: "task id must be a UUID", field: "id" }, 400, env);
      if (request.method === "DELETE") return json({ ok: true, deleted: await deleteForSync(env, parts[3]) }, 200, env);
      const input = await readJson(request);
      if (input === undefined) return json({ error: "body must be valid JSON", field: "body" }, 400, env);
      try {
        return json(await upsertForSync(env, parts[3], input), 200, env);
      } catch (e) {
        if (e.isValidation) return json({ error: e.message, field: e.field }, 400, env);
        throw e;
      }
    }
    // ── v11 journal ──
    if (parts[0] === "api" && parts[1] === "journal" && !parts[2] && request.method === "GET") {
      let range;
      try { range = plainRange(url); }
      catch (e) { if (e.isValidation) return json({ error: e.message, field: e.field }, 400, env); throw e; }
      return json({ days: await journalIndex(env, range.from, range.to) }, 200, env);
    }
    if (parts[0] === "api" && parts[1] === "journal" && parts[2]) {
      const key = decodeURIComponent(parts[2]);
      if (!JKEY_RE.test(key)) return json({ error: "bad journal key", field: "key" }, 400, env);
      if (!parts[3] && request.method === "GET") return json(await getJournal(env, key), 200, env);
      if (!parts[3] && request.method === "PUT") {
        const input = await readJson(request);
        if (input === undefined) return json({ error: "body must be valid JSON", field: "body" }, 400, env);
        try {
          const r = await putJournal(env, key, input);
          return json(r.entry, r.conflict ? 409 : 200, env);
        } catch (e) { if (e.isValidation) return json({ error: e.message, field: e.field }, 400, env); throw e; }
      }
      if (parts[3] === "ink" && parts[4] !== undefined && !parts[5] && request.method === "PUT") {
        const page = parseInt(parts[4], 10);
        if (!(page >= 0 && page < MAX_INK_PAGES) || String(page) !== parts[4]) return json({ error: "bad page", field: "page" }, 400, env);
        const input = await readJson(request);
        if (input === undefined) return json({ error: "body must be valid JSON", field: "body" }, 400, env);
        try {
          const r = await putInk(env, key, page, input);
          return json(r.page, r.conflict ? 409 : 200, env);
        } catch (e) { if (e.isValidation) return json({ error: e.message, field: e.field }, 400, env); throw e; }
      }
    }
    if (parts[0] === "api" && parts[1] === "concursus" && !parts[2] && request.method === "GET") {
      let range;
      try { range = plainRange(url); }
      catch (e) { if (e.isValidation) return json({ error: e.message, field: e.field }, 400, env); throw e; }
      return json({ days: await listConcursus(env, range.from, range.to) }, 200, env);
    }
    if (parts[0] === "api" && parts[1] === "concursus" && !parts[2] && request.method === "PUT") {
      const input = await readJson(request);
      if (input === undefined) return json({ error: "body must be valid JSON", field: "body" }, 400, env);
      try { return json({ ok: true, stored: await upsertConcursus(env, validateConcursus(input)) }, 200, env); }
      catch (e) { if (e.isValidation) return json({ error: e.message, field: e.field }, 400, env); throw e; }
    }
    if (parts[0] === "api" && parts[1] === "sync" && parts[2] === "journal" && !parts[3] && request.method === "GET") {
      const since = url.searchParams.get("since") || "";
      return json({ entries: await journalSince(env, since) }, 200, env);
    }
    return json({ error: "not found" }, 404, env);
  } catch (e) {
    return json({ error: String(e) }, 500, env);
  }
}

export default { fetch: handle };
