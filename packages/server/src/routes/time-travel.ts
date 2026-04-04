import type { Hono } from 'hono';
import { getDb } from '@decigraph/core/db/index.js';
import { NotFoundError, ValidationError } from '@decigraph/core/types.js';
import { requireUUID, requireString } from './validation.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJsonSafe(val: unknown): unknown {
  if (!val) return [];
  if (typeof val === 'object') return val;
  try { return JSON.parse(val as string); } catch { return []; }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerTimeTravelRoutes(app: Hono): void {
  // ── Replay a specific compilation ─────────────────────────────────────
  app.get('/api/compile-history/:compileId', async (c) => {
    const db = getDb();
    const compileId = requireUUID(c.req.param('compileId'), 'compileId');

    const result = await db.query(
      'SELECT * FROM compile_history WHERE id = ?',
      [compileId],
    );

    if (result.rows.length === 0) throw new NotFoundError('CompileHistory', compileId);

    const row = result.rows[0] as Record<string, unknown>;
    return c.json({
      id: row.id,
      project_id: row.project_id,
      agent_id: row.agent_id,
      agent_name: row.agent_name,
      task_description: row.task_description,
      compiled_at: row.compiled_at,
      total_decisions: row.total_decisions,
      token_budget_used: row.token_budget_used,
      context_hash: row.context_hash,
      decision_ids: parseJsonSafe(row.decision_ids),
      decision_scores: parseJsonSafe(row.decision_scores),
      metadata: parseJsonSafe(row.metadata),
    });
  });

  // ── List compilation history for an agent ──────────────────────────────
  app.get('/api/agents/:id/compile-history', async (c) => {
    const db = getDb();
    const agentId = requireUUID(c.req.param('id'), 'agentId');
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 200);

    const result = await db.query(
      'SELECT * FROM compile_history WHERE agent_id = ? ORDER BY compiled_at DESC LIMIT ?',
      [agentId, limit],
    );

    return c.json(result.rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: r.id,
        task_description: r.task_description,
        compiled_at: r.compiled_at,
        total_decisions: r.total_decisions,
        token_budget_used: r.token_budget_used,
        context_hash: r.context_hash,
      };
    }));
  });

  // ── Diff two compilations ─────────────────────────────────────────────
  app.post('/api/compile/diff', async (c) => {
    const db = getDb();
    const body = await c.req.json<{
      compile_id_a?: unknown;
      compile_id_b?: unknown;
    }>();

    const idA = requireUUID(body.compile_id_a, 'compile_id_a');
    const idB = requireUUID(body.compile_id_b, 'compile_id_b');

    const resultA = await db.query('SELECT * FROM compile_history WHERE id = ?', [idA]);
    const resultB = await db.query('SELECT * FROM compile_history WHERE id = ?', [idB]);

    if (resultA.rows.length === 0) throw new NotFoundError('CompileHistory', idA);
    if (resultB.rows.length === 0) throw new NotFoundError('CompileHistory', idB);

    const rowA = resultA.rows[0] as Record<string, unknown>;
    const rowB = resultB.rows[0] as Record<string, unknown>;

    const scoresA = (parseJsonSafe(rowA.decision_scores) as Array<{ id: string; title: string; combined_score: number }>);
    const scoresB = (parseJsonSafe(rowB.decision_scores) as Array<{ id: string; title: string; combined_score: number }>);

    const mapA = new Map(scoresA.map((d, i) => [d.id, { ...d, rank: i + 1 }]));
    const mapB = new Map(scoresB.map((d, i) => [d.id, { ...d, rank: i + 1 }]));

    const addedDecisions: Array<{ title: string; score_b: number }> = [];
    const removedDecisions: Array<{ title: string; score_a: number }> = [];
    const rerankedDecisions: Array<{ title: string; rank_a: number; rank_b: number; score_a: number; score_b: number }> = [];
    let unchangedCount = 0;

    // Find added (in B but not A)
    for (const [id, dB] of mapB) {
      if (!mapA.has(id)) {
        addedDecisions.push({ title: dB.title, score_b: dB.combined_score });
      }
    }

    // Find removed (in A but not B)
    for (const [id, dA] of mapA) {
      if (!mapB.has(id)) {
        removedDecisions.push({ title: dA.title, score_a: dA.combined_score });
      }
    }

    // Find reranked (in both but different rank)
    for (const [id, dA] of mapA) {
      const dB = mapB.get(id);
      if (!dB) continue;
      if (dA.rank !== dB.rank) {
        rerankedDecisions.push({
          title: dA.title,
          rank_a: dA.rank,
          rank_b: dB.rank,
          score_a: dA.combined_score,
          score_b: dB.combined_score,
        });
      } else {
        unchangedCount++;
      }
    }

    return c.json({
      compiled_at_a: rowA.compiled_at,
      compiled_at_b: rowB.compiled_at,
      added_decisions: addedDecisions,
      removed_decisions: removedDecisions,
      reranked_decisions: rerankedDecisions,
      unchanged_count: unchangedCount,
    });
  });

  // ── Reconstruct context at a point in time ────────────────────────────
  app.post('/api/compile/at', async (c) => {
    const db = getDb();
    const body = await c.req.json<{
      agent_name?: unknown;
      project_id?: unknown;
      task_description?: unknown;
      as_of?: unknown;
    }>();

    const agent_name = requireString(body.agent_name, 'agent_name', 200);
    const project_id = requireUUID(body.project_id, 'project_id');
    const task_description = requireString(body.task_description, 'task_description', 10000);
    const as_of = requireString(body.as_of, 'as_of', 100);

    // Validate as_of is a valid date
    const asOfDate = new Date(as_of);
    if (isNaN(asOfDate.getTime())) {
      throw new ValidationError('as_of must be a valid ISO date string');
    }

    // Look up agent to get ID for weight snapshot lookup
    const agentResult = await db.query(
      'SELECT id FROM agents WHERE project_id = ? AND name = ? LIMIT 1',
      [project_id, agent_name],
    );
    const agentId = agentResult.rows.length > 0 ? (agentResult.rows[0] as Record<string, unknown>).id as string : null;

    // Look up historical weights (weight snapshot closest to but not after as_of)
    let historicalWeights: Record<string, unknown> | null = null;
    if (agentId) {
      try {
        const snapshotResult = await db.query(
          `SELECT weights FROM weight_snapshots
           WHERE agent_id = ? AND snapshot_at <= ?
           ORDER BY snapshot_at DESC LIMIT 1`,
          [agentId, as_of],
        );
        if (snapshotResult.rows.length > 0) {
          const raw = (snapshotResult.rows[0] as Record<string, unknown>).weights;
          historicalWeights = typeof raw === 'string' ? JSON.parse(raw) : raw as Record<string, unknown>;
        }
      } catch { /* weight_snapshots table may not exist */ }
    }

    // Fetch decisions that existed as of that date, excluding ones superseded before that date
    const result = await db.query(
      `SELECT * FROM decisions
       WHERE project_id = ?
         AND created_at <= ?
         AND (status = 'active' OR (status = 'superseded' AND updated_at > ?))
       ORDER BY created_at DESC`,
      [project_id, as_of, as_of],
    );

    const decisions = result.rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: r.id,
        title: r.title,
        description: r.description,
        status: r.status,
        tags: parseJsonSafe(r.tags),
        made_by: r.made_by,
        created_at: r.created_at,
      };
    });

    return c.json({
      as_of,
      note: 'Reconstructed context using decisions available as of this date',
      project_id,
      agent_name,
      task: task_description,
      decisions_available: decisions.length,
      decisions,
      historical_weights: historicalWeights,
      weights_source: historicalWeights ? 'snapshot' : 'current',
    });
  });
}
