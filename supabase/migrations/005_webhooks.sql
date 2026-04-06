-- Webhook configuration
-- Depends on: 001_initial_schema.sql (projects table, update_updated_at() function)

CREATE TABLE IF NOT EXISTS webhook_configs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'generic'
    CHECK (platform IN ('generic', 'slack', 'discord', 'telegram')),
  events TEXT[] NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT true,
  secret TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_webhook_name_per_project UNIQUE(project_id, name)
);

CREATE INDEX IF NOT EXISTS idx_webhook_configs_project ON webhook_configs(project_id);

DROP TRIGGER IF EXISTS trg_webhook_configs_updated ON webhook_configs;
CREATE TRIGGER trg_webhook_configs_updated
  BEFORE UPDATE ON webhook_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
