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

-- calendar mirror (1 Oct 2026) — work meetings pushed from the Mac by
-- notch-cal (macOS Calendar → Worker). Titles + times only, by design:
-- no attendees, no body, no location. Each push replaces a date window.
CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  date      TEXT NOT NULL,                  -- YYYY-MM-DD, Jakarta-local start day
  start     TEXT NOT NULL,                  -- ISO datetime with offset (all-day: YYYY-MM-DD)
  end       TEXT NOT NULL,
  all_day   INTEGER NOT NULL DEFAULT 0,
  title     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_date ON events(date, start);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
