-- tasks-db (Cloudflare D1) — replaces the Notion "✅ Tasks" data source, 28 Sep 2026
CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,            -- UUID (imported rows keep their Notion page id)
  title        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'To do',
  priority     TEXT,
  due          TEXT,                        -- YYYY-MM-DD or full ISO datetime (as Notion returned it)
  area         TEXT,
  labels       TEXT NOT NULL DEFAULT '[]',  -- JSON array; API exposes the first as `label`
  notes        TEXT NOT NULL DEFAULT '',
  completed_at TEXT,                        -- YYYY-MM-DD, Jakarta-local
  source       TEXT,
  recurrence   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks(status, due);
CREATE INDEX IF NOT EXISTS idx_tasks_completed ON tasks(status, completed_at);
