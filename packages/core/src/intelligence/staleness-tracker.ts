/**
 * Phase 2 Intelligence: Staleness Tracker
 *
 * Marks decisions as stale when unreferenced for 30+ days.
 * Applies confidence decay at 60 and 90 day thresholds.
 */
import { getDb } from '../db/index.js';

export async function markStaleDecisions(projectId: string): Promise<number> {
  const db = getDb();

  // Mark stale: last_referenced_at < 30 days ago (or never referenced and created > 30 days ago)
  const staleResult = await db.query(
    `UPDATE decisions
     SET stale = true
     WHERE project_id = ?
       AND status = 'active'
       AND stale = false
       AND (
         (last_referenced_at IS NOT NULL AND last_referenced_at < NOW() - INTERVAL '30 days')
         OR
         (last_referenced_at IS NULL AND created_at < NOW() - INTERVAL '30 days')
       )
     RETURNING id`,
    [projectId],
  );

  const staleCount = staleResult.rows.length;

  // Confidence decay: 60 days unreferenced -> medium
  await db.query(
    `UPDATE decisions
     SET confidence = 'medium'
     WHERE project_id = ?
       AND status = 'active'
       AND confidence = 'high'
       AND (
         (last_referenced_at IS NOT NULL AND last_referenced_at < NOW() - INTERVAL '60 days')
         OR
         (last_referenced_at IS NULL AND created_at < NOW() - INTERVAL '60 days')
       )`,
    [projectId],
  );

  // Confidence decay: 90 days unreferenced -> low
  await db.query(
    `UPDATE decisions
     SET confidence = 'low'
     WHERE project_id = ?
       AND status = 'active'
       AND confidence IN ('high', 'medium')
       AND (
         (last_referenced_at IS NOT NULL AND last_referenced_at < NOW() - INTERVAL '90 days')
         OR
         (last_referenced_at IS NULL AND created_at < NOW() - INTERVAL '90 days')
       )`,
    [projectId],
  );

  if (staleCount > 0) {
    console.log(`[decigraph/staleness] ${staleCount} decisions marked stale in project ${projectId.slice(0, 8)}..`);
  }

  return staleCount;
}

export async function reaffirmDecision(decisionId: string): Promise<void> {
  const db = getDb();

  await db.query(
    `UPDATE decisions
     SET stale = false, last_referenced_at = NOW()
     WHERE id = ?`,
    [decisionId],
  );

  console.log(`[decigraph/staleness] Decision ${decisionId.slice(0, 8)}.. reaffirmed`);
}
