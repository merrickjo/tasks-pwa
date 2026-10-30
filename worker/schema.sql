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

-- journal (v11, 30 Oct 2026) — the bullet journal inside Notch. One row per
-- page: d:YYYY-MM-DD (daily log), w:YYYY-Www (weekly spread, ISO week),
-- m:YYYY-MM (monthly log). Typed sections live here; handwriting lives in
-- journal_ink, one row per ink page, so a page of strokes never rewrites
-- the typed text (and vice versa). `rev` is the optimistic-concurrency
-- counter: a write whose base_rev is stale gets 409 + the current row.
CREATE TABLE IF NOT EXISTS journal (
  key        TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,                 -- day | week | month
  sections   TEXT NOT NULL DEFAULT '{}',    -- JSON { sectionId: text }
  mode       TEXT NOT NULL DEFAULT 'type',  -- type | ink (last used)
  rev        INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_journal_updated ON journal(updated_at);
CREATE TABLE IF NOT EXISTS journal_ink (
  key        TEXT NOT NULL,
  page       INTEGER NOT NULL,              -- 0-based
  strokes    TEXT NOT NULL DEFAULT '[]',    -- JSON [{ id, w, p:[x,y,pressure, dx,dy,dp, ...] }]
  rev        INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (key, page)
);
CREATE INDEX IF NOT EXISTS idx_journal_ink_updated ON journal_ink(updated_at);

-- CONCURSUS history, durable (v11). Until now history lived only in each
-- device's localStorage with a 35-day prune; the journal's weekly/monthly
-- Concursus rows read from here, and every device pushes what it has.
CREATE TABLE IF NOT EXISTS concursus_days (
  date          TEXT PRIMARY KEY,           -- YYYY-MM-DD, local
  roll          INTEGER NOT NULL,
  done          TEXT NOT NULL,              -- JSON { domain: bool }
  family_person TEXT,
  notch         INTEGER NOT NULL DEFAULT 0,
  at            TEXT NOT NULL               -- client timestamp, last write wins
);
