import type { Hono } from 'hono';
import { query } from '@nexus/core/db/pool.js';
import { distill } from '@nexus/core/distillery/index.js';
import { scanProjectContradictions } from '@nexus/core/contradiction-detector/index.js';
import {
  requireUUID,
  requireString,
  mapDbError,
  logAudit,
} from './validation.js';

import crypto from 'node:crypto';

function getNexusApiKey(): string | undefined {
  return process.env.NEXUS_API_KEY;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  const len = Math.max(bufA.length, bufB.length);
  const paddedA = Buffer.concat([bufA, Buffer.alloc(Math.max(0, len - bufA.length))]);
  const paddedB = Buffer.concat([bufB, Buffer.alloc(Math.max(0, len - bufB.length))]);
  return crypto.timingSafeEqual(paddedA, paddedB) && bufA.length === bufB.length;
}

export function registerDiscoveryRoutes(app: Hono): void {
  // POST /api/projects/:id/import — Bulk import conversation transcripts
  app.post('/api/projects/:id/import', async (c) => {
    const projectId = requireUUID(c.req.param('id'), 'projectId');

    const body = await c.req.json<{
      conversations?: unknown;
    }>();

    if (!Array.isArray(body.conversations)) {
      return c.json({ error: 'conversations must be an array' }, 400);
    }

    const conversations = body.conversations as Array<{
      text?: unknown;
      agent_name?: unknown;
      source_id?: unknown;
    }>;

    let processed = 0;
    let decisions_extracted = 0;
    let errors = 0;
    const results: Array<{
      source_id: string;
      decisions_extracted: number;
      error?: string;
    }> = [];

    for (let i = 0; i < conversations.length; i++) {
      const conv = conversations[i];
      const sourceId =
        typeof conv.source_id === 'string' && conv.source_id.trim()
          ? conv.source_id.trim()
          : `import-${i}`;

      let text: string;
      try {
        text = requireString(conv.text, `conversations[${i}].text`, 200000);
      } catch (err) {
        errors++;
        results.push({
          source_id: sourceId,
          decisions_extracted: 0,
          error: (err as Error).message,
        });
        continue;
      }

      const agentName =
        typeof conv.agent_name === 'string' && conv.agent_name.trim()
          ? conv.agent_name.trim()
          : 'import';

      try {
        const result = await distill(projectId, text, agentName);
        processed++;
        decisions_extracted += result.decisions_extracted;
        results.push({
          source_id: sourceId,
          decisions_extracted: result.decisions_extracted,
        });
      } catch (err) {
        errors++;
        results.push({
          source_id: sourceId,
          decisions_extracted: 0,
          error: (err as Error).message,
        });
      }
    }

    logAudit('bulk_import_completed', projectId, {
      processed,
      decisions_extracted,
      errors,
      total: conversations.length,
    });

    return c.json({ processed, decisions_extracted, errors, results });
  });

  // POST /api/ingest/webhook — Webhook receiver
  app.post('/api/ingest/webhook', async (c) => {
    // Bearer token auth (independent of session auth)
    const apiKey = getNexusApiKey();
    if (apiKey) {
      const authHeader = c.req.header('Authorization') ?? '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (!safeEqual(token, apiKey)) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
    }

    const body = await c.req.json<{
      text?: unknown;
      agent_name?: unknown;
      source_id?: unknown;
      project_id?: unknown;
      metadata?: Record<string, unknown>;
    }>();

    let text: string;
    let sourceId: string;
    let projectId: string;

    try {
      text = requireString(body.text, 'text', 200000);
      sourceId = requireString(body.source_id, 'source_id', 500);
      projectId = requireUUID(body.project_id, 'project_id');
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }

    const agentName =
      typeof body.agent_name === 'string' && body.agent_name.trim()
        ? body.agent_name.trim()
        : 'webhook';

    // Fire-and-forget: process via distill (acts as processChunk)
    distill(projectId, text, agentName)
      .then((result) => {
        logAudit('webhook_processed', projectId, {
          source_id: sourceId,
          decisions_extracted: result.decisions_extracted,
          agent_name: agentName,
        });
      })
      .catch((err: unknown) => {
        console.error('[nexus] Webhook processing failed:', (err as Error).message);
      });

    return c.json({ queued: true, source_id: sourceId });
  });

  // GET /api/projects/:id/connectors — List configured connectors
  app.get('/api/projects/:id/connectors', async (c) => {
    const projectId = requireUUID(c.req.param('id'), 'projectId');

    const result = await query(
      `SELECT * FROM connector_configs WHERE project_id = $1 ORDER BY created_at ASC`,
      [projectId],
    );

    return c.json(result.rows);
  });

  // POST /api/projects/:id/connectors — Add/update connector config
  app.post('/api/projects/:id/connectors', async (c) => {
    const projectId = requireUUID(c.req.param('id'), 'projectId');

    const body = await c.req.json<{
      connector_name?: unknown;
      enabled?: unknown;
      config?: unknown;
    }>();

    let connectorName: string;
    try {
      connectorName = requireString(body.connector_name, 'connector_name', 200);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }

    const enabled = body.enabled !== false; // default true
    const config =
      body.config !== null && typeof body.config === 'object' && !Array.isArray(body.config)
        ? (body.config as Record<string, unknown>)
        : {};

    try {
      const result = await query(
        `INSERT INTO connector_configs (project_id, connector_name, enabled, config)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (project_id, connector_name) DO UPDATE
           SET enabled = EXCLUDED.enabled,
               config = EXCLUDED.config,
               updated_at = NOW()
         RETURNING *`,
        [projectId, connectorName, enabled, JSON.stringify(config)],
      );

      logAudit('connector_upserted', projectId, {
        connector_name: connectorName,
        enabled,
      });

      return c.json(result.rows[0], 201);
    } catch (err) {
      mapDbError(err);
    }
  });

  // DELETE /api/projects/:id/connectors/:name — Remove connector
  app.delete('/api/projects/:id/connectors/:name', async (c) => {
    const projectId = requireUUID(c.req.param('id'), 'projectId');
    const connectorName = c.req.param('name');

    if (!connectorName || connectorName.trim().length === 0) {
      return c.json({ error: 'connector name is required' }, 400);
    }

    const result = await query(
      `DELETE FROM connector_configs WHERE project_id = $1 AND connector_name = $2 RETURNING id`,
      [projectId, connectorName],
    );

    if (result.rows.length === 0) {
      return c.json({ error: 'Connector not found' }, 404);
    }

    logAudit('connector_deleted', projectId, { connector_name: connectorName });

    return c.json({ deleted: true, connector_name: connectorName });
  });

  // GET /api/projects/:id/discovery/status — Auto-discovery health/stats
  app.get('/api/projects/:id/discovery/status', async (c) => {
    const projectId = requireUUID(c.req.param('id'), 'projectId');

    const [connectorsResult, countResult, recentResult] = await Promise.all([
      query(
        `SELECT connector_name, enabled, last_poll_at
         FROM connector_configs
         WHERE project_id = $1
         ORDER BY connector_name ASC`,
        [projectId],
      ),
      query(
        `SELECT COUNT(*) AS count FROM processed_sources WHERE project_id = $1`,
        [projectId],
      ),
      query(
        `SELECT * FROM processed_sources
         WHERE project_id = $1
         ORDER BY processed_at DESC
         LIMIT 20`,
        [projectId],
      ),
    ]);

    const processed_count = parseInt(
      (connectorsResult.rows.length >= 0
        ? (countResult.rows[0] as Record<string, unknown>)?.count
        : '0') as string,
      10,
    );

    return c.json({
      connectors: connectorsResult.rows.map((r) => {
        const row = r as Record<string, unknown>;
        return {
          name: row.connector_name,
          enabled: row.enabled,
          last_poll_at: row.last_poll_at ?? null,
        };
      }),
      processed_count,
      recent_sources: recentResult.rows,
    });
  });

  // POST /api/projects/:id/scan-contradictions — One-time contradiction scan
  app.post('/api/projects/:id/scan-contradictions', async (c) => {
    const projectId = requireUUID(c.req.param('id'), 'projectId');

    try {
      const result = await scanProjectContradictions(projectId);

      logAudit('contradiction_scan_completed', projectId, {
        pairs_checked: result.pairs_checked,
        contradictions_found: result.contradictions_found,
      });

      return c.json(result);
    } catch (err) {
      console.error('[nexus] Contradiction scan failed:', (err as Error).message);
      return c.json({ error: 'Contradiction scan failed', details: (err as Error).message }, 500);
    }
  });
}
