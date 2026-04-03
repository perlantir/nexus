import type { Hono } from 'hono';
import { query } from '@nexus/core/db/pool.js';
import { parseDecision, parseSession } from '@nexus/core/db/parsers.js';
import type { Decision } from '@nexus/core/types.js';
import { distill } from '@nexus/core/distillery/index.js';
import { getModelIdentifier } from '@nexus/core/distillery/extractor.js';
import {
  requireUUID,
  requireString,
  optionalString,
  mapDbError,
  logAudit,
} from './validation.js';

export function registerDistilleryRoutes(app: Hono): void {
  // POST /api/projects/:id/distill — extract decisions from conversation text
  app.post('/api/projects/:id/distill', async (c) => {
    const projectId = requireUUID(c.req.param('id'), 'projectId');
    const body = await c.req.json<{
      conversation_text?: unknown;
      agent_name?: unknown;
      session_id?: unknown;
    }>();

    const conversationText = requireString(body.conversation_text, 'conversation_text', 100000);
    const agentName = optionalString(body.agent_name, 'agent_name', 200) ?? 'distiller';

    const result = await distill(projectId, conversationText, agentName);

    logAudit('distill_completed', projectId, {
      decisions_extracted: result.decisions_extracted,
      contradictions_found: result.contradictions_found,
      agent_name: agentName,
    });

    return c.json(result, 201);
  });

  // POST /api/projects/:id/distill/session — extract + create session summary
  app.post('/api/projects/:id/distill/session', async (c) => {
    const projectId = requireUUID(c.req.param('id'), 'projectId');
    const body = await c.req.json<{
      conversation_text?: unknown;
      agent_name?: unknown;
      session_id?: unknown;
      topic?: unknown;
    }>();

    const conversationText = requireString(body.conversation_text, 'conversation_text', 100000);
    const agentName = requireString(body.agent_name, 'agent_name', 200);
    const topic = optionalString(body.topic, 'topic', 500) ?? 'Session';

    const distillResult = await distill(projectId, conversationText, agentName);

    try {
      const summaryResult = await query(
        `INSERT INTO session_summaries (
           project_id, agent_name, topic, summary,
           decision_ids, extraction_model, extraction_confidence
         ) VALUES ($1, $2, $3, $4, $5::uuid[], $6, $7)
         RETURNING *`,
        [
          projectId,
          agentName,
          topic,
          `Session with ${distillResult.decisions_extracted} decisions extracted`,
          distillResult.decisions.map((d: Decision) => d.id),
          getModelIdentifier(),
          0.8,
        ],
      );

      const session = parseSession(summaryResult.rows[0] as Record<string, unknown>);

      logAudit('distill_session_completed', projectId, {
        session_id: session.id,
        decisions_extracted: distillResult.decisions_extracted,
        agent_name: agentName,
      });

      return c.json(
        {
          decisions_extracted: distillResult.decisions_extracted,
          contradictions_found: distillResult.contradictions_found,
          decisions: distillResult.decisions,
          session_summary: session,
        },
        201,
      );
    } catch (err) {
      mapDbError(err);
    }
  });

  // POST /api/projects/:id/sessions — create session summary manually
  app.post('/api/projects/:id/sessions', async (c) => {
    const projectId = requireUUID(c.req.param('id'), 'projectId');
    const body = await c.req.json<{
      agent_name?: unknown;
      topic?: unknown;
      summary?: unknown;
      decision_ids?: string[];
      artifact_ids?: string[];
      assumptions?: string[];
      open_questions?: string[];
      lessons_learned?: string[];
      raw_conversation_hash?: unknown;
      extraction_model?: unknown;
      extraction_confidence?: number;
    }>();

    const agent_name = requireString(body.agent_name, 'agent_name', 200);
    const topic = requireString(body.topic, 'topic', 500);
    const summary = requireString(body.summary, 'summary', 10000);

    try {
      const result = await query(
        `INSERT INTO session_summaries (
           project_id, agent_name, topic, summary,
           decision_ids, artifact_ids, assumptions,
           open_questions, lessons_learned,
           raw_conversation_hash, extraction_model, extraction_confidence
         ) VALUES ($1,$2,$3,$4,$5::uuid[],$6::uuid[],$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [
          projectId,
          agent_name,
          topic,
          summary,
          body.decision_ids ?? [],
          body.artifact_ids ?? [],
          body.assumptions ?? [],
          body.open_questions ?? [],
          body.lessons_learned ?? [],
          optionalString(body.raw_conversation_hash, 'raw_conversation_hash', 256) ?? null,
          optionalString(body.extraction_model, 'extraction_model', 100) ?? null,
          body.extraction_confidence ?? null,
        ],
      );
      return c.json(parseSession(result.rows[0] as Record<string, unknown>), 201);
    } catch (err) {
      mapDbError(err);
    }
  });

  // GET /api/projects/:id/sessions — list session summaries
  app.get('/api/projects/:id/sessions', async (c) => {
    const projectId = requireUUID(c.req.param('id'), 'projectId');
    const result = await query(
      'SELECT * FROM session_summaries WHERE project_id = $1 ORDER BY created_at DESC',
      [projectId],
    );
    return c.json(result.rows.map((r) => parseSession(r as Record<string, unknown>)));
  });
}
