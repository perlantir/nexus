-- DeciGraph Initial Schema
-- PostgreSQL 17 + pgvector

-- Extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- PROJECTS
-- ============================================================
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- ============================================================
-- AGENTS
-- ============================================================
CREATE TABLE agents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  relevance_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  context_budget_tokens INTEGER NOT NULL DEFAULT 50000,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_agent_name_per_project UNIQUE(project_id, name)
);

-- ============================================================
-- DECISIONS (graph nodes)
-- ============================================================
CREATE TABLE decisions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  made_by TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'auto_distilled', 'imported')),
  source_session_id UUID,
  confidence TEXT NOT NULL DEFAULT 'high' CHECK (confidence IN ('high', 'medium', 'low')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'reverted', 'pending')),
  supersedes_id UUID REFERENCES decisions(id) ON DELETE SET NULL,
  alternatives_considered JSONB NOT NULL DEFAULT '[]'::jsonb,
  affects TEXT[] NOT NULL DEFAULT '{}',
  tags TEXT[] NOT NULL DEFAULT '{}',
  assumptions JSONB NOT NULL DEFAULT '[]'::jsonb,
  open_questions JSONB NOT NULL DEFAULT '[]'::jsonb,
  dependencies JSONB NOT NULL DEFAULT '[]'::jsonb,
  validated_at TIMESTAMPTZ,
  validation_source TEXT,
  confidence_decay_rate FLOAT DEFAULT 0.0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding vector(1536)
);

CREATE INDEX idx_decisions_project ON decisions(project_id);
CREATE INDEX idx_decisions_status ON decisions(status);
CREATE INDEX idx_decisions_made_by ON decisions(made_by);
CREATE INDEX idx_decisions_created ON decisions(created_at DESC);
CREATE INDEX idx_decisions_tags ON decisions USING GIN(tags);
CREATE INDEX idx_decisions_affects ON decisions USING GIN(affects);
CREATE INDEX idx_decisions_embedding ON decisions
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- ============================================================
-- DECISION EDGES (graph relationships)
-- ============================================================
CREATE TABLE decision_edges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_id UUID NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  target_id UUID NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL CHECK (relationship IN (
    'supersedes', 'requires', 'informs', 'blocks', 'contradicts',
    'enables', 'depends_on', 'refines', 'reverts'
  )),
  description TEXT,
  strength FLOAT DEFAULT 1.0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_edge UNIQUE(source_id, target_id, relationship),
  CONSTRAINT no_self_edge CHECK (source_id != target_id)
);

-- ============================================================
-- ARTIFACTS
-- ============================================================
CREATE TABLE artifacts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  path TEXT,
  artifact_type TEXT NOT NULL CHECK (artifact_type IN (
    'spec', 'code', 'design', 'report', 'config', 'documentation', 'test', 'other'
  )),
  description TEXT,
  content_summary TEXT,
  content_hash TEXT,
  produced_by TEXT NOT NULL,
  related_decision_ids UUID[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding vector(1536)
);

CREATE INDEX idx_artifacts_embedding ON artifacts
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- ============================================================
-- SESSION SUMMARIES
-- ============================================================
CREATE TABLE session_summaries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  session_date DATE NOT NULL DEFAULT CURRENT_DATE,
  topic TEXT NOT NULL,
  summary TEXT NOT NULL,
  decision_ids UUID[] NOT NULL DEFAULT '{}',
  artifact_ids UUID[] NOT NULL DEFAULT '{}',
  assumptions TEXT[] NOT NULL DEFAULT '{}',
  open_questions TEXT[] NOT NULL DEFAULT '{}',
  lessons_learned TEXT[] NOT NULL DEFAULT '{}',
  raw_conversation_hash TEXT,
  extraction_model TEXT,
  extraction_confidence FLOAT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  embedding vector(1536)
);

-- ============================================================
-- SUBSCRIPTIONS (who cares about what)
-- ============================================================
CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  notify_on TEXT[] NOT NULL DEFAULT '{update,supersede,revert}',
  priority TEXT DEFAULT 'medium' CHECK (priority IN ('high', 'medium', 'low')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_subscription UNIQUE(agent_id, topic)
);

-- ============================================================
-- NOTIFICATIONS
-- ============================================================
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  decision_id UUID REFERENCES decisions(id) ON DELETE SET NULL,
  notification_type TEXT NOT NULL CHECK (notification_type IN (
    'decision_created', 'decision_updated', 'decision_superseded',
    'decision_reverted', 'artifact_updated', 'blocked', 'unblocked',
    'contradiction_detected', 'assumption_invalidated', 'dependency_changed'
  )),
  message TEXT NOT NULL,
  role_context TEXT,
  urgency TEXT DEFAULT 'medium' CHECK (urgency IN ('critical', 'high', 'medium', 'low')),
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- CONTEXT CACHE
-- ============================================================
CREATE TABLE context_cache (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  task_hash TEXT NOT NULL,
  compiled_context JSONB NOT NULL,
  decision_ids_included UUID[] NOT NULL DEFAULT '{}',
  artifact_ids_included UUID[] NOT NULL DEFAULT '{}',
  token_count INTEGER NOT NULL,
  compiled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '1 hour',
  CONSTRAINT uq_cache_entry UNIQUE(agent_id, task_hash)
);

-- ============================================================
-- RELEVANCE FEEDBACK (for evolving scoring weights)
-- ============================================================
CREATE TABLE relevance_feedback (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  decision_id UUID NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  compile_request_id TEXT,
  was_useful BOOLEAN NOT NULL,
  usage_signal TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_feedback_agent ON relevance_feedback(agent_id);
CREATE INDEX idx_feedback_decision ON relevance_feedback(decision_id);

-- ============================================================
-- CONTRADICTIONS
-- ============================================================
CREATE TABLE contradictions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  decision_a_id UUID NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  decision_b_id UUID NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  similarity_score FLOAT NOT NULL,
  conflict_description TEXT,
  status TEXT NOT NULL DEFAULT 'unresolved' CHECK (status IN ('unresolved', 'resolved', 'dismissed')),
  resolved_by TEXT,
  resolution TEXT,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);
