/**
 * Ingestion Worker — validates, generates embedding, deduplicates, and inserts
 * a structured decision into the database.
 *
 * Key fix: The decisions table has:
 *   source TEXT CHECK (source IN ('manual', 'auto_distilled', 'imported'))
 *   source_session_id UUID
 *
 * Connectors pass source='openclaw'/'telegram' (invalid for CHECK) and
 * source_session_id='workspace-maks/test.jsonl:1' (not a UUID).
 * We map these to valid DB values and store the original source info
 * in a metadata-enriched description.
 */
import { getDb } from '@decigraph/core/db/index.js';
import { generateEmbedding } from '@decigraph/core/decision-graph/embeddings.js';
import crypto from 'node:crypto';
import type { IngestionJobData, NotificationJobData } from './index.js';
import { addNotificationJob } from './index.js';

/**
 * Generate a deterministic UUID v5 from a string.
 * Used to convert source_session_id strings to valid UUIDs for dedupe.
 */
function deterministicUUID(input: string): string {
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  // Format as UUID: 8-4-4-4-12
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '4' + hash.slice(13, 16), // Version 4
    ((parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80).toString(16) + hash.slice(18, 20), // Variant
    hash.slice(20, 32),
  ].join('-');
}

/**
 * Map connector source names to valid DB CHECK values.
 */
function mapSourceForDB(source: string): string {
  switch (source) {
    case 'openclaw':
    case 'telegram':
      return 'auto_distilled';
    case 'api':
      return 'manual';
    default:
      return 'auto_distilled';
  }
}

/**
 * Process ingestion job: embed, dedupe, insert.
 */
export async function handleIngestionJob(data: IngestionJobData): Promise<void> {
  const db = getDb();

  // Map source to DB-valid value (CHECK constraint: manual, auto_distilled, imported)
  const dbSource = mapSourceForDB(data.source);

  // Convert source_session_id to a valid UUID for the DB column
  const dbSessionId = data.source_session_id
    ? deterministicUUID(data.source_session_id)
    : null;

  console.log(`[decigraph/ingestion] Processing: "${data.title}" source=${data.source}→${dbSource} by=${data.made_by} project=${data.project_id.slice(0, 8)}..`);

  // ── Dedupe check by deterministic UUID ───────────────────────────────────
  if (dbSessionId) {
    try {
      const existing = await db.query(
        'SELECT id FROM decisions WHERE source_session_id = ? LIMIT 1',
        [dbSessionId],
      );
      if (existing.rows.length > 0) {
        console.log(`[decigraph/ingestion] Duplicate skipped: "${data.title}" (session_id=${dbSessionId.slice(0, 8)}..)`);
        return;
      }
    } catch (err) {
      console.warn('[decigraph/ingestion] Dedupe check failed:', (err as Error).message);
      // Continue — better to potentially duplicate than to drop a decision
    }
  }

  // ── Generate embedding ───────────────────────────────────────────────────
  let vectorLiteral: string | null = null;
  try {
    const embedding = await generateEmbedding(`${data.title}\n${data.description}`);
    if (embedding && !embedding.every((v) => v === 0)) {
      vectorLiteral = `[${embedding.join(',')}]`;
    }
  } catch (err) {
    console.warn(`[decigraph/ingestion] Embedding failed for "${data.title}":`, (err as Error).message);
    // Continue without embedding — decision still gets inserted
  }

  // ── Validate project exists ──────────────────────────────────────────────
  try {
    const proj = await db.query('SELECT id FROM projects WHERE id = ?', [data.project_id]);
    if (proj.rows.length === 0) {
      console.error(`[decigraph/ingestion] Project not found: ${data.project_id} — cannot insert decision "${data.title}"`);
      return;
    }
  } catch (err) {
    console.error(`[decigraph/ingestion] Project check failed:`, (err as Error).message);
    return;
  }

  // ── Insert decision ──────────────────────────────────────────────────────
  // Enrich description with original source info for traceability
  const enrichedDescription = data.source !== 'api'
    ? `${data.description}\n\n[Auto-ingested from ${data.source}${data.source_session_id ? ` — ref: ${data.source_session_id}` : ''}]`
    : data.description;

  const confidenceScore = data.confidence === 'high' ? 0.9 : data.confidence === 'medium' ? 0.6 : 0.3;
  const autoApproveThreshold = parseFloat(process.env.DECIGRAPH_AUTO_APPROVE_THRESHOLD ?? '0.85');
  const autoApproved = confidenceScore >= autoApproveThreshold;
  const decisionStatus = autoApproved ? 'active' : 'pending';
  const reviewStatus = autoApproved ? 'approved' : 'pending_review';

  console.log(`[decigraph/ingestion] Inserting decision: "${data.title}" project=${data.project_id.slice(0, 8)}.. source=${dbSource} status=${decisionStatus}`);

  try {
    const result = await db.query(
      `INSERT INTO decisions
         (project_id, title, description, reasoning, made_by, source,
          source_session_id, confidence, status,
          alternatives_considered, affects, tags,
          review_status, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id, title`,
      [
        data.project_id,
        data.title,
        enrichedDescription,
        data.reasoning,
        data.made_by,
        dbSource,
        dbSessionId,
        data.confidence,
        decisionStatus,
        JSON.stringify(data.alternatives_considered),
        db.arrayParam(data.affects),
        db.arrayParam(data.tags),
        reviewStatus,
        vectorLiteral,
      ],
    );

    const inserted = result.rows[0] as Record<string, unknown> | undefined;
    const decisionId = (inserted?.id as string) ?? 'unknown';

    console.log(`[decigraph/ingestion] ✓ Inserted decision ${decisionId} into DB: "${data.title}" (source=${data.source}, db_source=${dbSource})`);

    // ── Forward to notification queue ────────────────────────────────────
    const notificationData: NotificationJobData = {
      title: data.title,
      source: data.source,
      decision_id: decisionId,
    };

    // For Telegram, include chat/message info for reply
    if (data.source === 'telegram' && data.source_session_id) {
      const [chatId, messageId] = data.source_session_id.split(':');
      if (chatId) notificationData.chat_id = chatId;
      if (messageId) notificationData.message_id = parseInt(messageId, 10);
    }

    await addNotificationJob(notificationData);
  } catch (err) {
    console.error(`[decigraph/ingestion] ✗ INSERT FAILED for "${data.title}":`, (err as Error).message);
    console.error(`[decigraph/ingestion] Debug: project_id=${data.project_id} source=${dbSource} session_id=${dbSessionId} confidence=${data.confidence}`);
    throw err; // Re-throw so BullMQ retries
  }
}
