/**
 * Auth Routes — signup, login, logout, me, refresh, magic-link, callback,
 * forgot-password, reset-password.
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '@decigraph/core/db/index.js';
import { getSupabase, getSupabaseAdmin, isSupabaseConfigured } from '../auth/supabase.js';
import { phase3AuthMiddleware, getUser, isAuthRequired } from '../auth/middleware.js';
import crypto from 'node:crypto';

// ── Zod Schemas ─────────────────────────────────────────────────────
const signupSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8).max(128).optional(),
  name: z.string().max(200).optional(),
});

const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(128),
});

const magicLinkSchema = z.object({
  email: z.string().email().max(320),
});

const forgotPasswordSchema = z.object({
  email: z.string().email().max(320),
});

const resetPasswordSchema = z.object({
  access_token: z.string().min(1),
  new_password: z.string().min(8).max(128),
});

const refreshSchema = z.object({
  refresh_token: z.string().min(1),
});

/**
 * Auto-provision tenant + membership for a new user.
 */
async function autoProvisionTenant(userId: string, email: string): Promise<string> {
  const db = getDb();
  const tenantId = crypto.randomUUID();
  const domain = email.split('@')[1] ?? 'personal';
  const name = domain === 'gmail.com' || domain === 'hotmail.com' || domain === 'outlook.com'
    ? 'Personal'
    : domain;
  const slug = `${email.split('@')[0]?.replace(/[^a-z0-9]/gi, '-')?.toLowerCase()}-${tenantId.slice(0, 8)}`;

  // Create tenant
  await db.query(
    `INSERT INTO tenants (id, name, slug, plan) VALUES (?, ?, ?, 'free')`,
    [tenantId, name, slug],
  );

  // Add user as owner
  await db.query(
    `INSERT INTO tenant_members (tenant_id, user_id, email, role, accepted_at)
     VALUES (?, ?, ?, 'owner', NOW())`,
    [tenantId, userId, email],
  );

  return tenantId;
}

export function registerAuthRoutes(app: Hono): void {
  // POST /api/auth/signup
  app.post('/api/auth/signup', async (c) => {
    if (!isSupabaseConfigured()) {
      return c.json({ error: { code: 'AUTH_NOT_CONFIGURED', message: 'Authentication is not configured' } }, 503);
    }

    const body = await c.req.json();
    const parsed = signupSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.errors[0]?.message ?? 'Invalid input' } }, 400);
    }

    const { email, password, name } = parsed.data;
    const supabase = getSupabase();

    if (password) {
      // Email + password signup
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { name } },
      });

      if (error) {
        return c.json({ error: { code: 'AUTH_ERROR', message: error.message } }, 400);
      }

      if (data.user) {
        await autoProvisionTenant(data.user.id, email);
      }

      return c.json({
        user: data.user ? { id: data.user.id, email: data.user.email } : null,
        session: data.session,
        message: data.session ? 'Account created' : 'Check your email for confirmation',
      }, 201);
    } else {
      // Magic link signup
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { data: { name } },
      });

      if (error) {
        return c.json({ error: { code: 'AUTH_ERROR', message: error.message } }, 400);
      }

      return c.json({ message: 'Magic link sent to your email' }, 200);
    }
  });

  // POST /api/auth/login
  app.post('/api/auth/login', async (c) => {
    if (!isSupabaseConfigured()) {
      return c.json({ error: { code: 'AUTH_NOT_CONFIGURED', message: 'Authentication is not configured' } }, 503);
    }

    const body = await c.req.json();
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.errors[0]?.message ?? 'Invalid input' } }, 400);
    }

    const { email, password } = parsed.data;
    const supabase = getSupabase();

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      return c.json({ error: { code: 'AUTH_ERROR', message: 'Invalid credentials' } }, 401);
    }

    // Check if tenant exists, auto-provision if not
    const db = getDb();
    const membership = await db.query(
      'SELECT tenant_id FROM tenant_members WHERE user_id = ? LIMIT 1',
      [data.user.id],
    );

    if (membership.rows.length === 0) {
      await autoProvisionTenant(data.user.id, email);
    }

    return c.json({
      user: { id: data.user.id, email: data.user.email },
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
      },
    });
  });

  // POST /api/auth/logout
  app.post('/api/auth/logout', phase3AuthMiddleware, async (c) => {
    if (!isSupabaseConfigured()) {
      return c.json({ message: 'Logged out' });
    }

    const token = c.req.header('Authorization')?.replace('Bearer ', '');
    if (token) {
      const supabaseAdmin = getSupabaseAdmin();
      const user = getUser(c);
      await supabaseAdmin.auth.admin.signOut(user.id).catch(() => {});
    }

    return c.json({ message: 'Logged out' });
  });

  // GET /api/auth/me
  app.get('/api/auth/me', phase3AuthMiddleware, async (c) => {
    const user = getUser(c);

    if (!isAuthRequired() || user.id === 'anonymous') {
      return c.json({
        user: { id: 'anonymous', email: '' },
        tenant: { id: user.tenant_id, name: 'Default', slug: 'nick', plan: user.plan },
        role: user.role,
      });
    }

    const db = getDb();
    const tenantResult = await db.query('SELECT * FROM tenants WHERE id = ?', [user.tenant_id]);
    const tenant = tenantResult.rows[0] as Record<string, unknown> | undefined;

    return c.json({
      user: { id: user.id, email: user.email },
      tenant: tenant
        ? { id: tenant.id, name: tenant.name, slug: tenant.slug, plan: tenant.plan }
        : null,
      role: user.role,
    });
  });

  // POST /api/auth/refresh
  app.post('/api/auth/refresh', async (c) => {
    if (!isSupabaseConfigured()) {
      return c.json({ error: { code: 'AUTH_NOT_CONFIGURED', message: 'Authentication is not configured' } }, 503);
    }

    const body = await c.req.json();
    const parsed = refreshSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.errors[0]?.message ?? 'Invalid input' } }, 400);
    }

    const supabase = getSupabase();
    const { data, error } = await supabase.auth.refreshSession({
      refresh_token: parsed.data.refresh_token,
    });

    if (error || !data.session) {
      return c.json({ error: { code: 'AUTH_ERROR', message: 'Failed to refresh token' } }, 401);
    }

    return c.json({
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
      },
    });
  });

  // POST /api/auth/magic-link
  app.post('/api/auth/magic-link', async (c) => {
    if (!isSupabaseConfigured()) {
      return c.json({ error: { code: 'AUTH_NOT_CONFIGURED', message: 'Authentication is not configured' } }, 503);
    }

    const body = await c.req.json();
    const parsed = magicLinkSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.errors[0]?.message ?? 'Invalid input' } }, 400);
    }

    const supabase = getSupabase();
    const { error } = await supabase.auth.signInWithOtp({ email: parsed.data.email });

    if (error) {
      return c.json({ error: { code: 'AUTH_ERROR', message: error.message } }, 400);
    }

    return c.json({ message: 'Magic link sent to your email' });
  });

  // GET /api/auth/callback — OAuth callback handler
  app.get('/api/auth/callback', async (c) => {
    if (!isSupabaseConfigured()) {
      return c.json({ error: { code: 'AUTH_NOT_CONFIGURED', message: 'Authentication is not configured' } }, 503);
    }

    const code = c.req.query('code');
    if (!code) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Authorization code required' } }, 400);
    }

    const supabase = getSupabase();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);

    if (error || !data.session) {
      return c.json({ error: { code: 'AUTH_ERROR', message: error?.message ?? 'OAuth callback failed' } }, 400);
    }

    // Auto-provision if needed
    const db = getDb();
    const membership = await db.query(
      'SELECT tenant_id FROM tenant_members WHERE user_id = ? LIMIT 1',
      [data.user.id],
    );

    if (membership.rows.length === 0) {
      await autoProvisionTenant(data.user.id, data.user.email ?? '');
    }

    return c.json({
      user: { id: data.user.id, email: data.user.email },
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
      },
    });
  });

  // POST /api/auth/forgot-password
  app.post('/api/auth/forgot-password', async (c) => {
    if (!isSupabaseConfigured()) {
      return c.json({ error: { code: 'AUTH_NOT_CONFIGURED', message: 'Authentication is not configured' } }, 503);
    }

    const body = await c.req.json();
    const parsed = forgotPasswordSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.errors[0]?.message ?? 'Invalid input' } }, 400);
    }

    const supabase = getSupabase();
    const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email);

    if (error) {
      // Don't reveal whether email exists
      console.warn('[decigraph:auth] Password reset error:', error.message);
    }

    // Always return success to avoid email enumeration
    return c.json({ message: 'If the email exists, a reset link has been sent' });
  });

  // POST /api/auth/reset-password
  app.post('/api/auth/reset-password', async (c) => {
    if (!isSupabaseConfigured()) {
      return c.json({ error: { code: 'AUTH_NOT_CONFIGURED', message: 'Authentication is not configured' } }, 503);
    }

    const body = await c.req.json();
    const parsed = resetPasswordSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.errors[0]?.message ?? 'Invalid input' } }, 400);
    }

    const supabaseAdmin = getSupabaseAdmin();
    // Verify the access token first
    const supabase = getSupabase();
    const { data: { user }, error: verifyError } = await supabase.auth.getUser(parsed.data.access_token);

    if (verifyError || !user) {
      return c.json({ error: { code: 'AUTH_ERROR', message: 'Invalid or expired reset token' } }, 401);
    }

    const { error } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
      password: parsed.data.new_password,
    });

    if (error) {
      return c.json({ error: { code: 'AUTH_ERROR', message: 'Failed to reset password' } }, 400);
    }

    return c.json({ message: 'Password updated successfully' });
  });
}
