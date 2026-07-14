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
    label: p["Labels"]?.multi_select?.[0]?.name || null,
    notes: p["Notes"]?.rich_text?.[0]?.plain_text || "",
  };
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
  const result = await notion(env, `/data_sources/${dataSourceId}/query`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return result.results.map(simplify);
}

async function createTask(env, input) {
  const dataSourceId = env.DATA_SOURCE_ID || DEFAULT_DATA_SOURCE_ID;
  const properties = {
    "Task Name": { title: [{ text: { content: input.title } }] },
    Status: { status: { name: "To do" } },
    Priority: { select: { name: input.priority || "P3 - Medium" } },
    Source: { select: { name: "Manual" } },
  };
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
        ? { date: { start: new Date().toISOString().slice(0, 10) } }
        : { date: null };
  }
  if (input.title) properties["Task Name"] = { title: [{ text: { content: input.title } }] };
  if (input.due !== undefined) properties["Due"] = input.due ? { date: { start: input.due } } : { date: null };
  if (input.priority) properties["Priority"] = { select: { name: input.priority } };

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

    if (request.headers.get("x-app-key") !== env.APP_KEY) {
      return json({ error: "unauthorized" }, 401, env);
    }

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // ["api","tasks", "<id>"?]

    try {
      if (parts[0] === "api" && parts[1] === "tasks" && !parts[2] && request.method === "GET") {
        const tasks = await listOpenTasks(env);
        return json({ tasks }, 200, env);
      }
      if (parts[0] === "api" && parts[1] === "tasks" && !parts[2] && request.method === "POST") {
        const input = await request.json();
        const task = await createTask(env, input);
        return json(task, 201, env);
      }
      if (parts[0] === "api" && parts[1] === "tasks" && parts[2] && request.method === "PATCH") {
        const input = await request.json();
        const task = await updateTask(env, parts[2], input);
        return json(task, 200, env);
      }
      return json({ error: "not found" }, 404, env);
    } catch (e) {
      return json({ error: String(e) }, 500, env);
    }
  },
};
