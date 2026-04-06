-- Phase 3: Multi-Tenancy, Authentication & Security
-- Creates tenants, tenant_members, api_keys, audit_log tables
-- Adds tenant_id to existing tables, backfills default tenant

-- Tenants
CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'enterprise')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tenant members
CREATE TABLE IF NOT EXISTS tenant_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  invited_by UUID,
  invite_token TEXT UNIQUE,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, user_id)
);

-- API keys
CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id UUID,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  permissions TEXT NOT NULL DEFAULT 'read' CHECK (permissions IN ('read', 'read_write', 'admin')),
  rate_limit INTEGER NOT NULL DEFAULT 100,
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID NOT NULL
);

-- Audit log (phase3 version with tenant scoping)
CREATE TABLE IF NOT EXISTS audit_log_v2 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  user_id UUID,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id UUID,
  details JSONB,
  ip_address TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add tenant_id to existing tables
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE contradictions ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE decision_edges ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE phase2_contradictions ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE phase2_decision_edges ADD COLUMN IF NOT EXISTS tenant_id UUID;

-- Default tenant for existing data
INSERT INTO tenants (id, name, slug, plan)
VALUES ('a0000000-0000-4000-8000-000000000001', 'Nick Gallick', 'nick', 'enterprise')
ON CONFLICT (slug) DO NOTHING;

-- Backfill existing decisions
UPDATE decisions SET tenant_id = 'a0000000-0000-4000-8000-000000000001' WHERE tenant_id IS NULL;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_tenant_members_tenant ON tenant_members(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_members_user ON tenant_members(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys(tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_v2_tenant ON audit_log_v2(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_tenant ON decisions(tenant_id);
