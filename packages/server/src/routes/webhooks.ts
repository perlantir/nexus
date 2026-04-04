import type { Hono } from 'hono';
import { getDb } from '@decigraph/core/db/index.js';
import { NotFoundError, ValidationError } from '@decigraph/core/types.js';
import { testWebhook } from '@decigraph/core/webhooks/index.js';
import { requireUUID, requireString, mapDbError, logAudit } from './validation.js';
import { randomUUID } from 'node:crypto';

const VALID_PLATFORMS = ['generic', 'slack', 'discord', 'telegram'] as const;
const VALID_EVENTS = [
  'decision_created',
  'decision_superseded',
  'decision_reverted',
  'contradiction_detected',
  'distillery_completed',
  'scan_completed',
] as const;

function validatePlatform(val: unknown): string {
  if (typeof val !== 'string' || !(VALID_PLATFORMS as readonly string[]).includes(val)) {
    throw new ValidationError(
      `platform must be one of: ${VALID_PLATFORMS.join(', ')}`,
    );
  }
  return val;
}

function validateEvents(val: unknown): string[] {
  if (!Array.isArray(val)) throw new ValidationError('events must be an array');
  for (const e of val) {
    if (typeof e !== 'string' || !(VALID_EVENTS as readonly string[]).includes(e)) {
      throw new ValidationError(
        `Invalid event "${e}". Valid events: ${VALID_EVENTS.join(', ')}`,
      );
    }
  }
  return val as string[];
}

export function registerWebhookRoutes(app: Hono): void {
  // ── LIST ──────────────────────────────────────────────────────────────────
  app.get('/api/projects/:id/webhooks', async (c) => {
    const db = getDb();
    const projectId = requireUUID(c.req.param('id'), 'projectId');

    const result = await db.query(
      'SELECT * FROM webhook_configs WHERE project_id = ? ORDER BY created_at DESC',
      [projectId],
    );

    return c.json(result.rows);
  });

  // ── CREATE ────────────────────────────────────────────────────────────────
  app.post('/api/projects/:id/webhooks', async (c) => {
    const db = getDb();
    const projectId = requireUUID(c.req.param('id'), 'projectId');
    const body = await c.req.json<{
      name?: unknown;
      url?: unknown;
      platform?: unknown;
      events?: unknown;
      secret?: unknown;
      metadata?: unknown;
    }>();

    const name = requireString(body.name, 'name', 200);
    const url = requireString(body.url, 'url', 2000);
    const platform = body.platform != null ? validatePlatform(body.platform) : 'generic';
    const events = body.events != null ? validateEvents(body.events) : [];
    const secret = body.secret != null ? requireString(body.secret, 'secret', 500) : null;
    const metadata = body.metadata ?? {};

    const id = randomUUID();

    try {
      const result = await db.query(
        `INSERT INTO webhook_configs (id, project_id, name, url, platform, events, enabled, secret, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
        [
          id,
          projectId,
          name,
          url,
          platform,
          db.arrayParam(events),
          db.dialect === 'sqlite' ? 1 : true,
          secret,
          JSON.stringify(metadata),
        ],
      );

      logAudit('webhook_created', projectId, { webhook_id: id, name, platform });

      return c.json(result.rows[0], 201);
    } catch (err) {
      mapDbError(err);
    }
  });

  // ── UPDATE ────────────────────────────────────────────────────────────────
  app.patch('/api/projects/:id/webhooks/:whId', async (c) => {
    const db = getDb();
    const projectId = requireUUID(c.req.param('id'), 'projectId');
    const whId = requireUUID(c.req.param('whId'), 'webhookId');
    const body = await c.req.json<{
      name?: unknown;
      url?: unknown;
      platform?: unknown;
      events?: unknown;
      enabled?: unknown;
      secret?: unknown;
      metadata?: unknown;
    }>();

    // Build dynamic SET clause
    const sets: string[] = [];
    const params: unknown[] = [];

    if (body.name != null) {
      sets.push('name = ?');
      params.push(requireString(body.name, 'name', 200));
    }
    if (body.url != null) {
      sets.push('url = ?');
      params.push(requireString(body.url, 'url', 2000));
    }
    if (body.platform != null) {
      sets.push('platform = ?');
      params.push(validatePlatform(body.platform));
    }
    if (body.events != null) {
      sets.push('events = ?');
      params.push(db.arrayParam(validateEvents(body.events)));
    }
    if (body.enabled != null) {
      sets.push('enabled = ?');
      const enabled = body.enabled;
      params.push(db.dialect === 'sqlite' ? (enabled ? 1 : 0) : enabled);
    }
    if (body.secret !== undefined) {
      sets.push('secret = ?');
      params.push(body.secret != null ? requireString(body.secret, 'secret', 500) : null);
    }
    if (body.metadata != null) {
      sets.push('metadata = ?');
      params.push(JSON.stringify(body.metadata));
    }

    if (sets.length === 0) {
      throw new ValidationError('No fields to update');
    }

    params.push(whId, projectId);
    const result = await db.query(
      `UPDATE webhook_configs SET ${sets.join(', ')} WHERE id = ? AND project_id = ? RETURNING *`,
      params,
    );

    if (result.rows.length === 0) throw new NotFoundError('Webhook', whId);

    logAudit('webhook_updated', projectId, { webhook_id: whId });

    return c.json(result.rows[0]);
  });

  // ── DELETE ────────────────────────────────────────────────────────────────
  app.delete('/api/projects/:id/webhooks/:whId', async (c) => {
    const db = getDb();
    const projectId = requireUUID(c.req.param('id'), 'projectId');
    const whId = requireUUID(c.req.param('whId'), 'webhookId');

    const result = await db.query(
      'DELETE FROM webhook_configs WHERE id = ? AND project_id = ? RETURNING *',
      [whId, projectId],
    );

    if (result.rows.length === 0) throw new NotFoundError('Webhook', whId);

    logAudit('webhook_deleted', projectId, { webhook_id: whId });

    return c.json({ deleted: true });
  });

  // ── TEST ──────────────────────────────────────────────────────────────────
  app.post('/api/projects/:id/webhooks/:whId/test', async (c) => {
    const projectId = requireUUID(c.req.param('id'), 'projectId');
    const whId = requireUUID(c.req.param('whId'), 'webhookId');

    const result = await testWebhook(whId, projectId);
    return c.json(result);
  });
}
