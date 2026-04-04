import type { Hono } from 'hono';
import { getDb } from '@decigraph/core/db/index.js';
import { parseFeedback } from '@decigraph/core/db/parsers.js';
import { ValidationError } from '@decigraph/core/types.js';
import {
  recordFeedback,
  recordBatchFeedback,
  getFeedbackForAgent,
  computeAndApplyWeightUpdates,
  getWeightSuggestions,
  resetWeights,
  getWeightHistory,
} from '@decigraph/core/relevance-learner/index.js';
import { requireUUID, requireString, optionalString, mapDbError, logAudit } from './validation.js';
import { randomUUID } from 'node:crypto';

const VALID_RATINGS = ['useful', 'irrelevant', 'critical', 'missing'] as const;

export function registerFeedbackRoutes(app: Hono): void {
  // ── Single feedback ─────────────────────────────────────────────────────
  app.post('/api/feedback', async (c) => {
    const body = await c.req.json<{
      agent_id?: unknown;
      decision_id?: unknown;
      compile_request_id?: unknown;
      rating?: unknown;
      was_useful?: boolean;
      usage_signal?: unknown;
      task_description?: unknown;
      notes?: unknown;
    }>();

    const agent_id = requireUUID(body.agent_id, 'agent_id');
    const decision_id = requireUUID(body.decision_id, 'decision_id');

    // Support both new rating system and old was_useful boolean
    const rating = body.rating as string | undefined;
    if (rating && !(VALID_RATINGS as readonly string[]).includes(rating)) {
      throw new ValidationError(`rating must be one of: ${VALID_RATINGS.join(', ')}`);
    }

    const wasUseful = rating
      ? (rating === 'useful' || rating === 'critical')
      : body.was_useful;
    if (wasUseful === undefined && !rating) {
      throw new ValidationError('Either rating or was_useful is required');
    }

    const compile_request_id =
      body.compile_request_id != null
        ? requireUUID(body.compile_request_id, 'compile_request_id')
        : null;

    try {
      const result = await recordFeedback({
        agent_id,
        decision_id,
        compile_request_id: compile_request_id ?? undefined,
        was_useful: wasUseful ?? true,
        usage_signal: optionalString(body.usage_signal, 'usage_signal', 100),
        rating,
        task_description: optionalString(body.task_description, 'task_description', 1000),
        notes: optionalString(body.notes, 'notes', 5000),
      } as Record<string, unknown> as any);

      // Check for auto-apply threshold
      checkAutoApply(agent_id).catch(() => {});

      return c.json(result, 201);
    } catch (err) {
      mapDbError(err);
    }
  });

  // ── Batch feedback ──────────────────────────────────────────────────────
  app.post('/api/feedback/batch', async (c) => {
    const body = await c.req.json<{
      agent_id?: unknown;
      compile_request_id?: unknown;
      task_description?: unknown;
      ratings?: unknown;
    }>();

    const agent_id = requireUUID(body.agent_id, 'agent_id');
    const compile_request_id =
      body.compile_request_id != null
        ? requireUUID(body.compile_request_id, 'compile_request_id')
        : undefined;
    const task_description = optionalString(body.task_description, 'task_description', 1000);

    if (!Array.isArray(body.ratings) || body.ratings.length === 0) {
      throw new ValidationError('ratings must be a non-empty array');
    }

    const ratings = (body.ratings as Array<{ decision_id: unknown; rating: unknown }>).map((r) => {
      const decision_id = requireUUID(r.decision_id, 'decision_id');
      const rating = r.rating as string;
      if (!(VALID_RATINGS as readonly string[]).includes(rating)) {
        throw new ValidationError(`Invalid rating "${rating}" for decision ${decision_id}`);
      }
      return { decision_id, rating };
    });

    const result = await recordBatchFeedback(agent_id, compile_request_id, task_description, ratings);

    // Check for auto-apply
    checkAutoApply(agent_id).catch(() => {});

    return c.json(result, 201);
  });

  // ── Feedback history ────────────────────────────────────────────────────
  app.get('/api/agents/:id/feedback', async (c) => {
    const agentId = requireUUID(c.req.param('id'), 'agentId');
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 200);
    const feedback = await getFeedbackForAgent(agentId, limit);
    return c.json(feedback);
  });

  // ── Weight suggestions (manual mode) ────────────────────────────────────
  app.get('/api/agents/:id/weight-suggestions', async (c) => {
    const agentId = requireUUID(c.req.param('id'), 'agentId');
    const suggestions = await getWeightSuggestions(agentId);
    return c.json({ agent_id: agentId, suggestions });
  });

  // ── Apply weights ───────────────────────────────────────────────────────
  app.post('/api/agents/:id/apply-weights', async (c) => {
    const agentId = requireUUID(c.req.param('id'), 'agentId');
    const updates = await computeAndApplyWeightUpdates(agentId);
    logAudit('weights_applied', agentId, { updates_count: updates.length });
    return c.json({ agent_id: agentId, updates });
  });

  // ── Reset weights ───────────────────────────────────────────────────────
  app.post('/api/agents/:id/reset-weights', async (c) => {
    const agentId = requireUUID(c.req.param('id'), 'agentId');
    const profile = await resetWeights(agentId);
    logAudit('weights_reset', agentId, {});
    return c.json({ agent_id: agentId, weights: profile.weights });
  });

  // ── Weight history ──────────────────────────────────────────────────────
  app.get('/api/agents/:id/weight-history', async (c) => {
    const agentId = requireUUID(c.req.param('id'), 'agentId');
    const limit = Math.min(parseInt(c.req.query('limit') ?? '20', 10), 100);
    const history = await getWeightHistory(agentId, limit);
    return c.json(history);
  });
}

// ---------------------------------------------------------------------------
// Auto-apply check
// ---------------------------------------------------------------------------

const feedbackCounters = new Map<string, number>();

async function checkAutoApply(agentId: string): Promise<void> {
  const count = (feedbackCounters.get(agentId) ?? 0) + 1;
  feedbackCounters.set(agentId, count);

  if (count >= 10) {
    feedbackCounters.set(agentId, 0);
    try {
      // Check if project is in auto mode (default)
      const db = getDb();
      const agentResult = await db.query<{ project_id: string }>(
        'SELECT project_id FROM agents WHERE id = ?',
        [agentId],
      );
      if (agentResult.rows.length === 0) return;

      const projResult = await db.query<{ metadata: unknown }>(
        'SELECT metadata FROM projects WHERE id = ?',
        [agentResult.rows[0].project_id],
      );
      if (projResult.rows.length === 0) return;

      let metadata: Record<string, unknown> = {};
      const raw = projResult.rows[0].metadata;
      if (typeof raw === 'string') try { metadata = JSON.parse(raw); } catch {}
      else if (raw && typeof raw === 'object') metadata = raw as Record<string, unknown>;

      const mode = (metadata.learning_mode as string) ?? 'auto';
      if (mode === 'auto') {
        await computeAndApplyWeightUpdates(agentId);
      }
    } catch (err) {
      console.warn('[decigraph:learner] Auto-apply failed:', (err as Error).message);
    }
  }
}
