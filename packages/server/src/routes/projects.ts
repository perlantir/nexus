import type { Hono } from 'hono';
import { getDb } from '@decigraph/core/db/index.js';
import { parseProject } from '@decigraph/core/db/parsers.js';
import { NotFoundError } from '@decigraph/core/types.js';
import { requireUUID, requireString, optionalString, mapDbError } from './validation.js';

export function registerProjectRoutes(app: Hono): void {
  app.post('/api/projects', async (c) => {
    const db = getDb();
    const body = await c.req.json<{
      name?: unknown;
      description?: unknown;
      metadata?: Record<string, unknown>;
    }>();

    const name = requireString(body.name, 'name', 500);
    const description = optionalString(body.description, 'description', 10000);

    try {
      const result = await db.query(
        `INSERT INTO projects (name, description, metadata)
         VALUES (?, ?, ?)
         RETURNING *`,
        [name, description ?? null, JSON.stringify(body.metadata ?? {})],
      );
      return c.json(parseProject(result.rows[0] as Record<string, unknown>), 201);
    } catch (err) {
      mapDbError(err);
    }
  });

  app.get('/api/projects/:id', async (c) => {
    const db = getDb();
    const id = requireUUID(c.req.param('id'), 'id');
    const result = await db.query('SELECT * FROM projects WHERE id = ?', [id]);
    if (result.rows.length === 0) throw new NotFoundError('Project', id);
    return c.json(parseProject(result.rows[0] as Record<string, unknown>));
  });
}
