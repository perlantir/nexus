import type { Hono } from 'hono';
import { getDb } from '@decigraph/core/db/index.js';
import { parseNotification, parseSubscription } from '@decigraph/core/db/parsers.js';
import { NotFoundError } from '@decigraph/core/types.js';
import { requireUUID, requireString, optionalString, mapDbError } from './validation.js';

export function registerNotificationRoutes(app: Hono): void {
  app.get('/api/agents/:id/notifications', async (c) => {
    const db = getDb();
    const agentId = requireUUID(c.req.param('id'), 'agentId');
    const unreadOnly = c.req.query('unread');

    let sql = 'SELECT * FROM notifications WHERE agent_id = ?';
    if (unreadOnly === 'true') sql += ' AND read_at IS NULL';
    sql += ' ORDER BY created_at DESC LIMIT 100';

    const result = await db.query(sql, [agentId]);
    return c.json(result.rows.map((r) => parseNotification(r as Record<string, unknown>)));
  });

  app.patch('/api/notifications/:id/read', async (c) => {
    const db = getDb();
    const id = requireUUID(c.req.param('id'), 'id');
    const result = await db.query(
      'UPDATE notifications SET read_at = NOW() WHERE id = ? RETURNING *',
      [id],
    );
    if (result.rows.length === 0) throw new NotFoundError('Notification', id);
    return c.json(parseNotification(result.rows[0] as Record<string, unknown>));
  });

  app.post('/api/agents/:id/subscriptions', async (c) => {
    const db = getDb();
    const agentId = requireUUID(c.req.param('id'), 'agentId');
    const body = await c.req.json<{
      topic?: unknown;
      notify_on?: string[];
      priority?: unknown;
    }>();

    const topic = requireString(body.topic, 'topic', 200);

    try {
      const result = await db.query(
        `INSERT INTO subscriptions (agent_id, topic, notify_on, priority)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (agent_id, topic) DO UPDATE
           SET notify_on = EXCLUDED.notify_on, priority = EXCLUDED.priority
         RETURNING *`,
        [
          agentId,
          topic,
          db.arrayParam(body.notify_on ?? ['update', 'supersede', 'revert']),
          optionalString(body.priority, 'priority', 50) ?? 'medium',
        ],
      );
      return c.json(parseSubscription(result.rows[0] as Record<string, unknown>), 201);
    } catch (err) {
      mapDbError(err);
    }
  });

  app.get('/api/agents/:id/subscriptions', async (c) => {
    const db = getDb();
    const agentId = requireUUID(c.req.param('id'), 'agentId');
    const result = await db.query(
      'SELECT * FROM subscriptions WHERE agent_id = ? ORDER BY created_at ASC',
      [agentId],
    );
    return c.json(result.rows.map((r) => parseSubscription(r as Record<string, unknown>)));
  });

  app.delete('/api/subscriptions/:id', async (c) => {
    const db = getDb();
    const id = requireUUID(c.req.param('id'), 'id');
    const result = await db.query('DELETE FROM subscriptions WHERE id = ? RETURNING id', [id]);
    if (result.rows.length === 0) throw new NotFoundError('Subscription', id);
    return c.json({ deleted: true, id });
  });
}
