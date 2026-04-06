-- Migration 013: Cleanup duplicate tables + api_keys schema fixes
-- Consolidates Phase 1 and Phase 2 tables; ensures canonical names exist.
-- Fully idempotent — safe to run multiple times.

-- ============================================================
-- Ensure canonical tables exist (Phase 1 originals)
-- ============================================================

-- contradictions (Phase 1 canonical)
CREATE TABLE IF NOT EXISTS contradictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  decision_a_id UUID NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  decision_b_id UUID NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  similarity_score FLOAT NOT NULL DEFAULT 0,
  conflict_description TEXT,
  status TEXT NOT NULL DEFAULT 'unresolved' CHECK (status IN ('unresolved', 'resolved', 'dismissed')),
  resolved_by TEXT,
  resolution TEXT,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

-- decision_edges (Phase 1 canonical)
CREATE TABLE IF NOT EXISTS decision_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  target_id UUID NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL,
  description TEXT,
  strength FLOAT DEFAULT 1.0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- phase2_contradictions (Phase 2 — used by intelligence layer)
CREATE TABLE IF NOT EXISTS phase2_contradictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_a_id UUID NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  decision_b_id UUID NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  explanation TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(decision_a_id, decision_b_id)
);

-- phase2_decision_edges (Phase 2 — used by intelligence layer)
CREATE TABLE IF NOT EXISTS phase2_decision_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_decision_id UUID NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  to_decision_id UUID NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  edge_type TEXT NOT NULL CHECK (edge_type IN ('depends_on', 'supersedes', 'related_to', 'blocks')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by TEXT,
  UNIQUE(from_decision_id, to_decision_id, edge_type)
);

-- ============================================================
-- Ensure tenant_id columns exist (Phase 3 may have added these)
-- ============================================================

ALTER TABLE contradictions ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE decision_edges ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE phase2_contradictions ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE phase2_decision_edges ADD COLUMN IF NOT EXISTS tenant_id UUID;

-- ============================================================
-- Fix api_keys table schema (Fix 9)
-- ============================================================

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_prefix TEXT DEFAULT '';
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS permissions TEXT DEFAULT 'read_write';
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS rate_limit INTEGER DEFAULT 100;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS created_by UUID;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
DO $$ BEGIN ALTER TABLE api_keys ALTER COLUMN project_id DROP NOT NULL; EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- ============================================================
-- Indexes (idempotent)
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_p2_contradictions_status ON phase2_contradictions(status);
CREATE INDEX IF NOT EXISTS idx_p2_contradictions_decision_a ON phase2_contradictions(decision_a_id);
CREATE INDEX IF NOT EXISTS idx_p2_contradictions_decision_b ON phase2_contradictions(decision_b_id);
CREATE INDEX IF NOT EXISTS idx_p2_decision_edges_from ON phase2_decision_edges(from_decision_id);
CREATE INDEX IF NOT EXISTS idx_p2_decision_edges_to ON phase2_decision_edges(to_decision_id);
