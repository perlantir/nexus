import type { Hono } from 'hono';
import { getDb } from '@decigraph/core/db/index.js';
import { parseAgent } from '@decigraph/core/db/parsers.js';
import { NotFoundError } from '@decigraph/core/types.js';
import { getRoleProfile } from '@decigraph/core/roles.js';
import { requireUUID, requireString, mapDbError } from './validation.js';
import { randomUUID } from 'node:crypto';

export function registerAgentRoutes(app: Hono): void {
  app.post('/api/projects/:id/agents', async (c) => {
    const db = getDb();
    const projectId = requireUUID(c.req.param('id'), 'projectId');
    const body = await c.req.json<{
      name?: unknown;
      role?: unknown;
      relevance_profile?: Record<string, unknown>;
      context_budget_tokens?: number;
    }>();

    const name = requireString(body.name, 'name', 200);
    const role = requireString(body.role, 'role', 100);

    const proj = await db.query('SELECT id FROM projects WHERE id = ?', [projectId]);
    if (proj.rows.length === 0) throw new NotFoundError('Project', projectId);

    const profile = body.relevance_profile ?? getRoleProfile(role);

    try {
      const result = await db.query(
        `INSERT INTO agents (project_id, name, role, relevance_profile, context_budget_tokens)
         VALUES (?, ?, ?, ?, ?)
         RETURNING *`,
        [projectId, name, role, JSON.stringify(profile), body.context_budget_tokens ?? 50000],
      );
      const agent = parseAgent(result.rows[0] as Record<string, unknown>);

      // Record initial weight snapshot for time travel
      try {
        const weights = typeof profile === 'string' ? JSON.parse(profile)?.weights ?? {} : (profile as Record<string, unknown>)?.weights ?? {};
        await db.query(
          `INSERT INTO weight_snapshots (id, agent_id, weights, snapshot_at)
           VALUES (?, ?, ?, ?)`,
          [randomUUID(), agent.id, JSON.stringify(weights), new Date().toISOString()],
        );
      } catch { /* weight_snapshots table may not exist yet */ }

      return c.json(agent, 201);
    } catch (err) {
      mapDbError(err);
    }
  });

  app.get('/api/projects/:id/agents', async (c) => {
    const db = getDb();
    const projectId = requireUUID(c.req.param('id'), 'projectId');
    const result = await db.query(
      'SELECT * FROM agents WHERE project_id = ? ORDER BY created_at ASC',
      [projectId],
    );
    return c.json(result.rows.map((r) => parseAgent(r as Record<string, unknown>)));
  });
}
