import type { Hono } from 'hono';
import { getDb } from '@decigraph/core/db/index.js';
import { parseDecision, parseEdge, parseAuditEntry } from '@decigraph/core/db/parsers.js';
import { requireUUID } from './validation.js';

export function registerStatsRoutes(app: Hono): void {
  app.get('/api/projects/:id/stats', async (c) => {
    const db = getDb();
    const projectId = requireUUID(c.req.param('id'), 'projectId');

    const [
      decisionsResult,
      agentsResult,
      artifactsResult,
      sessionsResult,
      contradictionsResult,
      edgesResult,
      auditResult,
      agentDecisionResult,
    ] = await Promise.all([
      db.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'active') AS active,
           COUNT(*) FILTER (WHERE status = 'superseded') AS superseded,
           COUNT(*) FILTER (WHERE status = 'pending') AS pending,
           COUNT(*) AS total
         FROM decisions WHERE project_id = ?`,
        [projectId],
      ),
      db.query('SELECT COUNT(*) AS count FROM agents WHERE project_id = ?', [projectId]),
      db.query('SELECT COUNT(*) AS count FROM artifacts WHERE project_id = ?', [projectId]),
      db.query('SELECT COUNT(*) AS count FROM session_summaries WHERE project_id = ?', [projectId]),
      db.query(
        "SELECT COUNT(*) AS count FROM contradictions WHERE project_id = ? AND status = 'unresolved'",
        [projectId],
      ),
      db.query(
        `SELECT COUNT(*) AS count FROM decision_edges e
         JOIN decisions d ON d.id = e.source_id WHERE d.project_id = ?`,
        [projectId],
      ),
      db.query('SELECT * FROM audit_log WHERE project_id = ? ORDER BY created_at DESC LIMIT 10', [
        projectId,
      ]),
      // Decisions per agent — count decisions where agent name appears in affects
      db.query(
        `SELECT a.name AS agent_name, a.role, COUNT(d.id) AS count
         FROM agents a
         LEFT JOIN decisions d ON d.project_id = a.project_id
           AND d.affects LIKE '%' || a.name || '%'
         WHERE a.project_id = ?
         GROUP BY a.id, a.name, a.role
         ORDER BY count DESC`,
        [projectId],
      ).catch(() => ({ rows: [] })),
    ]);

    const d = decisionsResult.rows[0] as Record<string, unknown>;

    // Monitoring metrics — additional queries
    const [reviewResult, contradictionTotalResult, feedbackResult, compileHistoryResult] = await Promise.all([
      db.query(
        `SELECT
           COUNT(*) FILTER (WHERE review_status = 'approved') AS approved,
           COUNT(*) FILTER (WHERE review_status = 'rejected') AS rejected,
           COUNT(*) FILTER (WHERE review_status = 'pending_review') AS pending_review
         FROM decisions WHERE project_id = ? AND source = 'auto_distilled'`,
        [projectId],
      ).catch(() => ({ rows: [{ approved: 0, rejected: 0, pending_review: 0 }] })),
      db.query(
        `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'dismissed') AS dismissed
         FROM contradictions WHERE project_id = ?`,
        [projectId],
      ).catch(() => ({ rows: [{ total: 0, dismissed: 0 }] })),
      db.query(
        'SELECT COUNT(*) AS count FROM relevance_feedback rf JOIN agents a ON rf.agent_id = a.id WHERE a.project_id = ?',
        [projectId],
      ).catch(() => ({ rows: [{ count: 0 }] })),
      db.query(
        'SELECT COUNT(*) AS count FROM compile_history WHERE project_id = ?',
        [projectId],
      ).catch(() => ({ rows: [{ count: 0 }] })),
    ]);

    const rv = reviewResult.rows[0] as Record<string, unknown>;
    const approved = parseInt(rv.approved as string ?? '0', 10);
    const rejected = parseInt(rv.rejected as string ?? '0', 10);
    const totalReviewed = approved + rejected;
    const precision = totalReviewed > 0 ? Math.round((approved / totalReviewed) * 1000) / 1000 : 1;

    const ct = contradictionTotalResult.rows[0] as Record<string, unknown>;
    const contradictionTotal = parseInt(ct.total as string ?? '0', 10);
    const dismissed = parseInt(ct.dismissed as string ?? '0', 10);
    const fpRate = contradictionTotal > 0 ? Math.round((dismissed / contradictionTotal) * 1000) / 1000 : 0;

    const feedbackCount = parseInt((feedbackResult.rows[0] as Record<string, unknown>).count as string ?? '0', 10);
    const compileCount = parseInt((compileHistoryResult.rows[0] as Record<string, unknown>).count as string ?? '0', 10);
    const feedbackPerCompile = compileCount > 0 ? Math.round((feedbackCount / compileCount) * 10) / 10 : 0;

    return c.json({
      total_decisions: parseInt(d.total as string, 10),
      active_decisions: parseInt(d.active as string, 10),
      superseded_decisions: parseInt(d.superseded as string, 10),
      pending_decisions: parseInt(d.pending as string, 10),
      total_agents: parseInt((agentsResult.rows[0] as Record<string, unknown>).count as string, 10),
      total_artifacts: parseInt(
        (artifactsResult.rows[0] as Record<string, unknown>).count as string,
        10,
      ),
      total_sessions: parseInt(
        (sessionsResult.rows[0] as Record<string, unknown>).count as string,
        10,
      ),
      unresolved_contradictions: parseInt(
        (contradictionsResult.rows[0] as Record<string, unknown>).count as string,
        10,
      ),
      total_edges: parseInt((edgesResult.rows[0] as Record<string, unknown>).count as string, 10),
      recent_activity: auditResult.rows.map((r) => parseAuditEntry(r as Record<string, unknown>)),
      // Monitoring metrics
      extraction_quality: {
        total_extracted: totalReviewed + parseInt(rv.pending_review as string ?? '0', 10),
        approved,
        rejected,
        precision,
      },
      contradictions: {
        total: contradictionTotal,
        unresolved: parseInt((contradictionsResult.rows[0] as Record<string, unknown>).count as string, 10),
        resolved: contradictionTotal - parseInt((contradictionsResult.rows[0] as Record<string, unknown>).count as string, 10) - dismissed,
        false_positive_rate: fpRate,
      },
      feedback: {
        total_ratings: feedbackCount,
        per_compilation: feedbackPerCompile,
      },
      graph: {
        total_decisions: parseInt(d.total as string, 10),
        active: parseInt(d.active as string, 10),
        superseded: parseInt(d.superseded as string, 10),
        pending: parseInt(d.pending as string, 10),
        edges: parseInt((edgesResult.rows[0] as Record<string, unknown>).count as string, 10),
        agents: parseInt((agentsResult.rows[0] as Record<string, unknown>).count as string, 10),
      },
      decisions_per_agent: agentDecisionResult.rows.map((r) => {
        const row = r as Record<string, unknown>;
        return {
          agent_name: row.agent_name as string,
          role: row.role as string,
          count: parseInt(row.count as string ?? '0', 10),
        };
      }),
    });
  });

  // Project Graph (all decisions + edges)

  app.get('/api/projects/:id/graph', async (c) => {
    const db = getDb();
    const projectId = requireUUID(c.req.param('id'), 'projectId');

    const [decisionsResult, edgesResult] = await Promise.all([
      db.query('SELECT * FROM decisions WHERE project_id = ? ORDER BY created_at ASC', [projectId]),
      db.query(
        `SELECT e.* FROM decision_edges e
         JOIN decisions d ON d.id = e.source_id
         WHERE d.project_id = ?`,
        [projectId],
      ),
    ]);

    return c.json({
      nodes: decisionsResult.rows.map((r) => parseDecision(r as Record<string, unknown>)),
      edges: edgesResult.rows.map((r) => parseEdge(r as Record<string, unknown>)),
    });
  });
}
