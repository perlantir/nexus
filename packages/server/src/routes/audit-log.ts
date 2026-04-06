/**
 * Audit Log Routes — paginated, tenant-scoped audit log.
 * Reads from audit_log_v2 (Phase 3 tenant-aware table).
 */
import type { Hono } from 'hono';
import { phase3AuthMiddleware, requireRole, getUser } from '../auth/middleware.js';
import { getDb } from '@decigraph/core/db/index.js';

export function registerAuditLogRoutes(app: Hono): void {
  // GET /api/audit-log — paginated audit log
  app.get('/api/audit-log', phase3AuthMiddleware, requireRole('owner', 'admin'), async (c) => {
    const user = getUser(c);
    const db = getDb();

    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 500);
    const offset = Math.max(parseInt(c.req.query('offset') ?? '0', 10), 0);
    const action = c.req.query('action');
    const resourceType = c.req.query('resource_type');

    const conditions = ['tenant_id = ?'];
    const params: unknown[] = [user.tenant_id];

    if (action) {
      conditions.push('action = ?');
      params.push(action);
    }

    if (resourceType) {
      conditions.push('resource_type = ?');
      params.push(resourceType);
    }

    params.push(limit, offset);

    const result = await db.query(
      `SELECT * FROM audit_log_v2
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      params,
    );

    // Get total count for pagination
    const countResult = await db.query(
      `SELECT count(*) as total FROM audit_log_v2 WHERE ${conditions.join(' AND ')}`,
      params.slice(0, -2), // exclude LIMIT and OFFSET
    );
    const total = parseInt((countResult.rows[0] as Record<string, unknown>)?.total as string ?? '0', 10);

    return c.json({
      data: result.rows,
      pagination: { limit, offset, total },
    });
  });
}
