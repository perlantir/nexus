/**
 * API Keys Routes — CRUD + rotate.
 * Key format: dg_live_* or dg_test_* + 32 random hex bytes.
 * Only the SHA-256 hash is stored. Full key returned once on creation.
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '@decigraph/core/db/index.js';
import { phase3AuthMiddleware, requireRole, getUser } from '../auth/middleware.js';
import { requireUUID } from './validation.js';
import crypto from 'node:crypto';

// ── Zod Schemas ─────────────────────────────────────────────────────
const createKeySchema = z.object({
  name: z.string().min(1).max(200),
  project_id: z.string().uuid().optional(),
  permissions: z.enum(['read', 'read_write', 'admin']).default('read'),
  environment: z.enum(['live', 'test']).default('live'),
  expires_in_days: z.number().int().min(1).max(365).optional(),
});

// ── Helpers ─────────────────────────────────────────────────────────
function generateApiKey(environment: 'live' | 'test'): { key: string; prefix: string; hash: string } {
  const randomPart = crypto.randomBytes(32).toString('hex');
  const prefix = `dg_${environment}_`;
  const key = `${prefix}${randomPart}`;
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  return { key, prefix, hash };
}

function logAudit(tenantId: string, userId: string, action: string, resourceType: string, resourceId: string | null, details: Record<string, unknown>, ip: string): void {
  getDb().query(
    `INSERT INTO audit_log_v2 (tenant_id, user_id, action, resource_type, resource_id, details, ip_address)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [tenantId, userId, action, resourceType, resourceId, JSON.stringify(details), ip],
  ).catch((err: Error) => console.error('[decigraph:api-keys] Audit error:', err.message));
}

export function registerApiKeyRoutes(app: Hono): void {
  // POST /api/keys — create API key (returns full key ONCE)
  app.post('/api/keys', phase3AuthMiddleware, requireRole('owner', 'admin'), async (c) => {
    const body = await c.req.json();
    const parsed = createKeySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.errors[0]?.message ?? 'Invalid input' } }, 400);
    }

    const user = getUser(c);
    const { name, project_id, permissions, environment, expires_in_days } = parsed.data;
    const { key, prefix, hash } = generateApiKey(environment);
    const db = getDb();

    const expiresAt = expires_in_days
      ? new Date(Date.now() + expires_in_days * 24 * 60 * 60_000).toISOString()
      : null;

    const planLimit = user.plan === 'enterprise' ? 10_000 : user.plan === 'pro' ? 1_000 : 100;

    const result = await db.query(
      `INSERT INTO api_keys (tenant_id, project_id, name, key_hash, key_prefix, permissions, rate_limit, expires_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id, name, key_prefix, permissions, rate_limit, expires_at, created_at`,
      [user.tenant_id, project_id ?? null, name, hash, prefix, permissions, planLimit, expiresAt, user.id],
    );

    const created = result.rows[0] as Record<string, unknown>;
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    logAudit(user.tenant_id, user.id, 'api_key_created', 'api_key', created.id as string, { name, permissions }, ip);

    return c.json({
      ...created,
      key, // Full key returned ONCE
      warning: 'Store this key securely. It will not be shown again.',
    }, 201);
  });

  // GET /api/keys — list keys (prefix only, never full key)
  app.get('/api/keys', phase3AuthMiddleware, requireRole('owner', 'admin'), async (c) => {
    const user = getUser(c);
    const db = getDb();

    const result = await db.query(
      `SELECT id, name, key_prefix, permissions, rate_limit, last_used_at, expires_at, created_at
       FROM api_keys
       WHERE tenant_id = ?
       ORDER BY created_at DESC`,
      [user.tenant_id],
    );

    return c.json(result.rows);
  });

  // DELETE /api/keys/:id — revoke key
  app.delete('/api/keys/:id', phase3AuthMiddleware, requireRole('owner', 'admin'), async (c) => {
    const user = getUser(c);
    const keyId = requireUUID(c.req.param('id'), 'id');
    const db = getDb();

    const result = await db.query(
      'DELETE FROM api_keys WHERE id = ? AND tenant_id = ? RETURNING id, name',
      [keyId, user.tenant_id],
    );

    if (result.rows.length === 0) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'API key not found' } }, 404);
    }

    const deleted = result.rows[0] as Record<string, unknown>;
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    logAudit(user.tenant_id, user.id, 'api_key_revoked', 'api_key', keyId, { name: deleted.name }, ip);

    return c.json({ message: 'API key revoked', id: keyId });
  });

  // POST /api/keys/:id/rotate — rotate key (invalidate old, return new)
  app.post('/api/keys/:id/rotate', phase3AuthMiddleware, requireRole('owner', 'admin'), async (c) => {
    const user = getUser(c);
    const keyId = requireUUID(c.req.param('id'), 'id');
    const db = getDb();

    // Get existing key info
    const existing = await db.query(
      'SELECT * FROM api_keys WHERE id = ? AND tenant_id = ?',
      [keyId, user.tenant_id],
    );

    if (existing.rows.length === 0) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'API key not found' } }, 404);
    }

    const old = existing.rows[0] as Record<string, unknown>;
    const env = (old.key_prefix as string).startsWith('dg_live_') ? 'live' as const : 'test' as const;
    const { key, prefix, hash } = generateApiKey(env);

    // Update the hash and prefix
    await db.query(
      `UPDATE api_keys SET key_hash = ?, key_prefix = ?, last_used_at = NULL WHERE id = ?`,
      [hash, prefix, keyId],
    );

    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    logAudit(user.tenant_id, user.id, 'api_key_rotated', 'api_key', keyId, { name: old.name }, ip);

    return c.json({
      id: keyId,
      key, // New full key returned ONCE
      key_prefix: prefix,
      warning: 'Store this key securely. The old key has been invalidated.',
    });
  });
}
