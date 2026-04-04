import type { Context, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { DeciGraphError } from '@decigraph/core/types.js';
import { getDb } from '@decigraph/core/db/index.js';
import crypto from 'node:crypto';

// API key cached at startup — never re-read per request
const DECIGRAPH_API_KEY: string | undefined = process.env.DECIGRAPH_API_KEY;
function isDev(): boolean {
  return process.env.NODE_ENV !== 'production';
}

if (!DECIGRAPH_API_KEY) {
  console.warn('[decigraph] WARNING: DECIGRAPH_API_KEY is not set — running in unauthenticated dev mode');
}

// Timing-safe comparison that handles length mismatches without leaking length info.
// Both buffers are padded to the longer length before comparison; original lengths
// are checked separately to avoid short-circuit leaks.
function safeEqual(a: Buffer, b: Buffer): boolean {
  const len = Math.max(a.length, b.length);
  const paddedA = Buffer.concat([a, Buffer.alloc(Math.max(0, len - a.length))]);
  const paddedB = Buffer.concat([b, Buffer.alloc(Math.max(0, len - b.length))]);
  const timingSafe = crypto.timingSafeEqual(paddedA, paddedB);
  return timingSafe && a.length === b.length;
}

function getClientIp(c: Context): string {
  return (
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? 'unknown'
  );
}

// Sanitise PostgreSQL errors — strip table/column/constraint names
function sanitisePgError(err: unknown): string {
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as Record<string, unknown>).code === 'string'
  ) {
    const code = (err as Record<string, unknown>).code as string;
    // pg error codes: https://www.postgresql.org/docs/current/errcodes-appendix.html
    if (code.startsWith('23')) return 'Database constraint violation';
    if (code.startsWith('42')) return 'Database query error';
    if (code.startsWith('08')) return 'Database connection error';
    return 'Database error';
  }
  return 'Internal server error';
}

// Error Handler
export const errorHandler = (err: Error, c: Context) => {
  if (err instanceof DeciGraphError) {
    // 404 errors must not expose the route path
    if (err.statusCode === 404) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
    }
    return c.json(
      { error: { code: err.code, message: err.message, details: err.details } },
      err.statusCode as 400 | 401 | 403 | 409 | 422 | 500,
    );
  }

  // Log full error to stderr — never returned to the client
  console.error('[decigraph] Unhandled error:', err);

  // Check for PostgreSQL error shape
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as Record<string, unknown>).code === 'string'
  ) {
    const msg = sanitisePgError(err);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: msg } }, 500);
  }

  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500);
};

// Security Headers — applied to ALL responses
export const securityHeaders: MiddlewareHandler = createMiddleware(async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('X-XSS-Protection', '0');
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  c.header('Content-Security-Policy', "default-src 'self'");
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
});

// Request Timer
export const requestTimer: MiddlewareHandler = createMiddleware(async (c, next) => {
  const start = Date.now();
  await next();
  c.header('X-Response-Time', `${Date.now() - start}ms`);
});

// CORS Middleware
export const corsMiddleware: MiddlewareHandler = createMiddleware(async (c, next) => {
  const origin = c.req.header('Origin') ?? '';
  let allowOrigin: string;

  if (isDev()) {
    allowOrigin = origin || '*';
  } else {
    const allowed = (process.env.DECIGRAPH_CORS_ORIGINS ?? process.env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
    if (allowed.includes(origin)) {
      allowOrigin = origin;
    } else if (allowed.length === 0) {
      // No origins configured in production — deny cross-origin
      allowOrigin = 'null';
    } else {
      allowOrigin = allowed[0] ?? 'null';
    }
  }

  c.header('Access-Control-Allow-Origin', allowOrigin);
  c.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  c.header('Access-Control-Max-Age', '86400');

  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204);
  }

  await next();
});

// Auth Middleware
// Only /api/health is exempt. Everything else requires a valid Bearer token.
export const authMiddleware: MiddlewareHandler = createMiddleware(async (c, next) => {
  const path = new URL(c.req.url).pathname;

  if (path === '/api/health') {
    await next();
    return;
  }

  // Dev mode without a key set: skip auth entirely
  if (isDev() && !DECIGRAPH_API_KEY) {
    await next();
    return;
  }

  const authHeader = c.req.header('Authorization');
  const ip = getClientIp(c);

  const fail = async (message: string) => {
    // Audit auth failure with IP — never log the key value
    getDb().query(`INSERT INTO audit_log (event_type, details) VALUES (?, ?)`, [
      'auth_failure',
      JSON.stringify({ ip, path, reason: message }),
    ]).catch((e: Error) => console.error('[decigraph] audit_log write error:', e.message));

    return c.json({ error: { code: 'UNAUTHORIZED', message } }, 401);
  };

  if (!authHeader) {
    return fail('Authorization header required');
  }

  if (!authHeader.startsWith('Bearer ')) {
    return fail('Bearer token required');
  }

  const token = authHeader.slice(7);

  if (!DECIGRAPH_API_KEY) {
    // Key required in production but not set — reject
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500);
  }

  const tokenBuf = Buffer.from(token, 'utf8');
  const keyBuf = Buffer.from(DECIGRAPH_API_KEY, 'utf8');

  if (!safeEqual(tokenBuf, keyBuf)) {
    return fail('Invalid API key');
  }

  await next();
});

// Audit Middleware — async fire-and-forget after response is sent
export const auditMiddleware: MiddlewareHandler = createMiddleware(async (c, next) => {
  await next();

  const method = c.req.method;
  const path = new URL(c.req.url).pathname;
  const status = c.res.status;
  const projectId: string | undefined = c.get('projectId');

  // Hash task_description for compile requests instead of storing raw text
  let extra: Record<string, unknown> = {};
  if (method === 'POST' && path.endsWith('/compile')) {
    try {
      const body = (await c.req.raw.clone().json()) as Record<string, unknown>;
      if (typeof body.task_description === 'string') {
        extra.task_description_hash = crypto
          .createHash('sha256')
          .update(body.task_description)
          .digest('hex')
          .slice(0, 16);
      }
    } catch {
      // Body may already be consumed — skip
    }
  }

  getDb().query(`INSERT INTO audit_log (event_type, project_id, details) VALUES (?, ?, ?)`, [
    'api_request',
    projectId ?? null,
    JSON.stringify({ method, path, status, ...extra }),
  ]).catch((e: Error) => console.error('[decigraph] audit_log write error:', e.message));
});

// Rate Limiter
// In development, rate limiting is skipped unless RATE_LIMIT_ENABLED=true.
interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface LockoutEntry {
  until: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();
const lockoutStore = new Map<string, LockoutEntry>();
const authFailStore = new Map<string, RateLimitEntry>();

// Prune expired entries every 60 s — unref so the timer doesn't keep the process alive
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimitStore) if (v.resetAt < now) rateLimitStore.delete(k);
  for (const [k, v] of authFailStore) if (v.resetAt < now) authFailStore.delete(k);
  for (const [k, v] of lockoutStore) if (v.until < now) lockoutStore.delete(k);
}, 60_000).unref();

export interface RateLimiterConfig {
  windowMs?: number; // default: 60_000
  maxRequests?: number; // default: 100
  namespace?: string; // used to key a separate counter per endpoint group
}

export function rateLimiter(opts: RateLimiterConfig = {}): MiddlewareHandler {
  const windowMs = opts.windowMs ?? 60_000;
  const maxRequests = opts.maxRequests ?? 100;
  const ns = opts.namespace ?? 'global';

  return createMiddleware(async (c, next) => {
    if (isDev() && process.env.RATE_LIMIT_ENABLED !== 'true') {
      await next();
      return;
    }

    const ip = getClientIp(c);

    // Check auth-failure lockout first
    const lockout = lockoutStore.get(ip);
    if (lockout && lockout.until > Date.now()) {
      const retryAfter = Math.ceil((lockout.until - Date.now()) / 1000);
      c.header('Retry-After', String(retryAfter));
      return c.json(
        {
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many failed auth attempts. Try again later.',
          },
        },
        429,
      );
    }

    // Identify by hashed auth token or by IP
    const authHeader = c.req.header('Authorization');
    const identifier = authHeader
      ? `key:${crypto.createHash('sha256').update(authHeader).digest('hex').slice(0, 16)}`
      : `ip:${ip}`;

    const storeKey = `${ns}:${identifier}`;
    const now = Date.now();
    let entry = rateLimitStore.get(storeKey);

    if (!entry || entry.resetAt < now) {
      entry = { count: 0, resetAt: now + windowMs };
      rateLimitStore.set(storeKey, entry);
    }

    entry.count++;

    const remaining = Math.max(0, maxRequests - entry.count);
    c.header('X-RateLimit-Limit', String(maxRequests));
    c.header('X-RateLimit-Remaining', String(remaining));
    c.header('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > maxRequests) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      c.header('Retry-After', String(retryAfter));
      return c.json(
        {
          error: {
            code: 'RATE_LIMITED',
            message: `Rate limit exceeded. Try again in ${retryAfter}s.`,
          },
        },
        429,
      );
    }

    await next();

    // Track auth failures for lockout
    if (c.res.status === 401) {
      const failKey = `authfail:${ip}`;
      let failEntry = authFailStore.get(failKey);
      if (!failEntry || failEntry.resetAt < now) {
        failEntry = { count: 0, resetAt: now + 60_000 };
        authFailStore.set(failKey, failEntry);
      }
      failEntry.count++;
      if (failEntry.count >= 5) {
        lockoutStore.set(ip, { until: now + 15 * 60_000 });
        authFailStore.delete(failKey);
      }
    }
  });
}

// Body Size Limit Middleware
// Rejects requests with Content-Length > maxBytes before body parsing.
export interface BodyLimitConfig {
  maxBytes?: number; // default: 2MB
  distilleryMaxChars?: number; // default: 100_000
}

export function bodyLimit(opts: BodyLimitConfig = {}): MiddlewareHandler {
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024; // 2MB
  const distilleryMaxChars = opts.distilleryMaxChars ?? 100_000;

  return createMiddleware(async (c, next) => {
    const contentLength = Number(c.req.header('content-length') ?? 0);

    if (contentLength > maxBytes) {
      return c.json(
        { error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds size limit' } },
        413,
      );
    }

    await next();
  });
}
