import { getDb } from '../db/index.js';
import { distill } from '../distillery/index.js';
import type { ConversationChunk } from '../connectors/types.js';

// ---------------------------------------------------------------------------
// Processed-sources helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if `sourceId` has already been processed for `projectId`.
 * Uses the `processed_sources` table (unique constraint on project_id + source_id).
 */
export async function isAlreadyProcessed(
  projectId: string,
  sourceId: string,
): Promise<boolean> {
  const db = getDb();
  const result = await db.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM processed_sources
       WHERE project_id = ? AND source_id = ?
     ) AS exists`,
    [projectId, sourceId],
  );
  return result.rows[0]?.exists ?? false;
}

/**
 * Inserts a record into `processed_sources` to mark a source as processed.
 * Uses ON CONFLICT DO UPDATE so that re-processing (e.g. a modified file)
 * refreshes the row rather than throwing a unique-constraint violation.
 */
export async function markProcessed(
  projectId: string,
  sourceId: string,
  connectorName: string,
  decisionsExtracted: number,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const db = getDb();
  await db.query(
    `INSERT INTO processed_sources
       (project_id, source_id, connector_name, decisions_extracted, metadata)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (project_id, source_id) DO UPDATE
       SET connector_name      = EXCLUDED.connector_name,
           decisions_extracted = EXCLUDED.decisions_extracted,
           metadata            = EXCLUDED.metadata,
           processed_at        = NOW()`,
    [projectId, sourceId, connectorName, decisionsExtracted, JSON.stringify(metadata)],
  );
}

// ---------------------------------------------------------------------------
// Single-chunk processor
// ---------------------------------------------------------------------------

/**
 * Processes a single ConversationChunk through the full distillery pipeline.
 *
 * - Skips chunks that have already been processed (dedup by source_id).
 * - Runs distill() to extract decisions.
 * - Marks the chunk processed in the DB.
 *
 * @returns The number of decisions extracted (0 if skipped or empty).
 */
export async function processChunk(
  projectId: string,
  chunk: ConversationChunk,
  connectorName: string,
): Promise<{ decisions_extracted: number }> {
  const already = await isAlreadyProcessed(projectId, chunk.source_id);
  if (already) {
    return { decisions_extracted: 0 };
  }

  const agentName = chunk.agent_name ?? 'unknown';
  const sessionId = chunk.source_id;

  let decisionsExtracted = 0;

  try {
    const result = await distill(projectId, chunk.text, agentName, sessionId);
    decisionsExtracted = result.decisions_extracted;
  } catch (err) {
    console.error(
      `[decigraph:auto-discovery] distill() failed for source "${chunk.source_id}":`,
      err,
    );
    // Still mark as processed with an error note so we don't retry endlessly
    await markProcessed(projectId, chunk.source_id, connectorName, 0, {
      error: err instanceof Error ? err.message : String(err),
      connector: connectorName,
      agent_name: agentName,
      timestamp: chunk.timestamp.toISOString(),
      ...chunk.metadata,
    });
    return { decisions_extracted: 0 };
  }

  await markProcessed(projectId, chunk.source_id, connectorName, decisionsExtracted, {
    connector: connectorName,
    agent_name: agentName,
    timestamp: chunk.timestamp.toISOString(),
    ...chunk.metadata,
  });

  return { decisions_extracted: decisionsExtracted };
}

// ---------------------------------------------------------------------------
// Batch processor
// ---------------------------------------------------------------------------

/** Summary returned after processing a batch of chunks. */
export interface BatchResult {
  processed: number;
  decisions_extracted: number;
  errors: number;
}

/**
 * Processes a batch of ConversationChunks sequentially.
 * Each chunk is processed independently — an error on one chunk does not
 * abort the batch; instead it increments the `errors` counter.
 */
export async function processBatch(
  projectId: string,
  chunks: ConversationChunk[],
  connectorName: string,
): Promise<BatchResult> {
  let processed = 0;
  let decisions_extracted = 0;
  let errors = 0;

  for (const chunk of chunks) {
    try {
      const result = await processChunk(projectId, chunk, connectorName);
      processed++;
      decisions_extracted += result.decisions_extracted;
    } catch (err) {
      errors++;
      console.error(
        `[decigraph:auto-discovery] Unexpected error processing chunk "${chunk.source_id}":`,
        err,
      );
    }
  }

  return { processed, decisions_extracted, errors };
}
