import type { Hono } from 'hono';
import { getDb } from '@nexus/core/db/index.js';
import { parseDecision } from '@nexus/core/db/parsers.js';
import { NotFoundError, ValidationError } from '@nexus/core/types.js';
import type { Decision, NotificationType } from '@nexus/core/types.js';
import { propagateChange } from '@nexus/core/change-propagator/index.js';
import { checkForContradictions } from '@nexus/core/contradiction-detector/index.js';
import { dispatchWebhooks } from '@nexus/core/webhooks/index.js';
import { requireUUID, logAudit, generateEmbedding } from './validation.js';

export function registerReviewRoutes(app: Hono): void {
  // ── Review Queue ──────────────────────────────────────────────────────
  app.get('/api/projects/:id/review-queue', async (c) => {
    const db = getDb();
    const projectId = requireUUID(c.req.param('id'), 'projectId');

    const result = await db.query(
      `SELECT * FROM decisions
       WHERE project_id = ? AND review_status = 'pending_review'
       ORDER BY created_at DESC`,
      [projectId],
    );

    return c.json(result.rows.map((r) => parseDecision(r as Record<string, unknown>)));
  });

  // ── Approve ───────────────────────────────────────────────────────────
  app.post('/api/decisions/:id/approve', async (c) => {
    const db = getDb();
    const id = requireUUID(c.req.param('id'), 'id');

    const existing = await db.query('SELECT * FROM decisions WHERE id = ?', [id]);
    if (existing.rows.length === 0) throw new NotFoundError('Decision', id);
    const dec = existing.rows[0] as Record<string, unknown>;

    if (dec.review_status !== 'pending_review' && dec.status !== 'pending') {
      throw new ValidationError('Decision is not pending review');
    }

    const result = await db.query(
      `UPDATE decisions SET status = 'active', review_status = 'approved' WHERE id = ? RETURNING *`,
      [id],
    );

    const decision = parseDecision(result.rows[0] as Record<string, unknown>);

    logAudit('decision_approved', decision.project_id, { decision_id: decision.id });

    // Trigger all creation side effects that were skipped for pending
    propagateChange(decision, 'decision_created' as NotificationType).catch((err) =>
      console.error('[nexus] Change propagation failed:', (err as Error).message),
    );

    dispatchWebhooks(decision.project_id, 'decision_created', {
      decision_id: decision.id,
      title: decision.title,
      made_by: decision.made_by,
      approved_from_review: true,
    }).catch((err) => console.warn('[nexus:webhook]', (err as Error).message));

    checkForContradictions(decision).catch((err) =>
      console.error('[nexus] Contradiction check failed:', (err as Error).message),
    );

    // Generate embedding (fire-and-forget)
    const embeddingText = `${decision.title}\n${decision.description}\n${decision.reasoning}`;
    generateEmbedding(embeddingText).then((embedding) => {
      if (embedding) {
        db.query('UPDATE decisions SET embedding = ? WHERE id = ?', [
          `[${embedding.join(',')}]`,
          decision.id,
        ]).catch(() => {});
      }
    }).catch(() => {});

    return c.json(decision);
  });

  // ── Reject ────────────────────────────────────────────────────────────
  app.post('/api/decisions/:id/reject', async (c) => {
    const db = getDb();
    const id = requireUUID(c.req.param('id'), 'id');
    const body = await c.req.json<{ reason?: string }>().catch(() => ({ reason: undefined })) as { reason?: string };

    const existing = await db.query('SELECT * FROM decisions WHERE id = ?', [id]);
    if (existing.rows.length === 0) throw new NotFoundError('Decision', id);
    const dec = existing.rows[0] as Record<string, unknown>;

    // Store rejection reason in metadata
    let metadata: Record<string, unknown> = {};
    try {
      metadata = typeof dec.metadata === 'string' ? JSON.parse(dec.metadata as string) : (dec.metadata as Record<string, unknown>) ?? {};
    } catch { /* keep empty */ }
    if (body.reason) metadata.rejection_reason = body.reason;

    // Soft delete: mark as reverted + rejected
    const result = await db.query(
      `UPDATE decisions SET status = 'reverted', review_status = 'rejected', metadata = ? WHERE id = ? RETURNING *`,
      [JSON.stringify(metadata), id],
    );

    const decision = parseDecision(result.rows[0] as Record<string, unknown>);

    logAudit('decision_rejected', decision.project_id, {
      decision_id: decision.id,
      reason: body.reason,
    });

    return c.json(decision);
  });
}
