/**
 * Team Management Routes — invite, list, update role, remove, accept invitation.
 * Role permissions: owner > admin > member > viewer
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '@decigraph/core/db/index.js';
import { phase3AuthMiddleware, requireRole, getUser } from '../auth/middleware.js';
import { requireUUID } from './validation.js';
import crypto from 'node:crypto';

// ── Zod Schemas ─────────────────────────────────────────────────────
const inviteSchema = z.object({
  email: z.string().email().max(320),
  role: z.enum(['admin', 'member', 'viewer']).default('member'),
});

const updateRoleSchema = z.object({
  role: z.enum(['admin', 'member', 'viewer']),
});

// ── Helpers ─────────────────────────────────────────────────────────
function logAudit(tenantId: string, userId: string, action: string, resourceType: string, resourceId: string | null, details: Record<string, unknown>, ip: string): void {
  getDb().query(
    `INSERT INTO audit_log_v2 (tenant_id, user_id, action, resource_type, resource_id, details, ip_address)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [tenantId, userId, action, resourceType, resourceId, JSON.stringify(details), ip],
  ).catch((err: Error) => console.error('[decigraph:team] Audit error:', err.message));
}

function getIp(c: { req: { header: (name: string) => string | undefined } }): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
}

export function registerTeamRoutes(app: Hono): void {
  // POST /api/team/invite — invite by email
  app.post('/api/team/invite', phase3AuthMiddleware, requireRole('owner', 'admin'), async (c) => {
    const body = await c.req.json();
    const parsed = inviteSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.errors[0]?.message ?? 'Invalid input' } }, 400);
    }

    const user = getUser(c);
    const { email, role } = parsed.data;
    const db = getDb();

    // Check if already a member
    const existing = await db.query(
      'SELECT id FROM tenant_members WHERE tenant_id = ? AND email = ?',
      [user.tenant_id, email],
    );

    if (existing.rows.length > 0) {
      return c.json({ error: { code: 'CONFLICT', message: 'User is already a member or has a pending invite' } }, 409);
    }

    // Only owner can invite admins
    if (role === 'admin' && user.role !== 'owner') {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Only owners can invite admins' } }, 403);
    }

    const inviteToken = crypto.randomBytes(32).toString('hex');

    const result = await db.query(
      `INSERT INTO tenant_members (tenant_id, user_id, email, role, invited_by, invite_token)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING id, email, role, invite_token, created_at`,
      [user.tenant_id, crypto.randomUUID(), email, role, user.id, inviteToken],
    );

    const invite = result.rows[0] as Record<string, unknown>;
    const ip = getIp(c);
    logAudit(user.tenant_id, user.id, 'member_invited', 'tenant_member', invite.id as string, { email, role }, ip);

    return c.json({
      ...invite,
      invite_url: `/api/team/invite/${inviteToken}/accept`,
      message: `Invitation sent to ${email}`,
    }, 201);
  });

  // GET /api/team/members — list team members
  app.get('/api/team/members', phase3AuthMiddleware, async (c) => {
    const user = getUser(c);
    const db = getDb();

    const result = await db.query(
      `SELECT id, user_id, email, role, accepted_at, created_at
       FROM tenant_members
       WHERE tenant_id = ?
       ORDER BY created_at ASC`,
      [user.tenant_id],
    );

    return c.json(result.rows);
  });

  // PATCH /api/team/members/:id — update role
  app.patch('/api/team/members/:id', phase3AuthMiddleware, requireRole('owner', 'admin'), async (c) => {
    const body = await c.req.json();
    const parsed = updateRoleSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.errors[0]?.message ?? 'Invalid input' } }, 400);
    }

    const user = getUser(c);
    const memberId = requireUUID(c.req.param('id'), 'id');
    const { role } = parsed.data;
    const db = getDb();

    // Get the member being updated
    const target = await db.query(
      'SELECT * FROM tenant_members WHERE id = ? AND tenant_id = ?',
      [memberId, user.tenant_id],
    );

    if (target.rows.length === 0) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Member not found' } }, 404);
    }

    const targetMember = target.rows[0] as Record<string, unknown>;

    // Cannot change owner's role (must use transfer ownership)
    if (targetMember.role === 'owner') {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Cannot change owner role. Use ownership transfer instead.' } }, 403);
    }

    // Only owner can set admin role
    if (role === 'admin' && user.role !== 'owner') {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Only owners can assign admin role' } }, 403);
    }

    // Cannot change your own role
    if (targetMember.user_id === user.id) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Cannot change your own role' } }, 403);
    }

    await db.query(
      'UPDATE tenant_members SET role = ? WHERE id = ?',
      [role, memberId],
    );

    const ip = getIp(c);
    logAudit(user.tenant_id, user.id, 'member_role_changed', 'tenant_member', memberId, { email: targetMember.email, old_role: targetMember.role, new_role: role }, ip);

    return c.json({ message: 'Role updated', id: memberId, role });
  });

  // DELETE /api/team/members/:id — remove member
  app.delete('/api/team/members/:id', phase3AuthMiddleware, requireRole('owner', 'admin'), async (c) => {
    const user = getUser(c);
    const memberId = requireUUID(c.req.param('id'), 'id');
    const db = getDb();

    // Get the member being removed
    const target = await db.query(
      'SELECT * FROM tenant_members WHERE id = ? AND tenant_id = ?',
      [memberId, user.tenant_id],
    );

    if (target.rows.length === 0) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Member not found' } }, 404);
    }

    const targetMember = target.rows[0] as Record<string, unknown>;

    // Cannot remove owner
    if (targetMember.role === 'owner') {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Cannot remove the owner' } }, 403);
    }

    // Admin can only remove members/viewers, not other admins
    if (user.role === 'admin' && targetMember.role === 'admin') {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Admins cannot remove other admins' } }, 403);
    }

    await db.query('DELETE FROM tenant_members WHERE id = ?', [memberId]);

    const ip = getIp(c);
    logAudit(user.tenant_id, user.id, 'member_removed', 'tenant_member', memberId, { email: targetMember.email, role: targetMember.role }, ip);

    return c.json({ message: 'Member removed', id: memberId });
  });

  // POST /api/team/invite/:token/accept — accept invitation
  app.post('/api/team/invite/:token/accept', async (c) => {
    const token = c.req.param('token');
    if (!token || token.length < 32) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid invite token' } }, 400);
    }

    const db = getDb();

    const result = await db.query(
      'SELECT * FROM tenant_members WHERE invite_token = ?',
      [token],
    );

    if (result.rows.length === 0) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Invitation not found or already accepted' } }, 404);
    }

    const invite = result.rows[0] as Record<string, unknown>;

    if (invite.accepted_at) {
      return c.json({ error: { code: 'CONFLICT', message: 'Invitation already accepted' } }, 409);
    }

    // Mark as accepted and clear the invite token
    await db.query(
      'UPDATE tenant_members SET accepted_at = NOW(), invite_token = NULL WHERE id = ?',
      [invite.id],
    );

    const ip = getIp(c);
    logAudit(invite.tenant_id as string, invite.user_id as string, 'invite_accepted', 'tenant_member', invite.id as string, { email: invite.email }, ip);

    return c.json({
      message: 'Invitation accepted',
      tenant_id: invite.tenant_id,
      role: invite.role,
    });
  });

  // POST /api/team/transfer-ownership — transfer ownership to another member
  app.post('/api/team/transfer-ownership', phase3AuthMiddleware, requireRole('owner'), async (c) => {
    const body = await c.req.json();
    const newOwnerId = requireUUID(body.member_id, 'member_id');
    const user = getUser(c);
    const db = getDb();

    // Verify target is a member of this tenant
    const target = await db.query(
      'SELECT * FROM tenant_members WHERE id = ? AND tenant_id = ? AND accepted_at IS NOT NULL',
      [newOwnerId, user.tenant_id],
    );

    if (target.rows.length === 0) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Member not found' } }, 404);
    }

    // Set new owner
    await db.query('UPDATE tenant_members SET role = ? WHERE id = ?', ['owner', newOwnerId]);

    // Demote current owner to admin
    await db.query(
      'UPDATE tenant_members SET role = ? WHERE tenant_id = ? AND user_id = ?',
      ['admin', user.tenant_id, user.id],
    );

    const targetMember = target.rows[0] as Record<string, unknown>;
    const ip = getIp(c);
    logAudit(user.tenant_id, user.id, 'ownership_transferred', 'tenant', user.tenant_id, { new_owner_email: targetMember.email }, ip);

    return c.json({ message: 'Ownership transferred', new_owner: newOwnerId });
  });
}
