-- DeciGraph SQLite Migration Tracking Table
-- Applied first, before any other migration files.

CREATE TABLE IF NOT EXISTS _decigraph_migrations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  applied_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
