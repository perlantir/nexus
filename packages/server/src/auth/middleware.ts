/**
 * Phase 3 Auth Middleware — Supabase JWT + API Key authentication.
 *
 * Three middleware variants:
 * - authMiddleware: Requires auth (401 if missing)
 * - optionalAuth: Attaches user if present, passes through if not
 * - apiKeyOrAuth: Accepts either Bearer JWT or dg_* API key
 *
 * Feature flag: DECIGRAPH_AUTH_REQUIRED (default: false)
 * When false, optionalAuth is used everywhere and defaults to the "nick" tenant.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { getDb } from '@decigraph/core/db/index.js';
import { getSupabase } from './supabase.js';
import crypto from 'node:crypto';

const DEFAULT_TENANT_ID = 'a0000000-0000-4000-8000-000000000001';

export function isAuthRequired(): boolean {
  return process.env.DECIGRAPH_AUTH_REQUIRED === 'true';
}

export interface AuthUser {
  id: string;
  email: string;
  tenant_id: string;
  role: string;
  plan: string;
}

function getClientIp(c: Context): string {
  return (
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    'unknown'
  );
}

// ── Free-tier IP tracking (50 requests without signup) ──────────────
const freeTierUsage = new Map<string, number>();

// Prune every 24 hours
setInterval(() => {
  freeTierUsage.clear();
}, 24 * 60 * 60_000).unref();

export function getFreeTierCount(ip: string): number {
  return freeTierUsage.get(ip) ?? 0;
}

export function incrementFreeTier(ip: string): number {
  const count = (freeTierUsage.get(ip) ?? 0) + 1;
  freeTierUsage.set(ip, count);
  return count;
}

// ── API Key Rate Limiting (sliding window) ──────────────────────────
interface SlidingWindowEntry {
  timestamps: number[];
}

const apiKeyRateLimitStore = new Map<string, SlidingWindowEntry>();

// Prune every 60s
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of apiKeyRateLimitStore) {
    entry.timestamps = entry.timestamps.filter((t) => t > now - 60_000);
    if (entry.timestamps.length === 0) apiKeyRateLimitStore.delete(key);
  }
}, 60_000).unref();

function checkApiKeyRateLimit(keyHash: string, maxPerMinute: number): { allowed: boolean; remaining: number; resetMs: number } {
  const now = Date.now();
  let entry = apiKeyRateLimitStore.get(keyHash);
  if (!entry) {
    entry = { timestamps: [] };
    apiKeyRateLimitStore.set(keyHash, entry);
  }

  // Remove timestamps older than 1 minute
  entry.timestamps = entry.timestamps.filter((t) => t > now - 60_000);
  const remaining = Math.max(0, maxPerMinute - entry.timestamps.length);

  if (entry.timestamps.length >= maxPerMinute) {
    const oldest = entry.timestamps[0] ?? now;
    return { allowed: false, remaining: 0, resetMs: oldest + 60_000 - now };
  }

  entry.timestamps.push(now);
  return { allowed: true, remaining: remaining - 1, resetMs: 60_000 };
}

// ── Resolve rate limit from plan ────────────────────────────────────
function planRateLimit(plan: string): number {
  switch (plan) {
    case 'enterprise': return 10_000;
    case 'pro': return 1_000;
    default: return 100;
  }
}

// ── Authenticate via API key (dg_live_* or dg_test_*) ───────────────
async function authenticateApiKey(token: string, c: Context): Promise<AuthUser | null> {
  if (!token.startsWith('dg_live_') && !token.startsWith('dg_test_')) return null;

  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const db = getDb();

  const result = await db.query(
    `SELECT ak.*, t.plan FROM api_keys ak
     JOIN tenants t ON t.id = ak.tenant_id
     WHERE ak.key_hash = ?`,
    [hash],
  );

  if (result.rows.length === 0) return null;

  const key = result.rows[0] as Record<string, unknown>;

  // Check expiry
  if (key.expires_at && new Date(key.expires_at as string) < new Date()) return null;

  // Rate limit check
  const maxRate = planRateLimit(key.plan as string);
  const rateCheck = checkApiKeyRateLimit(hash, maxRate);
  if (!rateCheck.allowed) {
    c.header('Retry-After', String(Math.ceil(rateCheck.resetMs / 1000)));
    c.header('X-RateLimit-Limit', String(maxRate));
    c.header('X-RateLimit-Remaining', '0');
    return null; // Will be treated as rate limited
  }

  // Update last_used_at (fire-and-forget)
  db.query('UPDATE api_keys SET last_used_at = NOW() WHERE id = ?', [key.id]).catch(() => {});

  return {
    id: key.created_by as string,
    email: '',
    tenant_id: key.tenant_id as string,
    role: key.permissions as string === 'admin' ? 'admin' : 'member',
    plan: key.plan as string,
  };
}

// ── Authenticate via Supabase JWT ───────────────────────────────────
async function authenticateJwt(token: string): Promise<AuthUser | null> {
  try {
    const supabase = getSupabase();
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) return null;

    const db = getDb();
    const membership = await db.query(
      `SELECT tm.tenant_id, tm.role, t.plan
       FROM tenant_members tm
       JOIN tenants t ON t.id = tm.tenant_id
       WHERE tm.user_id = ? AND tm.accepted_at IS NOT NULL
       LIMIT 1`,
      [user.id],
    );

    if (membership.rows.length === 0) return null;

    const member = membership.rows[0] as Record<string, unknown>;

    return {
      id: user.id,
      email: user.email ?? '',
      tenant_id: member.tenant_id as string,
      role: member.role as string,
      plan: member.plan as string,
    };
  } catch {
    return null;
  }
}

// ── Extract token from request ──────────────────────────────────────
function extractToken(c: Context): string | null {
  // Check Authorization header
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  // Check X-API-Key header
  const apiKey = c.req.header('X-API-Key');
  if (apiKey) return apiKey;

  return null;
}

// ── Authenticate from token (API key or JWT) ────────────────────────
async function authenticateToken(token: string, c: Context): Promise<AuthUser | null> {
  // Try API key first
  if (token.startsWith('dg_')) {
    return authenticateApiKey(token, c);
  }
  // Try JWT
  return authenticateJwt(token);
}

/**
 * Strict auth middleware — returns 401 if no valid auth.
 * When DECIGRAPH_AUTH_REQUIRED=false, defaults to nick tenant.
 */
export const phase3AuthMiddleware: MiddlewareHandler = createMiddleware(async (c, next) => {
  if (!isAuthRequired()) {
    // Feature flag off: default to nick tenant
    c.set('user', {
      id: 'anonymous',
      email: '',
      tenant_id: DEFAULT_TENANT_ID,
      role: 'owner',
      plan: 'enterprise',
    } satisfies AuthUser);
    await next();
    return;
  }

  const token = extractToken(c);
  if (!token) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const user = await authenticateToken(token, c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } }, 401);
  }

  c.set('user', user);
  await next();
});

/**
 * Optional auth — attaches user if present, defaults to nick tenant if not.
 * Used for backward compatibility when DECIGRAPH_AUTH_REQUIRED=false.
 */
export const optionalAuth: MiddlewareHandler = createMiddleware(async (c, next) => {
  const token = extractToken(c);

  if (token) {
    const user = await authenticateToken(token, c);
    if (user) {
      c.set('user', user);
      await next();
      return;
    }
  }

  // No auth or invalid — use default tenant
  c.set('user', {
    id: 'anonymous',
    email: '',
    tenant_id: DEFAULT_TENANT_ID,
    role: 'owner',
    plan: 'enterprise',
  } satisfies AuthUser);

  await next();
});

/**
 * Free-tier middleware for /api/compile — allows 50 requests without auth.
 */
export const freeTierOrAuth: MiddlewareHandler = createMiddleware(async (c, next) => {
  if (!isAuthRequired()) {
    c.set('user', {
      id: 'anonymous',
      email: '',
      tenant_id: DEFAULT_TENANT_ID,
      role: 'owner',
      plan: 'enterprise',
    } satisfies AuthUser);
    await next();
    return;
  }

  const token = extractToken(c);

  // If token provided, authenticate normally
  if (token) {
    const user = await authenticateToken(token, c);
    if (user) {
      c.set('user', user);
      await next();
      return;
    }
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } }, 401);
  }

  // No token — check free tier
  const ip = getClientIp(c);
  const count = getFreeTierCount(ip);

  if (count >= 50) {
    return c.json(
      {
        error: {
          code: 'FREE_TIER_EXCEEDED',
          message: 'Create a free account to continue. It takes 10 seconds.',
        },
      },
      429,
    );
  }

  incrementFreeTier(ip);

  c.set('user', {
    id: 'anonymous',
    email: '',
    tenant_id: DEFAULT_TENANT_ID,
    role: 'viewer',
    plan: 'free',
  } satisfies AuthUser);

  await next();
});

/**
 * Role-based authorization middleware.
 * Must be used after auth middleware.
 */
export function requireRole(...roles: string[]): MiddlewareHandler {
  return createMiddleware(async (c, next) => {
    const user = c.get('user') as AuthUser | undefined;
    if (!user) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
    }
    if (!roles.includes(user.role)) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } }, 403);
    }
    await next();
  });
}

/**
 * Helper to get the current user from context.
 */
export function getUser(c: Context): AuthUser {
  return c.get('user') as AuthUser;
}

/**
 * Helper to get tenant_id from context.
 */
export function getTenantId(c: Context): string {
  const user = c.get('user') as AuthUser | undefined;
  return user?.tenant_id ?? DEFAULT_TENANT_ID;
}
