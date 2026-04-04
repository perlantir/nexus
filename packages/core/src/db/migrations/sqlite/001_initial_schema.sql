-- DeciGraph Initial Schema — SQLite edition
--
-- Mapping notes (PostgreSQL → SQLite):
--   UUID PRIMARY KEY DEFAULT uuid_generate_v4()  → TEXT PRIMARY KEY  (UUIDs generated in application code)
--   TIMESTAMPTZ NOT NULL DEFAULT NOW()            → TEXT NOT NULL DEFAULT (datetime('now'))
--   TIMESTAMPTZ (nullable)                        → TEXT
--   DATE NOT NULL DEFAULT CURRENT_DATE            → TEXT NOT NULL DEFAULT (date('now'))
--   JSONB NOT NULL DEFAULT '{}'                   → TEXT NOT NULL DEFAULT '{}'
--   TEXT[] / UUID[] NOT NULL DEFAULT '{}'         → TEXT NOT NULL DEFAULT '[]'   (JSON arrays)
--   BOOLEAN NOT NULL                              → INTEGER NOT NULL (0 = false, 1 = true)
--   FLOAT                                         → REAL
--   vector(1536)                                  → omitted (handled by embedding tables below)
--   SERIAL                                        → INTEGER PRIMARY KEY AUTOINCREMENT
--   CREATE EXTENSION                              → no-op (not supported)
--   HNSW / GIN indexes                            → omitted (SQLite has no equivalent)
--   PL/pgSQL functions + triggers                 → inline CREATE TRIGGER … BEGIN … END

-- ============================================================
-- PROJECTS
-- ============================================================
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT NOT NULL PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  metadata    TEXT NOT NULL DEFAULT '{}'
);

CREATE TRIGGER IF NOT EXISTS trg_projects_updated
  AFTER UPDATE ON projects
  FOR EACH ROW
BEGIN
  UPDATE projects SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- ============================================================
-- AGENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS agents (
  id                    TEXT    NOT NULL PRIMARY KEY,
  project_id            TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name                  TEXT    NOT NULL,
  role                  TEXT    NOT NULL,
  relevance_profile     TEXT    NOT NULL DEFAULT '{}',
  context_budget_tokens INTEGER NOT NULL DEFAULT 50000,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  CONSTRAINT uq_agent_name_per_project UNIQUE(project_id, name)
);

CREATE TRIGGER IF NOT EXISTS trg_agents_updated
  AFTER UPDATE ON agents
  FOR EACH ROW
BEGIN
  UPDATE agents SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- ============================================================
-- DECISIONS (graph nodes)
-- ============================================================
CREATE TABLE IF NOT EXISTS decisions (
  id                    TEXT NOT NULL PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title                 TEXT NOT NULL,
  description           TEXT NOT NULL,
  reasoning             TEXT NOT NULL,
  made_by               TEXT NOT NULL,
  source                TEXT NOT NULL DEFAULT 'manual'
                          CHECK (source IN ('manual', 'auto_distilled', 'imported')),
  source_session_id     TEXT,
  confidence            TEXT NOT NULL DEFAULT 'high'
                          CHECK (confidence IN ('high', 'medium', 'low')),
  status                TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'superseded', 'reverted', 'pending')),
  supersedes_id         TEXT REFERENCES decisions(id) ON DELETE SET NULL,
  alternatives_considered TEXT NOT NULL DEFAULT '[]',
  affects               TEXT NOT NULL DEFAULT '[]',
  tags                  TEXT NOT NULL DEFAULT '[]',
  assumptions           TEXT NOT NULL DEFAULT '[]',
  open_questions        TEXT NOT NULL DEFAULT '[]',
  dependencies          TEXT NOT NULL DEFAULT '[]',
  validated_at          TEXT,
  validation_source     TEXT,
  confidence_decay_rate REAL DEFAULT 0.0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  metadata              TEXT NOT NULL DEFAULT '{}'
  -- embedding column omitted; stored in decision_embeddings table
);

CREATE INDEX IF NOT EXISTS idx_decisions_project  ON decisions(project_id);
CREATE INDEX IF NOT EXISTS idx_decisions_status   ON decisions(status);
CREATE INDEX IF NOT EXISTS idx_decisions_made_by  ON decisions(made_by);
CREATE INDEX IF NOT EXISTS idx_decisions_created  ON decisions(created_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_decisions_updated
  AFTER UPDATE ON decisions
  FOR EACH ROW
BEGIN
  UPDATE decisions SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- ============================================================
-- DECISION EDGES (graph relationships)
-- ============================================================
CREATE TABLE IF NOT EXISTS decision_edges (
  id           TEXT NOT NULL PRIMARY KEY,
  source_id    TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  target_id    TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL CHECK (relationship IN (
    'supersedes', 'requires', 'informs', 'blocks', 'contradicts',
    'enables', 'depends_on', 'refines', 'reverts'
  )),
  description  TEXT,
  strength     REAL DEFAULT 1.0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  CONSTRAINT uq_edge      UNIQUE(source_id, target_id, relationship),
  CONSTRAINT no_self_edge CHECK (source_id != target_id)
);

-- ============================================================
-- ARTIFACTS
-- ============================================================
CREATE TABLE IF NOT EXISTS artifacts (
  id                   TEXT NOT NULL PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  path                 TEXT,
  artifact_type        TEXT NOT NULL CHECK (artifact_type IN (
    'spec', 'code', 'design', 'report', 'config', 'documentation', 'test', 'other'
  )),
  description          TEXT,
  content_summary      TEXT,
  content_hash         TEXT,
  produced_by          TEXT NOT NULL,
  related_decision_ids TEXT NOT NULL DEFAULT '[]',
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
  metadata             TEXT NOT NULL DEFAULT '{}'
  -- embedding column omitted; stored in artifact_embeddings table
);

CREATE TRIGGER IF NOT EXISTS trg_artifacts_updated
  AFTER UPDATE ON artifacts
  FOR EACH ROW
BEGIN
  UPDATE artifacts SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- ============================================================
-- SESSION SUMMARIES
-- ============================================================
CREATE TABLE IF NOT EXISTS session_summaries (
  id                      TEXT NOT NULL PRIMARY KEY,
  project_id              TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_name              TEXT NOT NULL,
  session_date            TEXT NOT NULL DEFAULT (date('now')),
  topic                   TEXT NOT NULL,
  summary                 TEXT NOT NULL,
  decision_ids            TEXT NOT NULL DEFAULT '[]',
  artifact_ids            TEXT NOT NULL DEFAULT '[]',
  assumptions             TEXT NOT NULL DEFAULT '[]',
  open_questions          TEXT NOT NULL DEFAULT '[]',
  lessons_learned         TEXT NOT NULL DEFAULT '[]',
  raw_conversation_hash   TEXT,
  extraction_model        TEXT,
  extraction_confidence   REAL,
  created_at              TEXT NOT NULL DEFAULT (datetime('now'))
  -- embedding column omitted; stored in session_embeddings table
);

-- ============================================================
-- SUBSCRIPTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS subscriptions (
  id         TEXT NOT NULL PRIMARY KEY,
  agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  topic      TEXT NOT NULL,
  notify_on  TEXT NOT NULL DEFAULT '["update","supersede","revert"]',
  priority   TEXT DEFAULT 'medium' CHECK (priority IN ('high', 'medium', 'low')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CONSTRAINT uq_subscription UNIQUE(agent_id, topic)
);

-- ============================================================
-- NOTIFICATIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS notifications (
  id                TEXT NOT NULL PRIMARY KEY,
  agent_id          TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  decision_id       TEXT REFERENCES decisions(id) ON DELETE SET NULL,
  notification_type TEXT NOT NULL CHECK (notification_type IN (
    'decision_created', 'decision_updated', 'decision_superseded',
    'decision_reverted', 'artifact_updated', 'blocked', 'unblocked',
    'contradiction_detected', 'assumption_invalidated', 'dependency_changed'
  )),
  message           TEXT NOT NULL,
  role_context      TEXT,
  urgency           TEXT DEFAULT 'medium' CHECK (urgency IN ('critical', 'high', 'medium', 'low')),
  read_at           TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- CONTEXT CACHE
-- ============================================================
CREATE TABLE IF NOT EXISTS context_cache (
  id                    TEXT    NOT NULL PRIMARY KEY,
  agent_id              TEXT    NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  task_hash             TEXT    NOT NULL,
  compiled_context      TEXT    NOT NULL,
  decision_ids_included TEXT    NOT NULL DEFAULT '[]',
  artifact_ids_included TEXT    NOT NULL DEFAULT '[]',
  token_count           INTEGER NOT NULL,
  compiled_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  -- Default expiry: 1 hour from now (strftime for arithmetic)
  expires_at            TEXT    NOT NULL DEFAULT (datetime('now', '+1 hour')),
  CONSTRAINT uq_cache_entry UNIQUE(agent_id, task_hash)
);

-- ============================================================
-- RELEVANCE FEEDBACK
-- ============================================================
CREATE TABLE IF NOT EXISTS relevance_feedback (
  id                 TEXT    NOT NULL PRIMARY KEY,
  agent_id           TEXT    NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  decision_id        TEXT    NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  compile_request_id TEXT,
  was_useful         INTEGER NOT NULL CHECK (was_useful IN (0, 1)),
  usage_signal       TEXT,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_feedback_agent    ON relevance_feedback(agent_id);
CREATE INDEX IF NOT EXISTS idx_feedback_decision ON relevance_feedback(decision_id);

-- ============================================================
-- CONTRADICTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS contradictions (
  id                   TEXT NOT NULL PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  decision_a_id        TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  decision_b_id        TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  similarity_score     REAL NOT NULL,
  conflict_description TEXT,
  status               TEXT NOT NULL DEFAULT 'unresolved'
                         CHECK (status IN ('unresolved', 'resolved', 'dismissed')),
  resolved_by          TEXT,
  resolution           TEXT,
  detected_at          TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at          TEXT
);

-- ============================================================
-- EMBEDDING SIDECAR TABLES
-- (Store raw blob embeddings separately; compatible with sqlite-vec vec0 tables)
-- ============================================================

-- Decision embeddings
CREATE TABLE IF NOT EXISTS decision_embeddings (
  decision_id TEXT PRIMARY KEY REFERENCES decisions(id) ON DELETE CASCADE,
  embedding   BLOB
);

-- Artifact embeddings
CREATE TABLE IF NOT EXISTS artifact_embeddings (
  artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
  embedding   BLOB
);

-- Session summary embeddings
CREATE TABLE IF NOT EXISTS session_embeddings (
  session_id TEXT PRIMARY KEY REFERENCES session_summaries(id) ON DELETE CASCADE,
  embedding  BLOB
);
