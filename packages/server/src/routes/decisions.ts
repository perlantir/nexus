import type { Hono } from 'hono';
import { getDb } from '@decigraph/core/db/index.js';
import { parseDecision, parseEdge } from '@decigraph/core/db/parsers.js';
import { NotFoundError, ValidationError } from '@decigraph/core/types.js';
import type { Decision, DecisionEdge, NotificationType } from '@decigraph/core/types.js';
import { propagateChange } from '@decigraph/core/change-propagator/index.js';
import { checkForContradictions } from '@decigraph/core/contradiction-detector/index.js';
import { dispatchWebhooks } from '@decigraph/core/webhooks/index.js';
import { findCascadeImpact, notifyCascade } from '@decigraph/core/dependency-cascade/index.js';
import { randomUUID } from 'node:crypto';
import {
  requireUUID,
  requireString,
  optionalString,
  validateTags,
  validateAffects,
  validateAlternatives,
  mapDbError,
  logAudit,
  generateEmbedding,
} from './validation.js';

export function registerDecisionRoutes(app: Hono): void {
  // Decisions — Create & List (project-scoped)

  app.post('/api/projects/:id/decisions', async (c) => {
    const db = getDb();
    const projectId = requireUUID(c.req.param('id'), 'projectId');
    const body = await c.req.json<{
      title?: unknown;
      description?: unknown;
      reasoning?: unknown;
      made_by?: unknown;
      source?: unknown;
      source_session_id?: unknown;
      confidence?: unknown;
      status?: unknown;
      supersedes_id?: unknown;
      alternatives_considered?: unknown;
      affects?: unknown;
      tags?: unknown;
      assumptions?: unknown;
      open_questions?: unknown;
      dependencies?: unknown;
      confidence_decay_rate?: number;
      metadata?: Record<string, unknown>;
      depends_on?: unknown[];
    }>();

    const title = requireString(body.title, 'title', 500);
    const description = requireString(body.description, 'description', 10000);
    const reasoning = requireString(body.reasoning, 'reasoning', 10000);
    const made_by = requireString(body.made_by, 'made_by', 200);
    const tags = validateTags(body.tags);
    const affects = validateAffects(body.affects);
    const alternatives_considered = validateAlternatives(body.alternatives_considered);

    const supersedes_id =
      body.supersedes_id != null ? requireUUID(body.supersedes_id, 'supersedes_id') : null;

    const embeddingText = `${title}\n${description}\n${reasoning}`;
    const embedding = await generateEmbedding(embeddingText);

    try {
      const result = await db.query(
        `INSERT INTO decisions (
           project_id, title, description, reasoning, made_by,
           source, source_session_id, confidence, status, supersedes_id,
           alternatives_considered, affects, tags, assumptions,
           open_questions, dependencies, confidence_decay_rate, metadata, embedding
         ) VALUES (
           ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?,
           ?, ?, ?, ?,
           ?, ?, ?, ?, ?
         ) RETURNING *`,
        [
          projectId,
          title,
          description,
          reasoning,
          made_by,
          body.source ?? 'manual',
          body.source_session_id ?? null,
          body.confidence ?? 'high',
          body.status ?? 'active',
          supersedes_id,
          JSON.stringify(alternatives_considered),
          db.arrayParam(affects),
          db.arrayParam(tags),
          JSON.stringify(body.assumptions ?? []),
          JSON.stringify(body.open_questions ?? []),
          JSON.stringify(body.dependencies ?? []),
          body.confidence_decay_rate ?? 0.0,
          JSON.stringify(body.metadata ?? {}),
          embedding ? `[${embedding.join(',')}]` : null,
        ],
      );

      const decision = parseDecision(result.rows[0] as Record<string, unknown>);

      logAudit('decision_created', projectId, {
        decision_id: decision.id,
        title: decision.title,
        made_by: decision.made_by,
      });

      propagateChange(decision, 'decision_created').catch((err) =>
        console.error('[decigraph] Change propagation failed:', (err as Error).message),
      );

      dispatchWebhooks(projectId, 'decision_created', {
        decision_id: decision.id,
        title: decision.title,
        made_by: decision.made_by,
      }).catch((err) => console.warn('[decigraph:webhook]', (err as Error).message));

      checkForContradictions(decision).catch((err) =>
        console.error('[decigraph] Contradiction check failed:', (err as Error).message),
      );

      // Create "requires" edges from depends_on
      if (Array.isArray(body.depends_on)) {
        for (const targetId of body.depends_on) {
          try {
            const tid = requireUUID(targetId, 'depends_on');
            await db.query(
              `INSERT INTO decision_edges (id, source_id, target_id, relationship)
               VALUES (?, ?, ?, 'requires')
               ON CONFLICT (source_id, target_id, relationship) DO NOTHING`,
              [randomUUID(), decision.id, tid],
            );
          } catch { /* skip invalid IDs */ }
        }
      }

      return c.json(decision, 201);
    } catch (err) {
      mapDbError(err);
    }
  });

  app.get('/api/projects/:id/decisions', async (c) => {
    const db = getDb();
    const projectId = requireUUID(c.req.param('id'), 'projectId');
    const status = c.req.query('status');
    const tagsParam = c.req.query('tags');
    const madeBy = c.req.query('made_by');
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 500);
    const offset = Math.max(parseInt(c.req.query('offset') ?? '0', 10), 0);

    const tags = tagsParam ? tagsParam.split(',').map((t) => t.trim()) : null;

    const conditions: string[] = ['d.project_id = ?'];
    const params: unknown[] = [projectId];

    if (status) {
      conditions.push(`d.status = ?`);
      params.push(status);
    }
    if (tags && tags.length > 0) {
      conditions.push(`d.tags && ?`);
      params.push(db.arrayParam(tags));
    }
    if (madeBy) {
      conditions.push(`d.made_by = ?`);
      params.push(madeBy);
    }

    params.push(limit);
    params.push(offset);

    const result = await db.query(
      `SELECT * FROM decisions d
       WHERE ${conditions.join(' AND ')}
       ORDER BY d.created_at DESC
       LIMIT ? OFFSET ?`,
      params,
    );

    return c.json(result.rows.map((r) => parseDecision(r as Record<string, unknown>)));
  });

  // Decisions — Single CRUD

  app.get('/api/decisions/:id', async (c) => {
    const db = getDb();
    const id = requireUUID(c.req.param('id'), 'id');
    const result = await db.query('SELECT * FROM decisions WHERE id = ?', [id]);
    if (result.rows.length === 0) throw new NotFoundError('Decision', id);
    return c.json(parseDecision(result.rows[0] as Record<string, unknown>));
  });

  app.patch('/api/decisions/:id', async (c) => {
    const db = getDb();
    const id = requireUUID(c.req.param('id'), 'id');
    const body = await c.req.json<
      Partial<{
        title: unknown;
        description: unknown;
        reasoning: unknown;
        made_by: unknown;
        confidence: unknown;
        status: unknown;
        affects: unknown;
        tags: unknown;
        assumptions: unknown[];
        open_questions: unknown[];
        dependencies: unknown[];
        alternatives_considered: unknown;
        confidence_decay_rate: number;
        metadata: Record<string, unknown>;
        validated_at: unknown;
        validation_source: unknown;
      }>
    >();

    const existing = await db.query('SELECT id FROM decisions WHERE id = ?', [id]);
    if (existing.rows.length === 0) throw new NotFoundError('Decision', id);

    const setClauses: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [];

    const addField = (col: string, val: unknown, asJson = false) => {
      setClauses.push(`${col} = ?`);
      params.push(asJson ? JSON.stringify(val) : val);
    };

    if (body.title !== undefined) addField('title', requireString(body.title, 'title', 500));
    if (body.description !== undefined)
      addField('description', requireString(body.description, 'description', 10000));
    if (body.reasoning !== undefined)
      addField('reasoning', requireString(body.reasoning, 'reasoning', 10000));
    if (body.made_by !== undefined)
      addField('made_by', requireString(body.made_by, 'made_by', 200));
    if (body.confidence !== undefined) addField('confidence', body.confidence);
    if (body.status !== undefined) addField('status', body.status);
    if (body.affects !== undefined) addField('affects', db.arrayParam(validateAffects(body.affects)));
    if (body.tags !== undefined) addField('tags', db.arrayParam(validateTags(body.tags)));
    if (body.assumptions !== undefined) addField('assumptions', body.assumptions, true);
    if (body.open_questions !== undefined) addField('open_questions', body.open_questions, true);
    if (body.dependencies !== undefined) addField('dependencies', body.dependencies, true);
    if (body.alternatives_considered !== undefined)
      addField('alternatives_considered', validateAlternatives(body.alternatives_considered), true);
    if (body.confidence_decay_rate !== undefined)
      addField('confidence_decay_rate', body.confidence_decay_rate);
    if (body.metadata !== undefined) addField('metadata', body.metadata, true);
    if (body.validated_at !== undefined) addField('validated_at', body.validated_at);
    if (body.validation_source !== undefined)
      addField(
        'validation_source',
        optionalString(body.validation_source, 'validation_source', 200),
      );

    params.push(id);

    const result = await db.query(
      `UPDATE decisions SET ${setClauses.join(', ')} WHERE id = ? RETURNING *`,
      params,
    );

    const decision = parseDecision(result.rows[0] as Record<string, unknown>);

    logAudit('decision_updated', decision.project_id, {
      decision_id: decision.id,
      fields_updated: Object.keys(body),
    });

    propagateChange(decision, 'decision_updated').catch((err) =>
      console.error('[decigraph] Change propagation failed:', (err as Error).message),
    );

    return c.json(decision);
  });

  // Supersede Decision

  app.post('/api/decisions/:id/supersede', async (c) => {
    const db = getDb();
    const oldId = requireUUID(c.req.param('id'), 'id');
    const body = await c.req.json<{
      title?: unknown;
      description?: unknown;
      reasoning?: unknown;
      made_by?: unknown;
      tags?: unknown;
      affects?: unknown;
    }>();

    const title = requireString(body.title, 'title', 500);
    const description = requireString(body.description, 'description', 10000);
    const reasoning = requireString(body.reasoning, 'reasoning', 10000);
    const made_by = requireString(body.made_by, 'made_by', 200);
    const tags = validateTags(body.tags);
    const affects = validateAffects(body.affects);

    const result = await db.transaction(async (txQuery) => {
      const oldResult = await txQuery('SELECT * FROM decisions WHERE id = ?', [oldId]);
      if (oldResult.rows.length === 0) throw new NotFoundError('Decision', oldId);
      const old = oldResult.rows[0] as Record<string, unknown>;

      const embeddingText = `${title}\n${description}\n${reasoning}`;
      const embedding = await generateEmbedding(embeddingText);

      const newResult = await txQuery(
        `INSERT INTO decisions (
           project_id, title, description, reasoning, made_by,
           source, confidence, status, supersedes_id,
           affects, tags, alternatives_considered, assumptions,
           open_questions, dependencies, metadata, embedding
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         RETURNING *`,
        [
          old.project_id,
          title,
          description,
          reasoning,
          made_by,
          'manual',
          'high',
          'active',
          oldId,
          db.arrayParam(affects.length ? affects : (old.affects as string[] ?? [])),
          db.arrayParam(tags.length ? tags : (old.tags as string[] ?? [])),
          old.alternatives_considered ?? '[]',
          old.assumptions ?? '[]',
          old.open_questions ?? '[]',
          old.dependencies ?? '[]',
          old.metadata ?? '{}',
          embedding ? `[${embedding.join(',')}]` : null,
        ],
      );

      await txQuery(
        "UPDATE decisions SET status = 'superseded', updated_at = NOW() WHERE id = ?",
        [oldId],
      );

      await txQuery(
        `INSERT INTO decision_edges (source_id, target_id, relationship, strength)
         VALUES (?, ?, 'supersedes', 1.0)
         ON CONFLICT (source_id, target_id, relationship) DO NOTHING`,
        [newResult.rows[0].id, oldId],
      );

      return {
        newDecision: parseDecision(newResult.rows[0] as Record<string, unknown>),
        oldDecision: parseDecision({ ...old, status: 'superseded' }),
      };
    });

    logAudit('decision_superseded', (result.newDecision as Decision).project_id, {
      old_decision_id: oldId,
      new_decision_id: (result.newDecision as Decision).id,
      made_by,
    });

    propagateChange(result.newDecision as Decision, 'decision_superseded').catch((err) =>
      console.error('[decigraph] Change propagation failed:', (err as Error).message),
    );

    dispatchWebhooks((result.newDecision as Decision).project_id, 'decision_superseded', {
      decision_id: (result.newDecision as Decision).id,
      title: (result.newDecision as Decision).title,
      old_decision_id: oldId,
    }).catch((err) => console.warn('[decigraph:webhook]', (err as Error).message));

    // Cascade impact detection (fire-and-forget notifications, but include in response)
    let cascadeImpact: { decisions_affected: number; chain: Array<Record<string, unknown>> } = { decisions_affected: 0, chain: [] };
    try {
      const cascade = await findCascadeImpact(oldId, (result.newDecision as Decision).project_id);
      cascadeImpact = {
        decisions_affected: cascade.total_affected,
        chain: cascade.impacts.map((i) => ({
          title: i.decision_title,
          depth: i.depth,
          impact: i.impact,
          agents_affected: i.affected_agents,
        })),
      };
      // Fire-and-forget: send notifications + webhooks
      notifyCascade(cascade, (result.newDecision as Decision).project_id, 'superseded').catch(
        (err) => console.warn('[decigraph:cascade]', (err as Error).message),
      );
      if (cascade.total_affected > 0) {
        dispatchWebhooks((result.newDecision as Decision).project_id, 'cascade_detected', {
          changed_decision_id: oldId,
          changed_decision_title: cascade.changed_decision_title,
          total_affected: cascade.total_affected,
        }).catch((err) => console.warn('[decigraph:webhook]', (err as Error).message));
      }
    } catch (err) {
      console.warn('[decigraph:cascade] Error:', (err as Error).message);
    }

    return c.json({ ...result, cascade_impact: cascadeImpact }, 201);
  });

  // Decision revert (restore superseded → active)

  app.post('/api/decisions/:id/revert', async (c) => {
    const db = getDb();
    const id = requireUUID(c.req.param('id'), 'id');

    const result = await db.query(
      `UPDATE decisions SET status = 'active', updated_at = NOW() WHERE id = ? RETURNING *`,
      [id],
    );

    if (result.rows.length === 0) throw new NotFoundError('Decision', id);
    const decision = parseDecision(result.rows[0] as Record<string, unknown>);

    logAudit('decision_reverted', decision.project_id, { decision_id: decision.id });

    propagateChange(decision, 'decision_reverted').catch((err) =>
      console.error('[decigraph] Change propagation failed:', (err as Error).message),
    );

    dispatchWebhooks(decision.project_id, 'decision_reverted', {
      decision_id: decision.id,
      title: decision.title,
    }).catch((err) => console.warn('[decigraph:webhook]', (err as Error).message));

    // Cascade detection for revert (fire-and-forget)
    findCascadeImpact(id, decision.project_id).then((cascade) => {
      if (cascade.total_affected > 0) {
        notifyCascade(cascade, decision.project_id, 'reverted').catch(() => {});
        dispatchWebhooks(decision.project_id, 'cascade_detected', {
          changed_decision_id: id,
          changed_decision_title: cascade.changed_decision_title,
          total_affected: cascade.total_affected,
        }).catch(() => {});
      }
    }).catch((err) => console.warn('[decigraph:cascade]', (err as Error).message));

    return c.json(decision);
  });

  // Cascade preview endpoint
  app.get('/api/decisions/:id/cascade', async (c) => {
    const db = getDb();
    const id = requireUUID(c.req.param('id'), 'id');

    const decResult = await db.query('SELECT project_id FROM decisions WHERE id = ?', [id]);
    if (decResult.rows.length === 0) throw new NotFoundError('Decision', id);
    const projectId = (decResult.rows[0] as Record<string, unknown>).project_id as string;

    const cascade = await findCascadeImpact(id, projectId);
    return c.json({
      decision_id: id,
      decisions_affected: cascade.total_affected,
      chain: cascade.impacts.map((i) => ({
        decision_id: i.decision_id,
        title: i.decision_title,
        depth: i.depth,
        impact: i.impact,
        path: i.path,
        agents_affected: i.affected_agents,
      })),
    });
  });

  // Decision Graph + Impact

  app.get('/api/decisions/:id/graph', async (c) => {
    const db = getDb();
    const id = requireUUID(c.req.param('id'), 'id');
    const depth = Math.min(parseInt(c.req.query('depth') ?? '3', 10), 10);

    const visited = new Set<string>();
    const nodes: Decision[] = [];
    const edges: DecisionEdge[] = [];
    const queue: Array<{ nodeId: string; currentDepth: number }> = [
      { nodeId: id, currentDepth: 0 },
    ];

    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      const { nodeId, currentDepth } = item;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);

      const decResult = await db.query('SELECT * FROM decisions WHERE id = ?', [nodeId]);
      if (decResult.rows.length === 0) continue;
      nodes.push(parseDecision(decResult.rows[0] as Record<string, unknown>));

      if (currentDepth >= depth) continue;

      const edgeResult = await db.query(
        'SELECT * FROM decision_edges WHERE source_id = ? OR target_id = ?',
        [nodeId, nodeId],
      );

      for (const row of edgeResult.rows) {
        const edge = parseEdge(row as Record<string, unknown>);
        if (!edges.find((e) => e.id === edge.id)) {
          edges.push(edge);
        }
        const nextId = edge.source_id === nodeId ? edge.target_id : edge.source_id;
        if (!visited.has(nextId)) {
          queue.push({ nodeId: nextId, currentDepth: currentDepth + 1 });
        }
      }
    }

    return c.json({ nodes, edges });
  });

  app.get('/api/decisions/:id/impact', async (c) => {
    const db = getDb();
    const id = requireUUID(c.req.param('id'), 'id');

    const decResult = await db.query('SELECT * FROM decisions WHERE id = ?', [id]);
    if (decResult.rows.length === 0) throw new NotFoundError('Decision', id);
    const decision = parseDecision(decResult.rows[0] as Record<string, unknown>);

    // Downstream: decisions this one affects (outgoing edges)
    const downstreamEdges = await db.query(
      `SELECT DISTINCT d.* FROM decisions d
       JOIN decision_edges e ON e.target_id = d.id
       WHERE e.source_id = ?`,
      [id],
    );
    const downstreamDecisions = downstreamEdges.rows.map((r) =>
      parseDecision(r as Record<string, unknown>),
    );

    // Upstream: decisions that depend ON this one (incoming edges)
    const upstreamEdges = await db.query(
      `SELECT DISTINCT d.* FROM decisions d
       JOIN decision_edges e ON e.source_id = d.id
       WHERE e.target_id = ?`,
      [id],
    );
    const upstreamDecisions = upstreamEdges.rows.map((r) =>
      parseDecision(r as Record<string, unknown>),
    );

    const affectedAgentIds = new Set<string>();
    if (decision.affects.length > 0) {
      const agentResult = await db.query(
        `SELECT DISTINCT a.* FROM agents a
         JOIN subscriptions s ON s.agent_id = a.id
         WHERE s.topic = ANY(?) AND a.project_id = ?`,
        [db.arrayParam(decision.affects), decision.project_id],
      );
      for (const row of agentResult.rows) {
        const agent = row as Record<string, unknown>;
        affectedAgentIds.add(agent.id as string);
      }
    }

    const affectedAgentsResult =
      affectedAgentIds.size > 0
        ? await db.query(`SELECT * FROM agents WHERE id = ANY(?)`, [
            db.arrayParam(Array.from(affectedAgentIds)),
          ])
        : { rows: [] };
    const affectedAgents = affectedAgentsResult.rows.map((r) => r as Record<string, unknown>);

    const blockingResult = await db.query(
      `SELECT DISTINCT d.* FROM decisions d
       JOIN decision_edges e ON e.source_id = d.id
       WHERE e.target_id = ? AND e.relationship = 'blocks'`,
      [id],
    );
    const blockingDecisions = blockingResult.rows.map((r) =>
      parseDecision(r as Record<string, unknown>),
    );

    const supersessionChain: Decision[] = [];
    let currentId: string | undefined = decision.supersedes_id;
    while (currentId) {
      const chainResult = await db.query('SELECT * FROM decisions WHERE id = ?', [currentId]);
      if (chainResult.rows.length === 0) break;
      const chainDecision = parseDecision(chainResult.rows[0] as Record<string, unknown>);
      supersessionChain.push(chainDecision);
      currentId = chainDecision.supersedes_id;
      if (supersessionChain.length > 20) break;
    }

    const cacheResult = await db.query(
      `SELECT COUNT(*) as count FROM context_cache
       WHERE ? = ANY(decision_ids_included) AND expires_at > NOW()`,
      [id],
    );
    const cachedContextsInvalidated = parseInt(
      ((cacheResult.rows[0] as Record<string, unknown>)?.count as string) ?? '0',
      10,
    );

    return c.json({
      decision,
      downstream_decisions: downstreamDecisions,
      upstream_decisions: upstreamDecisions,
      affected_agents: affectedAgents.map((a) => ({
        id: a.id,
        project_id: a.project_id,
        name: a.name,
        role: a.role,
      })),
      cached_contexts_invalidated: cachedContextsInvalidated,
      blocking_decisions: blockingDecisions,
      supersession_chain: supersessionChain,
    });
  });

  // Edges

  app.post('/api/decisions/:id/edges', async (c) => {
    const db = getDb();
    const sourceId = requireUUID(c.req.param('id'), 'id');
    const body = await c.req.json<{
      target_id?: unknown;
      relationship?: unknown;
      description?: unknown;
      strength?: number;
    }>();

    const target_id = requireUUID(body.target_id, 'target_id');
    const relationship = requireString(body.relationship, 'relationship', 100);

    const validRelationships = [
      'supersedes',
      'requires',
      'informs',
      'blocks',
      'contradicts',
      'enables',
      'depends_on',
      'refines',
      'reverts',
    ];
    if (!validRelationships.includes(relationship)) {
      throw new ValidationError(`relationship must be one of: ${validRelationships.join(', ')}`);
    }

    if (sourceId === target_id) {
      throw new ValidationError('Cannot create self-referencing edge');
    }

    try {
      const result = await db.query(
        `INSERT INTO decision_edges (source_id, target_id, relationship, description, strength)
         VALUES (?, ?, ?, ?, ?)
         RETURNING *`,
        [
          sourceId,
          target_id,
          relationship,
          optionalString(body.description, 'description', 1000) ?? null,
          body.strength ?? 1.0,
        ],
      );
      return c.json(parseEdge(result.rows[0] as Record<string, unknown>), 201);
    } catch (err) {
      mapDbError(err);
    }
  });

  app.get('/api/decisions/:id/edges', async (c) => {
    const db = getDb();
    const id = requireUUID(c.req.param('id'), 'id');
    const result = await db.query(
      'SELECT * FROM decision_edges WHERE source_id = ? OR target_id = ? ORDER BY created_at ASC',
      [id, id],
    );
    return c.json(result.rows.map((r) => parseEdge(r as Record<string, unknown>)));
  });

  app.delete('/api/edges/:id', async (c) => {
    const db = getDb();
    const id = requireUUID(c.req.param('id'), 'id');
    const result = await db.query('DELETE FROM decision_edges WHERE id = ? RETURNING id', [id]);
    if (result.rows.length === 0) throw new NotFoundError('Edge', id);
    return c.json({ deleted: true, id });
  });

  // Semantic Search

  app.post('/api/projects/:id/decisions/search', async (c) => {
    const db = getDb();
    const projectId = requireUUID(c.req.param('id'), 'projectId');
    const body = await c.req.json<{ query?: unknown; limit?: number }>();

    const searchQuery = requireString(body.query, 'query', 1000);
    const limit = Math.min(body.limit ?? 10, 50);

    const embedding = await generateEmbedding(searchQuery);

    if (embedding) {
      const result = await db.query(
        `SELECT *, 1 - (embedding <=> ?) as similarity
         FROM decisions
         WHERE project_id = ? AND embedding IS NOT NULL
         ORDER BY embedding <=> ?
         LIMIT ?`,
        [`[${embedding.join(',')}]`, projectId, `[${embedding.join(',')}]`, limit],
      );
      return c.json(result.rows.map((r) => parseDecision(r as Record<string, unknown>)));
    } else {
      const result = await db.query(
        `SELECT * FROM decisions
         WHERE project_id = ?
           AND (title ILIKE ? OR description ILIKE ? OR reasoning ILIKE ?)
         ORDER BY created_at DESC
         LIMIT ?`,
        [projectId, `%${searchQuery}%`, `%${searchQuery}%`, `%${searchQuery}%`, limit],
      );
      return c.json(result.rows.map((r) => parseDecision(r as Record<string, unknown>)));
    }
  });

  // ── Decision Validation ─────────────────────────────────────────────────

  const VALID_SOURCES = ['manual_review', 'test_passed', 'production_verified', 'peer_reviewed', 'external'] as const;

  app.post('/api/decisions/:id/validate', async (c) => {
    const db = getDb();
    const id = requireUUID(c.req.param('id'), 'id');
    const body = await c.req.json<{
      validation_source?: unknown;
      notes?: unknown;
    }>();

    const validation_source = requireString(body.validation_source, 'validation_source', 100);
    if (!(VALID_SOURCES as readonly string[]).includes(validation_source)) {
      throw new ValidationError(
        `validation_source must be one of: ${VALID_SOURCES.join(', ')}`,
      );
    }

    // Verify decision exists and is active
    const existing = await db.query('SELECT * FROM decisions WHERE id = ?', [id]);
    if (existing.rows.length === 0) throw new NotFoundError('Decision', id);
    const dec = existing.rows[0] as Record<string, unknown>;
    if (dec.status !== 'active') {
      throw new ValidationError('Only active decisions can be validated');
    }

    // Update validated_at and validation_source
    const notes = body.notes != null ? String(body.notes).slice(0, 5000) : undefined;
    let metadataObj: Record<string, unknown> = {};
    try {
      metadataObj = typeof dec.metadata === 'string' ? JSON.parse(dec.metadata as string) : (dec.metadata as Record<string, unknown>) ?? {};
    } catch { /* keep empty */ }
    if (notes) metadataObj.validation_notes = notes;

    const result = await db.query(
      `UPDATE decisions SET validated_at = ${db.dialect === 'sqlite' ? "datetime('now')" : 'NOW()'}, validation_source = ?, metadata = ? WHERE id = ? RETURNING *`,
      [validation_source, JSON.stringify(metadataObj), id],
    );

    const decision = parseDecision(result.rows[0] as Record<string, unknown>);

    logAudit('decision_validated', decision.project_id, {
      decision_id: decision.id,
      validation_source,
    });

    propagateChange(decision, 'decision_validated' as NotificationType).catch((err) =>
      console.error('[decigraph] Change propagation failed:', (err as Error).message),
    );

    dispatchWebhooks(decision.project_id, 'decision_validated', {
      decision_id: decision.id,
      title: decision.title,
      validation_source,
    }).catch((err) => console.warn('[decigraph:webhook]', (err as Error).message));

    return c.json(decision);
  });

  // ── Decision Invalidation ───────────────────────────────────────────────

  app.post('/api/decisions/:id/invalidate', async (c) => {
    const db = getDb();
    const id = requireUUID(c.req.param('id'), 'id');
    const body = await c.req.json<{ reason?: unknown }>();

    const existing = await db.query('SELECT * FROM decisions WHERE id = ?', [id]);
    if (existing.rows.length === 0) throw new NotFoundError('Decision', id);
    const dec = existing.rows[0] as Record<string, unknown>;

    // Downgrade confidence: high → medium, medium → low, low stays low
    const currentConf = dec.confidence as string;
    const newConf = currentConf === 'high' ? 'medium' : currentConf === 'medium' ? 'low' : 'low';

    // Store invalidation reason in metadata
    let metadataObj: Record<string, unknown> = {};
    try {
      metadataObj = typeof dec.metadata === 'string' ? JSON.parse(dec.metadata as string) : (dec.metadata as Record<string, unknown>) ?? {};
    } catch { /* keep empty */ }
    if (body.reason) metadataObj.invalidation_reason = String(body.reason).slice(0, 5000);

    const result = await db.query(
      `UPDATE decisions SET validated_at = NULL, validation_source = NULL, confidence = ?, metadata = ? WHERE id = ? RETURNING *`,
      [newConf, JSON.stringify(metadataObj), id],
    );

    const decision = parseDecision(result.rows[0] as Record<string, unknown>);

    logAudit('decision_invalidated', decision.project_id, {
      decision_id: decision.id,
      reason: body.reason ? String(body.reason) : undefined,
    });

    propagateChange(decision, 'decision_invalidated' as NotificationType).catch((err) =>
      console.error('[decigraph] Change propagation failed:', (err as Error).message),
    );

    dispatchWebhooks(decision.project_id, 'decision_invalidated', {
      decision_id: decision.id,
      title: decision.title,
    }).catch((err) => console.warn('[decigraph:webhook]', (err as Error).message));

    return c.json(decision);
  });

  // ── Bulk Validation ─────────────────────────────────────────────────────

  app.post('/api/projects/:id/decisions/validate-bulk', async (c) => {
    const db = getDb();
    const projectId = requireUUID(c.req.param('id'), 'projectId');
    const body = await c.req.json<{
      decision_ids?: unknown;
      validation_source?: unknown;
      notes?: unknown;
    }>();

    if (!Array.isArray(body.decision_ids) || body.decision_ids.length === 0) {
      throw new ValidationError('decision_ids must be a non-empty array');
    }

    const validation_source = requireString(body.validation_source, 'validation_source', 100);
    if (!(VALID_SOURCES as readonly string[]).includes(validation_source)) {
      throw new ValidationError(
        `validation_source must be one of: ${VALID_SOURCES.join(', ')}`,
      );
    }

    const ids: string[] = body.decision_ids.map((id: unknown) => requireUUID(id, 'decision_id'));

    const results = await db.transaction(async (txQuery) => {
      const validated: Array<Record<string, unknown>> = [];
      const notFound: string[] = [];

      for (const id of ids) {
        const check = await txQuery('SELECT * FROM decisions WHERE id = ? AND project_id = ?', [id, projectId]);
        if (check.rows.length === 0) {
          notFound.push(id);
          continue;
        }
        validated.push(check.rows[0] as Record<string, unknown>);
      }

      if (notFound.length > 0) {
        throw new ValidationError(`Decisions not found in project: ${notFound.join(', ')}`);
      }

      for (const id of ids) {
        await txQuery(
          `UPDATE decisions SET validated_at = ${db.dialect === 'sqlite' ? "datetime('now')" : 'NOW()'}, validation_source = ? WHERE id = ?`,
          [validation_source, id],
        );
      }

      return validated;
    });

    // Fire-and-forget propagation for each validated decision
    for (const row of results as Array<Record<string, unknown>>) {
      const dec = parseDecision(row);
      propagateChange(dec, 'decision_validated' as NotificationType).catch((err) =>
        console.error('[decigraph] Change propagation failed:', (err as Error).message),
      );
    }

    logAudit('decisions_bulk_validated', projectId, {
      count: ids.length,
      validation_source,
    });

    return c.json({
      validated: ids.length,
      failed: 0,
      validation_source,
      decision_ids: ids,
    });
  });
}
