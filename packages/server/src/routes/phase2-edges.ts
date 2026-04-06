/**
 * Phase 2 Edge Routes
 *
 * Uses the phase2_decision_edges table with edge_type vocabulary:
 * depends_on, supersedes, related_to, blocks
 */
import type { Hono } from 'hono';
import { getDb } from '@decigraph/core/db/index.js';
import { NotFoundError, ValidationError } from '@decigraph/core/types.js';
import { requireUUID, requireString, optionalString } from './validation.js';

const VALID_EDGE_TYPES = ['depends_on', 'supersedes', 'related_to', 'blocks'] as const;

export function registerPhase2EdgeRoutes(app: Hono): void {
  // POST /api/projects/:id/decisions/:did/p2edges — create edge
  app.post('/api/projects/:id/decisions/:did/p2edges', async (c) => {
    const db = getDb();
    requireUUID(c.req.param('id'), 'projectId');
    const fromId = requireUUID(c.req.param('did'), 'decisionId');

    const body = await c.req.json<{
      to_decision_id?: unknown;
      edge_type?: unknown;
      created_by?: unknown;
    }>();

    const toId = requireUUID(body.to_decision_id, 'to_decision_id');
    const edgeType = requireString(body.edge_type, 'edge_type', 50);
    const createdBy = optionalString(body.created_by, 'created_by', 200) ?? null;

    if (!(VALID_EDGE_TYPES as readonly string[]).includes(edgeType)) {
      throw new ValidationError(`edge_type must be one of: ${VALID_EDGE_TYPES.join(', ')}`);
    }

    if (fromId === toId) {
      throw new ValidationError('Cannot create self-referencing edge');
    }

    // Verify both decisions exist
    const fromResult = await db.query('SELECT id FROM decisions WHERE id = ?', [fromId]);
    if (fromResult.rows.length === 0) throw new NotFoundError('Decision', fromId);

    const toResult = await db.query('SELECT id FROM decisions WHERE id = ?', [toId]);
    if (toResult.rows.length === 0) throw new NotFoundError('Decision', toId);

    const result = await db.query(
      `INSERT INTO phase2_decision_edges (from_decision_id, to_decision_id, edge_type, created_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (from_decision_id, to_decision_id, edge_type) DO NOTHING
       RETURNING *`,
      [fromId, toId, edgeType, createdBy],
    );

    if (result.rows.length === 0) {
      return c.json({ message: 'Edge already exists' }, 200);
    }

    return c.json(result.rows[0], 201);
  });

  // GET /api/projects/:id/decisions/:did/p2edges — list edges
  app.get('/api/projects/:id/decisions/:did/p2edges', async (c) => {
    const db = getDb();
    requireUUID(c.req.param('id'), 'projectId');
    const decisionId = requireUUID(c.req.param('did'), 'decisionId');

    const result = await db.query(
      `SELECT e.*,
              df.title as from_title,
              dt.title as to_title
       FROM phase2_decision_edges e
       JOIN decisions df ON df.id = e.from_decision_id
       JOIN decisions dt ON dt.id = e.to_decision_id
       WHERE e.from_decision_id = ? OR e.to_decision_id = ?
       ORDER BY e.created_at DESC`,
      [decisionId, decisionId],
    );

    return c.json(result.rows);
  });

  // DELETE /api/projects/:id/decisions/:did/p2edges/:eid — remove edge
  app.delete('/api/projects/:id/decisions/:did/p2edges/:eid', async (c) => {
    const db = getDb();
    requireUUID(c.req.param('id'), 'projectId');
    requireUUID(c.req.param('did'), 'decisionId');
    const edgeId = requireUUID(c.req.param('eid'), 'edgeId');

    const result = await db.query(
      'DELETE FROM phase2_decision_edges WHERE id = ? RETURNING id',
      [edgeId],
    );

    if (result.rows.length === 0) throw new NotFoundError('Edge', edgeId);
    return c.json({ deleted: true, id: edgeId });
  });

  // GET /api/projects/:id/decisions/:did/chain — full dependency chain (recursive)
  app.get('/api/projects/:id/decisions/:did/chain', async (c) => {
    const db = getDb();
    requireUUID(c.req.param('id'), 'projectId');
    const decisionId = requireUUID(c.req.param('did'), 'decisionId');
    const maxDepth = Math.min(parseInt(c.req.query('depth') ?? '5', 10), 10);

    // BFS to find full dependency chain
    const visited = new Set<string>();
    const chain: Array<{ id: string; title: string; edge_type: string; depth: number; direction: string }> = [];
    const queue: Array<{ id: string; depth: number }> = [{ id: decisionId, depth: 0 }];

    while (queue.length > 0) {
      const item = queue.shift()!;
      if (visited.has(item.id) || item.depth > maxDepth) continue;
      visited.add(item.id);

      const edges = await db.query(
        `SELECT e.*, df.title as from_title, dt.title as to_title
         FROM phase2_decision_edges e
         JOIN decisions df ON df.id = e.from_decision_id
         JOIN decisions dt ON dt.id = e.to_decision_id
         WHERE e.from_decision_id = ? OR e.to_decision_id = ?`,
        [item.id, item.id],
      );

      for (const row of edges.rows) {
        const edge = row as Record<string, unknown>;
        const isOutgoing = edge.from_decision_id === item.id;
        const neighborId = isOutgoing ? edge.to_decision_id as string : edge.from_decision_id as string;

        if (!visited.has(neighborId)) {
          chain.push({
            id: neighborId,
            title: (isOutgoing ? edge.to_title : edge.from_title) as string,
            edge_type: edge.edge_type as string,
            depth: item.depth + 1,
            direction: isOutgoing ? 'outgoing' : 'incoming',
          });
          queue.push({ id: neighborId, depth: item.depth + 1 });
        }
      }
    }

    return c.json({ decision_id: decisionId, chain });
  });
}
