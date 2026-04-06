/**
 * Phase 2 Intelligence: Dedup Detector
 *
 * Detects potential duplicate decisions using pure vector similarity (no LLM).
 * Threshold: cosine similarity > 0.92
 */
import { getDb } from '../db/index.js';

const DEDUP_SIMILARITY_THRESHOLD = 0.92;

export async function detectDuplicates(newDecisionId: string, projectId: string): Promise<void> {
  const db = getDb();

  // Fetch the new decision
  const newResult = await db.query(
    'SELECT id, title, embedding FROM decisions WHERE id = ? AND project_id = ?',
    [newDecisionId, projectId],
  );
  if (newResult.rows.length === 0) return;

  const newDec = newResult.rows[0] as Record<string, unknown>;

  if (!newDec.embedding) {
    console.log(`[decigraph/dedup] No embedding for decision "${newDec.title}" — skipping`);
    return;
  }

  const embeddingStr = typeof newDec.embedding === 'string'
    ? newDec.embedding
    : `[${(newDec.embedding as number[]).join(',')}]`;

  let similarResult;
  try {
    similarResult = await db.query(
      `SELECT id, title, 1 - (embedding <=> ?) as similarity
       FROM decisions
       WHERE project_id = ? AND id != ? AND embedding IS NOT NULL AND status = 'active'
       ORDER BY embedding <=> ?
       LIMIT 1`,
      [embeddingStr, projectId, newDecisionId, embeddingStr],
    );
  } catch {
    console.warn('[decigraph/dedup] Vector search not available — skipping');
    return;
  }

  if (similarResult.rows.length === 0) return;

  const topMatch = similarResult.rows[0] as Record<string, unknown>;
  const similarity = topMatch.similarity as number;

  if (similarity >= DEDUP_SIMILARITY_THRESHOLD) {
    await db.query(
      'UPDATE decisions SET potential_duplicate_of = ? WHERE id = ?',
      [topMatch.id, newDecisionId],
    );

    console.log(
      `[decigraph/dedup] Potential duplicate: "${newDec.title}" ~ "${topMatch.title}" (${similarity.toFixed(2)})`,
    );
  }
}
