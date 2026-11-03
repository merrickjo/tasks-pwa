-- v12 (3 Nov 2026) — projects. Run once against tasks-db:
--   wrangler d1 execute tasks-db --remote --file=migrations/0012_projects.sql
-- Tasks point at a project by its uuid (the `id` property on the Obsidian
-- project note), so a rename on either side never breaks the link.
ALTER TABLE tasks ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,             -- uuid, same as the vault note's `id`
  title       TEXT NOT NULL,
  space       TEXT,                         -- work | ministry | study
  status      TEXT NOT NULL DEFAULT 'Active', -- Active | Paused | Done
  description TEXT NOT NULL DEFAULT '',     -- vault: goal
  next        TEXT NOT NULL DEFAULT '',     -- vault: next_milestone
  next_due    TEXT,                         -- vault: next_milestone_date (YYYY-MM-DD)
  due         TEXT,                         -- vault: due (YYYY-MM-DD)
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status, next_due);
