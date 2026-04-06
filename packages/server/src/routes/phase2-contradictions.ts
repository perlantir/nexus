/**
 * Phase 2 Contradiction Routes
 *
 * Uses the phase2_contradictions table with the new schema:
 * confidence (high/medium/low), status (open/resolved/dismissed), resolution_note
 */
import type { Hono } from 'hono';
import { getDb } from '@decigraph/core/db/index.js';
import { NotFoundError, ValidationError } from '@decigraph/core/types.js';
import { requireUUID, optionalString } from './validation.js';

export function registerPhase2ContradictionRoutes(app: Hono): void {
  // GET /api/projects/:id/intelligence/contradictions — list open contradictions
  app.get('/api/projects/:id/intelligence/contradictions', async (c) => {
    const db = getDb();
    const projectId = requireUUID(c.req.param('id'), 'projectId');
    const status = c.req.query('status') ?? 'open';

    const result = await db.query(
      `SELECT c.*,
              da.title as decision_a_title, da.description as decision_a_description,
              db.title as decision_b_title, db.description as decision_b_description
       FROM phase2_contradictions c
       JOIN decisions da ON da.id = c.decision_a_id
       JOIN decisions db ON db.id = c.decision_b_id
       WHERE da.project_id = ? AND c.status = ?
       ORDER BY c.created_at DESC`,
      [projectId, status],
    );

    return c.json(result.rows);
  });

  // GET /api/projects/:id/intelligence/contradictions/:cid — get detail
  app.get('/api/projects/:id/intelligence/contradictions/:cid', async (c) => {
    const db = getDb();
    requireUUID(c.req.param('id'), 'projectId');
    const cid = requireUUID(c.req.param('cid'), 'contradictionId');

    const result = await db.query(
      `SELECT c.*,
              da.title as decision_a_title, da.description as decision_a_description,
              db.title as decision_b_title, db.description as decision_b_description
       FROM phase2_contradictions c
       JOIN decisions da ON da.id = c.decision_a_id
       JOIN decisions db ON db.id = c.decision_b_id
       WHERE c.id = ?`,
      [cid],
    );

    if (result.rows.length === 0) throw new NotFoundError('Contradiction', cid);
    return c.json(result.rows[0]);
  });

  // POST /api/projects/:id/intelligence/contradictions/:cid/resolve
  app.post('/api/projects/:id/intelligence/contradictions/:cid/resolve', async (c) => {
    const db = getDb();
    requireUUID(c.req.param('id'), 'projectId');
    const cid = requireUUID(c.req.param('cid'), 'contradictionId');

    const body = await c.req.json<{
      action?: unknown;
      resolved_by?: unknown;
      resolution_note?: unknown;
    }>();

    const action = optionalString(body.action, 'action', 50) ?? 'dismiss';
    const validActions = ['keep_a', 'keep_b', 'merge', 'dismiss'];
    if (!validActions.includes(action)) {
      throw new ValidationError(`action must be one of: ${validActions.join(', ')}`);
    }

    const resolvedBy = optionalString(body.resolved_by, 'resolved_by', 200) ?? 'system';
    const resolutionNote = optionalString(body.resolution_note, 'resolution_note', 5000) ?? '';

    const newStatus = action === 'dismiss' ? 'dismissed' : 'resolved';

    const result = await db.query(
      `UPDATE phase2_contradictions
       SET status = ?, resolved_by = ?, resolved_at = NOW(), resolution_note = ?
       WHERE id = ?
       RETURNING *`,
      [newStatus, resolvedBy, `[${action}] ${resolutionNote}`, cid],
    );

    if (result.rows.length === 0) throw new NotFoundError('Contradiction', cid);

    // If keep_a, supersede decision B; if keep_b, supersede decision A
    const contradiction = result.rows[0] as Record<string, unknown>;
    if (action === 'keep_a') {
      await db.query(
        "UPDATE decisions SET status = 'superseded', updated_at = NOW() WHERE id = ?",
        [contradiction.decision_b_id],
      );
    } else if (action === 'keep_b') {
      await db.query(
        "UPDATE decisions SET status = 'superseded', updated_at = NOW() WHERE id = ?",
        [contradiction.decision_a_id],
      );
    }

    return c.json(result.rows[0]);
  });
}
