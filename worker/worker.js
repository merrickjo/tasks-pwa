// Tasks proxy — Cloudflare Worker
//
// Sits between the PWA and Notion because Notion's API has no browser CORS
// support: the PWA can never call api.notion.com directly. This is the
// only place your Notion token lives.
//
// Required secrets (set via `wrangler secret put <name>` or the dashboard):
//   NOTION_TOKEN     — your Notion internal integration token
//   APP_KEY          — a password you invent; the PWA sends it on every call
// Optional vars (in wrangler.toml or dashboard, plain text is fine):
//   DATA_SOURCE_ID   — defaults to your ✅ Tasks data source
//   ALLOWED_ORIGIN   — your GitHub Pages origin, e.g. https://you.github.io
//                      (defaults to "*" — lock this down after you deploy)

const DEFAULT_DATA_SOURCE_ID = "38a78f87-f38b-43b7-9494-eda5cf171f68";
const NOTION_VERSION = "2025-09-03";

// BUG-01: Workers run on UTC. new Date().toISOString() gives the UTC date,
// which in Asia/Jakarta (UTC+7) is *yesterday* between 00:00 and 07:00
// local. Same bug class v3 fixed app-side (see app.js localISO()). Used for
// both the Completed-at stamp in updateTask() and the `since` boundary in
// listCompletedTasks() — both had the same UTC math.
function jakartaISO(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(d);
}

// BUG-07: Worker-side input validation. Invalid payloads used to pass
// straight to Notion and surface as generic 500s. Reject early with a
// 400 { error, field } instead; 500 stays reserved for Notion/runtime
// failures. Vocabularies below are grounded in what the app and the rest
// of this file actually send/use — not guessed.
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

// partial: true for PATCH (all fields optional, but must be valid if present).
// partial: false for POST (title is required).
// area/due accept explicit null on PATCH — that's how the app clears them
// (see updateTask()); only a non-null, non-empty value has to match the enum.
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

function corsHeaders(env) {
  return {
    "access-control-allow-origin": env.ALLOWED_ORIGIN || "*",
    "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
    "access-control-allow-headers": "content-type,x-app-key",
  };
}

function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(env) },
  });
}

async function notion(env, path, init = {}) {
  const res = await fetch("https://api.notion.com/v1" + path, {
    ...init,
    headers: {
      authorization: `Bearer ${env.NOTION_TOKEN}`,
      "notion-version": NOTION_VERSION,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
  const body = await res.json();
  if (!res.ok) throw new Error("notion error " + res.status + ": " + JSON.stringify(body));
  return body;
}

function simplify(page) {
  const p = page.properties;
  return {
    id: page.id,
    title: p["Task Name"]?.title?.[0]?.plain_text || "(untitled)",
    status: p["Status"]?.status?.name || null,
    priority: p["Priority"]?.select?.name || null,
    due: p["Due"]?.date?.start || null,
    area: p["Area"]?.select?.name || null, // 0.1
    label: p["Labels"]?.multi_select?.[0]?.name || null,
    notes: p["Notes"]?.rich_text?.[0]?.plain_text || "",
    completedAt: p["Completed at"]?.date?.start || null, // 0.3
  };
}

// 0.2 — cursor pagination: follows next_cursor until exhausted. Without
// this, any query past 100 rows silently truncates — the exact "source of
// truth window" failure mode this app exists to avoid.
async function queryAll(env, dataSourceId, body) {
  const results = [];
  let cursor;
  do {
    const page = await notion(env, `/data_sources/${dataSourceId}/query`, {
      method: "POST",
      body: JSON.stringify(cursor ? { ...body, start_cursor: cursor } : body),
    });
    results.push(...page.results);
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return results;
}

async function listOpenTasks(env) {
  const dataSourceId = env.DATA_SOURCE_ID || DEFAULT_DATA_SOURCE_ID;
  const body = {
    filter: {
      and: [
        { property: "Status", status: { does_not_equal: "Done" } },
        { property: "Status", status: { does_not_equal: "Canceled" } },
      ],
    },
    sorts: [{ property: "Due", direction: "ascending" }],
    page_size: 100,
  };
  const results = await queryAll(env, dataSourceId, body);
  return results.map(simplify);
}

// 0.3 — completed tasks, for the weekly review screen (2.3). `since` uses
// Jakarta-local date math (BUG-01) — the same UTC bug that hit the
// Completed-at stamp would otherwise misdraw the review window at the
// 00:00–07:00 Jakarta boundary.
async function listCompletedTasks(env, days) {
  const dataSourceId = env.DATA_SOURCE_ID || DEFAULT_DATA_SOURCE_ID;
  const since = jakartaISO(new Date(Date.now() - days * 86400000));
  const body = {
    filter: {
      and: [
        { property: "Status", status: { equals: "Done" } },
        { property: "Completed at", date: { on_or_after: since } },
      ],
    },
    sorts: [{ property: "Completed at", direction: "descending" }],
    page_size: 100,
  };
  const results = await queryAll(env, dataSourceId, body);
  return results.map(simplify);
}

async function createTask(env, input) {
  const dataSourceId = env.DATA_SOURCE_ID || DEFAULT_DATA_SOURCE_ID;
  const properties = {
    "Task Name": { title: [{ text: { content: input.title } }] },
    Status: { status: { name: "To do" } },
    Priority: { select: { name: input.priority || "P3 - Medium" } },
    Source: { select: { name: "Manual" } },
  };
  if (input.area) properties["Area"] = { select: { name: input.area } }; // 0.1
  if (input.due) properties["Due"] = { date: { start: input.due } };
  if (input.notes) properties["Notes"] = { rich_text: [{ text: { content: input.notes } }] };

  const page = await notion(env, "/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { type: "data_source_id", data_source_id: dataSourceId },
      properties,
    }),
  });
  return simplify(page);
}

async function updateTask(env, pageId, input) {
  const properties = {};
  if (input.status) {
    properties["Status"] = { status: { name: input.status } };
    properties["Completed at"] =
      input.status === "Done"
        ? { date: { start: jakartaISO() } } // BUG-01
        : { date: null };
  }
  if (input.title) properties["Task Name"] = { title: [{ text: { content: input.title } }] };
  if (input.due !== undefined) properties["Due"] = input.due ? { date: { start: input.due } } : { date: null };
  if (input.priority) properties["Priority"] = { select: { name: input.priority } };
  if (input.area !== undefined) properties["Area"] = input.area ? { select: { name: input.area } } : { select: null }; // 0.1

  const page = await notion(env, `/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
  return simplify(page);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    if ((request.headers.get("x-app-key") || "") !== (env.APP_KEY || "")) {
      return json({ error: "unauthorized" }, 401, env);
    }

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // ["api","tasks", "<id>"?]

    try {
      if (parts[0] === "api" && parts[1] === "tasks" && !parts[2] && request.method === "GET") {
        const tasks = await listOpenTasks(env);
        return json({ tasks }, 200, env);
      }
      // 0.3 — must be matched before the generic /api/tasks/:id PATCH route
      if (parts[0] === "api" && parts[1] === "tasks" && parts[2] === "completed" && request.method === "GET") {
        const days = Math.min(Math.max(parseInt(url.searchParams.get("days") || "30", 10) || 30, 1), 365);
        const tasks = await listCompletedTasks(env, days);
        return json({ tasks }, 200, env);
      }
      if (parts[0] === "api" && parts[1] === "tasks" && !parts[2] && request.method === "POST") {
        let input;
        try {
          input = await request.json();
        } catch {
          return json({ error: "body must be valid JSON", field: "body" }, 400, env);
        }
        try {
          validateInput(input, { partial: false });
        } catch (e) {
          if (e.isValidation) return json({ error: e.message, field: e.field }, 400, env);
          throw e;
        }
        const task = await createTask(env, input);
        return json(task, 201, env);
      }
      if (parts[0] === "api" && parts[1] === "tasks" && parts[2] && request.method === "PATCH") {
        if (!UUID_RE.test(parts[2])) {
          return json({ error: "task id must be a UUID", field: "id" }, 400, env);
        }
        let input;
        try {
          input = await request.json();
        } catch {
          return json({ error: "body must be valid JSON", field: "body" }, 400, env);
        }
        try {
          validateInput(input, { partial: true });
        } catch (e) {
          if (e.isValidation) return json({ error: e.message, field: e.field }, 400, env);
          throw e;
        }
        const task = await updateTask(env, parts[2], input);
        return json(task, 200, env);
      }
      return json({ error: "not found" }, 404, env);
    } catch (e) {
      return json({ error: String(e) }, 500, env);
    }
  },
};
