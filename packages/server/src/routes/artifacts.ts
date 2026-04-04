import type { Hono } from 'hono';
import { getDb } from '@decigraph/core/db/index.js';
import { parseArtifact } from '@decigraph/core/db/parsers.js';
import { ValidationError } from '@decigraph/core/types.js';
import {
  requireUUID,
  requireString,
  optionalString,
  mapDbError,
  generateEmbedding,
} from './validation.js';

export function registerArtifactRoutes(app: Hono): void {
  app.post('/api/projects/:id/artifacts', async (c) => {
    const db = getDb();
    const projectId = requireUUID(c.req.param('id'), 'projectId');
    const body = await c.req.json<{
      name?: unknown;
      path?: unknown;
      artifact_type?: unknown;
      description?: unknown;
      content_summary?: unknown;
      content_hash?: unknown;
      produced_by?: unknown;
      related_decision_ids?: string[];
      metadata?: Record<string, unknown>;
    }>();

    const name = requireString(body.name, 'name', 500);
    const artifact_type = requireString(body.artifact_type, 'artifact_type', 100);
    const produced_by = requireString(body.produced_by, 'produced_by', 200);

    const validTypes = [
      'spec',
      'code',
      'design',
      'report',
      'config',
      'documentation',
      'test',
      'other',
    ];
    if (!validTypes.includes(artifact_type)) {
      throw new ValidationError(`artifact_type must be one of: ${validTypes.join(', ')}`);
    }

    const embeddingText = [name, body.description, body.content_summary]
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .join('\n');
    const embedding = embeddingText ? await generateEmbedding(embeddingText) : null;

    try {
      const result = await db.query(
        `INSERT INTO artifacts (
           project_id, name, path, artifact_type, description,
           content_summary, content_hash, produced_by,
           related_decision_ids, metadata, embedding
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
         RETURNING *`,
        [
          projectId,
          name,
          optionalString(body.path, 'path', 1000) ?? null,
          artifact_type,
          optionalString(body.description, 'description', 10000) ?? null,
          optionalString(body.content_summary, 'content_summary', 10000) ?? null,
          optionalString(body.content_hash, 'content_hash', 256) ?? null,
          produced_by,
          db.arrayParam(body.related_decision_ids ?? []),
          JSON.stringify(body.metadata ?? {}),
          embedding ? `[${embedding.join(',')}]` : null,
        ],
      );
      return c.json(parseArtifact(result.rows[0] as Record<string, unknown>), 201);
    } catch (err) {
      mapDbError(err);
    }
  });

  app.get('/api/projects/:id/artifacts', async (c) => {
    const db = getDb();
    const projectId = requireUUID(c.req.param('id'), 'projectId');
    const result = await db.query(
      'SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at DESC',
      [projectId],
    );
    return c.json(result.rows.map((r) => parseArtifact(r as Record<string, unknown>)));
  });
}
