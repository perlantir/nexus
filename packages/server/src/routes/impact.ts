/**
 * Phase 2 Impact Analysis Route
 *
 * POST /api/projects/:id/impact — analyze impact of a proposed decision
 */
import type { Hono } from 'hono';
import { requireUUID, requireString } from './validation.js';
import { analyzeImpact } from '@decigraph/core/intelligence/impact-analyzer.js';

export function registerImpactRoutes(app: Hono): void {
  app.post('/api/projects/:id/impact', async (c) => {
    const projectId = requireUUID(c.req.param('id'), 'projectId');
    const body = await c.req.json<{ proposed_decision?: unknown }>();

    const proposedDecision = requireString(body.proposed_decision, 'proposed_decision', 5000);

    const result = await analyzeImpact(proposedDecision, projectId);

    return c.json(result);
  });
}
