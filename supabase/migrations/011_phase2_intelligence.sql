-- Phase 2: Intelligence Layer
-- Contradictions, decision edges (Phase 2 schema), staleness tracking, dedup

-- Contradictions (Phase 2 — new schema with confidence/status/resolution fields)
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

-- Decision edges (Phase 2 — chains/dependencies with new edge_type vocabulary)
CREATE TABLE IF NOT EXISTS phase2_decision_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_decision_id UUID NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  to_decision_id UUID NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  edge_type TEXT NOT NULL CHECK (edge_type IN ('depends_on', 'supersedes', 'related_to', 'blocks')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by TEXT,
  UNIQUE(from_decision_id, to_decision_id, edge_type)
);

-- Staleness tracking columns on decisions
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS last_referenced_at TIMESTAMPTZ;
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS reference_count INTEGER DEFAULT 0;
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS stale BOOLEAN DEFAULT false;

-- Deduplication
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS potential_duplicate_of UUID REFERENCES decisions(id);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_p2_contradictions_status ON phase2_contradictions(status);
CREATE INDEX IF NOT EXISTS idx_p2_contradictions_decision_a ON phase2_contradictions(decision_a_id);
CREATE INDEX IF NOT EXISTS idx_p2_contradictions_decision_b ON phase2_contradictions(decision_b_id);
CREATE INDEX IF NOT EXISTS idx_p2_decision_edges_from ON phase2_decision_edges(from_decision_id);
CREATE INDEX IF NOT EXISTS idx_p2_decision_edges_to ON phase2_decision_edges(to_decision_id);
CREATE INDEX IF NOT EXISTS idx_decisions_stale ON decisions(stale) WHERE stale = true;
CREATE INDEX IF NOT EXISTS idx_decisions_last_referenced ON decisions(last_referenced_at);
