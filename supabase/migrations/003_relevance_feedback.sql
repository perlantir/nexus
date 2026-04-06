-- Functions and Triggers

-- ============================================================
-- RECURSIVE GRAPH TRAVERSAL FUNCTION
-- ============================================================
CREATE OR REPLACE FUNCTION get_connected_decisions(
  start_id UUID,
  max_depth INTEGER DEFAULT 3
)
RETURNS TABLE (
  decision_id UUID,
  depth INTEGER,
  path UUID[],
  via_relationship TEXT
) AS $$
WITH RECURSIVE graph_walk AS (
  SELECT d.id AS decision_id, 0 AS depth, ARRAY[d.id] AS path, 'origin'::TEXT AS via_relationship
  FROM decisions d WHERE d.id = start_id
  UNION ALL
  SELECT neighbor.id, gw.depth + 1, gw.path || neighbor.id, neighbor.rel
  FROM graph_walk gw
  JOIN LATERAL (
    SELECT e.target_id AS id, e.relationship AS rel FROM decision_edges e
    WHERE e.source_id = gw.decision_id AND NOT (e.target_id = ANY(gw.path))
    UNION ALL
    SELECT e.source_id AS id, e.relationship || '_reverse' AS rel FROM decision_edges e
    WHERE e.target_id = gw.decision_id AND NOT (e.source_id = ANY(gw.path))
  ) neighbor ON true
  WHERE gw.depth < max_depth
)
SELECT DISTINCT ON (decision_id) decision_id, depth, path, via_relationship
FROM graph_walk WHERE decision_id != start_id
ORDER BY decision_id, depth ASC;
$$ LANGUAGE SQL STABLE;

-- ============================================================
-- AUTO-UPDATE TRIGGERS
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_projects_updated ON projects;
CREATE TRIGGER trg_projects_updated BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS trg_agents_updated ON agents;
CREATE TRIGGER trg_agents_updated BEFORE UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS trg_decisions_updated ON decisions;
CREATE TRIGGER trg_decisions_updated BEFORE UPDATE ON decisions FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS trg_artifacts_updated ON artifacts;
CREATE TRIGGER trg_artifacts_updated BEFORE UPDATE ON artifacts FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- CACHE CLEANUP
-- ============================================================
CREATE OR REPLACE FUNCTION cleanup_expired_cache()
RETURNS INTEGER AS $$
DECLARE deleted_count INTEGER;
BEGIN
  DELETE FROM context_cache WHERE expires_at < NOW();
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;
