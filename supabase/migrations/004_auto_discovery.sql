-- Auto-discovery tables
-- Depends on: 003_relevance_feedback.sql (defines update_updated_at() function)

-- Track processed conversation sources
CREATE TABLE processed_sources (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  connector_name TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decisions_extracted INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT uq_source_per_project UNIQUE(project_id, source_id)
);

CREATE INDEX idx_processed_sources_project ON processed_sources(project_id);
CREATE INDEX idx_processed_sources_connector ON processed_sources(connector_name);

-- Auto-discovery: connector configuration per project
CREATE TABLE connector_configs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  connector_name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_poll_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_connector_per_project UNIQUE(project_id, connector_name)
);

CREATE TRIGGER trg_connector_configs_updated
  BEFORE UPDATE ON connector_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
