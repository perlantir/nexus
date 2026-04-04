import type { Hono } from 'hono';
import { getDb } from '@decigraph/core/db/index.js';
import { parseDecision, parseAgent, parseEdge, parseContradiction } from '@decigraph/core/db/parsers.js';
import { NotFoundError, ValidationError } from '@decigraph/core/types.js';
import { requireUUID, mapDbError, logAudit } from './validation.js';
import { randomUUID } from 'node:crypto';
import { generateEmbedding } from './validation.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExportPayload {
  decigraph_export_version: string;
  exported_at: string;
  project: {
    name: string;
    description: string | null;
    metadata: Record<string, unknown>;
  };
  agents: Array<Record<string, unknown>>;
  decisions: Array<Record<string, unknown>>;
  decision_edges: Array<{
    source_title: string;
    target_title: string;
    relationship: string;
    description: string | null;
  }>;
  contradictions: Array<{
    decision_a_title: string;
    decision_b_title: string;
    conflict_description: string | null;
    status: string;
  }>;
  sessions: Array<Record<string, unknown>>;
  webhook_configs?: Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJsonSafe(val: unknown): Record<string, unknown> {
  if (!val) return {};
  if (typeof val === 'object' && val !== null) return val as Record<string, unknown>;
  try { return JSON.parse(val as string); } catch { return {}; }
}

function parseArraySafe(val: unknown): unknown[] {
  if (Array.isArray(val)) return val;
  if (!val) return [];
  try { return JSON.parse(val as string); } catch { return []; }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerExportImportRoutes(app: Hono): void {
  // ── EXPORT ──────────────────────────────────────────────────────────────
  app.get('/api/projects/:id/export', async (c) => {
    const db = getDb();
    const projectId = requireUUID(c.req.param('id'), 'projectId');

    // Fetch project
    const projResult = await db.query('SELECT * FROM projects WHERE id = ?', [projectId]);
    if (projResult.rows.length === 0) throw new NotFoundError('Project', projectId);
    const proj = projResult.rows[0] as Record<string, unknown>;

    // Fetch agents
    const agentResult = await db.query(
      'SELECT * FROM agents WHERE project_id = ? ORDER BY created_at',
      [projectId],
    );

    // Fetch decisions (exclude embedding column)
    const decResult = await db.query(
      'SELECT * FROM decisions WHERE project_id = ? ORDER BY created_at',
      [projectId],
    );

    // Fetch edges
    const edgeResult = await db.query(
      `SELECT de.*, ds.title as source_title, dt.title as target_title
       FROM decision_edges de
       JOIN decisions ds ON de.source_id = ds.id
       JOIN decisions dt ON de.target_id = dt.id
       WHERE ds.project_id = ?
       ORDER BY de.created_at`,
      [projectId],
    );

    // Fetch contradictions
    const contradictionResult = await db.query(
      `SELECT c.*, da.title as decision_a_title, db.title as decision_b_title
       FROM contradictions c
       JOIN decisions da ON c.decision_a_id = da.id
       JOIN decisions db ON c.decision_b_id = db.id
       WHERE c.project_id = ?
       ORDER BY c.detected_at`,
      [projectId],
    );

    // Fetch sessions
    const sessionResult = await db.query(
      'SELECT * FROM session_summaries WHERE project_id = ? ORDER BY created_at',
      [projectId],
    );

    // Fetch webhook configs (redact URLs and secrets)
    let webhookConfigs: Array<Record<string, unknown>> = [];
    try {
      const whResult = await db.query(
        'SELECT * FROM webhook_configs WHERE project_id = ?',
        [projectId],
      );
      webhookConfigs = whResult.rows.map((wh) => {
        const row = wh as Record<string, unknown>;
        return {
          name: row.name,
          platform: row.platform,
          url: '[REDACTED]',
          events: parseArraySafe(row.events),
          enabled: row.enabled,
          // secret is NEVER exported
          metadata: parseJsonSafe(row.metadata),
        };
      });
    } catch {
      // webhook_configs table may not exist — skip
    }

    // Build export
    const exportData: ExportPayload = {
      decigraph_export_version: '1.0',
      exported_at: new Date().toISOString(),
      project: {
        name: proj.name as string,
        description: (proj.description as string) ?? null,
        metadata: parseJsonSafe(proj.metadata),
      },
      agents: agentResult.rows.map((a) => {
        const row = a as Record<string, unknown>;
        return {
          name: row.name,
          role: row.role,
          relevance_profile: parseJsonSafe(row.relevance_profile),
          context_budget_tokens: row.context_budget_tokens,
        };
      }),
      decisions: decResult.rows.map((d) => {
        const row = d as Record<string, unknown>;
        return {
          id: row.id,
          title: row.title,
          description: row.description,
          reasoning: row.reasoning,
          made_by: row.made_by,
          source: row.source,
          confidence: row.confidence,
          status: row.status,
          tags: parseArraySafe(row.tags),
          affects: parseArraySafe(row.affects),
          alternatives_considered: parseArraySafe(row.alternatives_considered),
          assumptions: parseArraySafe(row.assumptions),
          open_questions: parseArraySafe(row.open_questions),
          dependencies: parseArraySafe(row.dependencies),
          validated_at: row.validated_at ?? null,
          validation_source: row.validation_source ?? null,
          created_at: row.created_at,
          metadata: parseJsonSafe(row.metadata),
          // embedding is intentionally excluded
        };
      }),
      decision_edges: edgeResult.rows.map((e) => {
        const row = e as Record<string, unknown>;
        return {
          source_title: row.source_title as string,
          target_title: row.target_title as string,
          relationship: row.relationship as string,
          description: (row.description as string) ?? null,
        };
      }),
      contradictions: contradictionResult.rows.map((c) => {
        const row = c as Record<string, unknown>;
        return {
          decision_a_title: row.decision_a_title as string,
          decision_b_title: row.decision_b_title as string,
          conflict_description: (row.conflict_description as string) ?? null,
          status: row.status as string,
        };
      }),
      sessions: sessionResult.rows.map((s) => {
        const row = s as Record<string, unknown>;
        return {
          agent_name: row.agent_name,
          topic: row.topic,
          summary_text: row.summary_text,
          decisions_extracted: row.decisions_extracted,
          decision_ids: parseArraySafe(row.decision_ids),
          assumptions: parseArraySafe(row.assumptions),
          open_questions: parseArraySafe(row.open_questions),
          lessons_learned: parseArraySafe(row.lessons_learned),
          extraction_confidence: row.extraction_confidence,
          created_at: row.created_at,
        };
      }),
      webhook_configs: webhookConfigs,
    };

    logAudit('project_exported', projectId, {});

    return c.json(exportData);
  });

  // ── IMPORT ──────────────────────────────────────────────────────────────
  app.post('/api/projects/import', async (c) => {
    const db = getDb();
    const body = await c.req.json<ExportPayload>();

    if (!body.decigraph_export_version || !body.project) {
      throw new ValidationError('Invalid export format: missing decigraph_export_version or project');
    }

    const warnings: string[] = [];
    const projectId = randomUUID();
    const projectName = `${body.project.name} (imported)`;

    // 1. Create project
    try {
      await db.query(
        'INSERT INTO projects (id, name, description, metadata) VALUES (?, ?, ?, ?)',
        [projectId, projectName, body.project.description ?? '', JSON.stringify(body.project.metadata ?? {})],
      );
    } catch (err) {
      mapDbError(err);
    }

    // 2. Create agents
    let agentsImported = 0;
    for (const agent of body.agents ?? []) {
      try {
        await db.query(
          'INSERT INTO agents (id, project_id, name, role, relevance_profile, context_budget_tokens) VALUES (?, ?, ?, ?, ?, ?)',
          [
            randomUUID(),
            projectId,
            agent.name,
            agent.role,
            JSON.stringify(agent.relevance_profile ?? {}),
            agent.context_budget_tokens ?? 50000,
          ],
        );
        agentsImported++;
      } catch (err) {
        warnings.push(`Agent "${agent.name}" skipped: ${(err as Error).message}`);
      }
    }

    // 3. Create decisions (preserve original timestamps)
    const titleToId = new Map<string, string>();
    let decisionsImported = 0;
    for (const dec of body.decisions ?? []) {
      try {
        const newId = randomUUID();
        titleToId.set(dec.title as string, newId);

        // For SQLite, set created_at explicitly; for PG, also set it
        await db.query(
          `INSERT INTO decisions (
            id, project_id, title, description, reasoning, made_by,
            source, confidence, status, alternatives_considered,
            affects, tags, assumptions, open_questions, dependencies,
            validated_at, validation_source, created_at, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            newId,
            projectId,
            dec.title,
            dec.description ?? '',
            dec.reasoning ?? '',
            dec.made_by ?? 'unknown',
            dec.source ?? 'imported',
            dec.confidence ?? 'medium',
            dec.status ?? 'active',
            JSON.stringify(dec.alternatives_considered ?? []),
            db.arrayParam(parseArraySafe(dec.affects) as string[]),
            db.arrayParam(parseArraySafe(dec.tags) as string[]),
            JSON.stringify(dec.assumptions ?? []),
            JSON.stringify(dec.open_questions ?? []),
            JSON.stringify(dec.dependencies ?? []),
            dec.validated_at ?? null,
            dec.validation_source ?? null,
            dec.created_at ?? new Date().toISOString(),
            JSON.stringify(dec.metadata ?? {}),
          ],
        );
        decisionsImported++;
      } catch (err) {
        warnings.push(`Decision "${dec.title}" skipped: ${(err as Error).message}`);
      }
    }

    // 4. Recreate edges by title matching
    let edgesImported = 0;
    for (const edge of body.decision_edges ?? []) {
      const sourceId = titleToId.get(edge.source_title);
      const targetId = titleToId.get(edge.target_title);
      if (!sourceId || !targetId) {
        warnings.push(`Edge skipped: "${edge.source_title}" → "${edge.target_title}" (referenced decision not found)`);
        continue;
      }
      try {
        await db.query(
          `INSERT INTO decision_edges (id, source_id, target_id, relationship, description)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (source_id, target_id, relationship) DO NOTHING`,
          [randomUUID(), sourceId, targetId, edge.relationship, edge.description],
        );
        edgesImported++;
      } catch (err) {
        warnings.push(`Edge "${edge.source_title}" → "${edge.target_title}" skipped: ${(err as Error).message}`);
      }
    }

    // 5. Recreate contradictions by title matching
    let contradictionsImported = 0;
    for (const con of body.contradictions ?? []) {
      const aId = titleToId.get(con.decision_a_title);
      const bId = titleToId.get(con.decision_b_title);
      if (!aId || !bId) {
        warnings.push(`Contradiction skipped: "${con.decision_a_title}" vs "${con.decision_b_title}" (referenced decision not found)`);
        continue;
      }
      try {
        await db.query(
          `INSERT INTO contradictions (id, project_id, decision_a_id, decision_b_id, similarity_score, conflict_description, status)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [randomUUID(), projectId, aId, bId, 0.0, con.conflict_description, con.status ?? 'unresolved'],
        );
        contradictionsImported++;
      } catch (err) {
        warnings.push(`Contradiction skipped: ${(err as Error).message}`);
      }
    }

    // 6. Webhook configs are skipped

    // 7. Fire embedding generation async (fire-and-forget)
    for (const [title, newId] of titleToId) {
      const dec = (body.decisions ?? []).find((d) => d.title === title);
      if (dec) {
        const text = `${dec.title}\n${dec.description}\n${dec.reasoning}`;
        generateEmbedding(text).then((embedding) => {
          if (embedding) {
            db.query('UPDATE decisions SET embedding = ? WHERE id = ?', [
              `[${embedding.join(',')}]`,
              newId,
            ]).catch(() => {});
          }
        }).catch(() => {});
      }
    }

    logAudit('project_imported', projectId, {
      source_project: body.project.name,
      agents_imported: agentsImported,
      decisions_imported: decisionsImported,
      edges_imported: edgesImported,
    });

    return c.json({
      project_id: projectId,
      project_name: projectName,
      agents_imported: agentsImported,
      decisions_imported: decisionsImported,
      edges_imported: edgesImported,
      contradictions_imported: contradictionsImported,
      warnings,
    }, 201);
  });
}
