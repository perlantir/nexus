/**
 * Compile Route — delegates to core compileContext() for all scoring,
 * sorting, and formatting. The route only handles HTTP concerns:
 * request parsing, audit logging, compile history recording, and
 * the debug mode overlay.
 */

import crypto from 'node:crypto';
import type { Hono } from 'hono';
import { getDb } from '@decigraph/core/db/index.js';
import { compileContext } from '@decigraph/core/context-compiler/index.js';
import type { CompileRequest } from '@decigraph/core/types.js';
import { requireUUID, requireString, logAudit } from './validation.js';

export function registerCompileRoutes(app: Hono): void {
  app.post('/api/compile', async (c) => {
    const db = getDb();
    const body = await c.req.json<{
      agent_name?: unknown;
      project_id?: unknown;
      task_description?: unknown;
      max_tokens?: number;
      include_superseded?: boolean;
      session_lookback_days?: number;
      debug?: boolean;
    }>();

    const agent_name = requireString(body.agent_name, 'agent_name', 200);
    const project_id = requireUUID(body.project_id, 'project_id');
    const task_description = requireString(body.task_description, 'task_description', 100000);

    // ── Delegate to core compileContext() ────────────────────────────
    // This uses the full 5-signal scoring pipeline: freshness weighting,
    // confidence decay, graph expansion, score blending, context caching,
    // and markdown + JSON formatting.
    const request: CompileRequest = {
      agent_name,
      project_id,
      task_description,
      max_tokens: body.max_tokens,
      include_superseded: body.include_superseded,
      session_lookback_days: body.session_lookback_days,
    };

    const result = await compileContext(request);

    // ── Server-only concerns: audit + history ────────────────────────
    const compileRequestId = crypto.randomUUID();
    const contextHash = crypto.createHash('sha256')
      .update(result.formatted_markdown)
      .digest('hex');

    // Privacy: store hash by default, raw text only if DECIGRAPH_STORE_RAW_TASKS=true
    const storeRawTasks = process.env.DECIGRAPH_STORE_RAW_TASKS === 'true';
    const taskForStorage = storeRawTasks
      ? task_description
      : crypto.createHash('sha256').update(task_description).digest('hex');

    // Audit log (always uses hash)
    const taskHash = crypto.createHash('sha256')
      .update(task_description).digest('hex');
    logAudit('compile_request', project_id, {
      agent_name,
      task_description_sha256: taskHash,
      decisions_included: result.decisions_included,
      decisions_considered: result.decisions_considered,
      compilation_time_ms: result.compilation_time_ms,
    });

    // Record compile history
    const agentResult = await db.query(
      'SELECT id FROM agents WHERE project_id = ? AND name = ? LIMIT 1',
      [project_id, agent_name],
    );
    const agentId = agentResult.rows.length > 0
      ? (agentResult.rows[0] as Record<string, unknown>).id as string
      : 'unknown';

    try {
      await db.query(
        `INSERT INTO compile_history
         (id, project_id, agent_id, agent_name, task_description,
          decision_ids, decision_scores, total_decisions,
          token_budget_used, context_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          compileRequestId,
          project_id,
          agentId,
          agent_name,
          taskForStorage,
          db.arrayParam(result.decisions.map((d) => d.id)),
          JSON.stringify(result.decisions.map((d) => ({
            id: d.id,
            title: d.title,
            combined_score: d.combined_score,
          }))),
          result.decisions_included,
          result.token_count,
          contextHash,
        ],
      );
    } catch (err) {
      console.warn('[decigraph:compile] History recording failed:', (err as Error).message);
    }

    // ── Debug info (optional) ────────────────────────────────────────
    const debugInfo = body.debug === true ? {
      scoring_pipeline: 'core/context-compiler compileContext()',
      signals: ['direct_affect', 'tag_matching', 'role_relevance', 'semantic_similarity', 'status_penalty'],
      task_hash: taskHash,
      raw_tasks_stored: storeRawTasks,
    } : undefined;

    // ── Response ─────────────────────────────────────────────────────
    return c.json({
      compile_request_id: compileRequestId,
      ...result,
      context_hash: contextHash,
      feedback_hint: `Rate this context: POST /api/feedback/batch with compile_request_id=${compileRequestId}`,
      ...(debugInfo ? { debug: debugInfo } : {}),
    });
  });
}
