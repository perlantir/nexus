import { getDb } from '../db/index.js';
import { parseDecision, parseEdge, parseAgent } from '../db/parsers.js';
import { generateEmbedding } from './embeddings.js';
import type {
  Decision,
  DecisionEdge,
  GraphNode,
  GraphResult,
  ImpactAnalysis,
  Agent,
  CreateDecisionInput,
  CreateEdgeInput,
} from '../types.js';
import { NotFoundError, DeciGraphError } from '../types.js';

function buildEmbeddingText(input: CreateDecisionInput): string {
  return [
    input.title,
    input.description,
    input.reasoning,
    ...(input.tags ?? []),
    ...(input.affects ?? []),
  ]
    .filter(Boolean)
    .join(' ');
}

async function fetchDecisionById(id: string): Promise<Decision> {
  const db = getDb();
  const sql = `SELECT * FROM decisions WHERE id = ?`;
  const result = await db.query<Record<string, unknown>>(sql, [id]);

  if (result.rows.length === 0) {
    throw new NotFoundError('Decision', id);
  }
  return parseDecision(result.rows[0]);
}

// --- Decision CRUD ---

/**
 * Insert a new decision and generate its embedding.
 */
export async function createDecision(input: CreateDecisionInput): Promise<Decision> {
  const db = getDb();
  const embeddingText = buildEmbeddingText(input);
  const embedding = await generateEmbedding(embeddingText);
  const embeddingStr = `[${embedding.join(',')}]`;

  const result = await db.query<Record<string, unknown>>(
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
      input.project_id,
      input.title,
      input.description,
      input.reasoning,
      input.made_by,
      input.source ?? 'manual',
      input.source_session_id ?? null,
      input.confidence ?? 'medium',
      input.status ?? 'active',
      input.supersedes_id ?? null,
      JSON.stringify(input.alternatives_considered ?? []),
      db.arrayParam(input.affects ?? []),
      db.arrayParam(input.tags ?? []),
      JSON.stringify(input.assumptions ?? []),
      JSON.stringify(input.open_questions ?? []),
      JSON.stringify(input.dependencies ?? []),
      input.confidence_decay_rate ?? 0,
      JSON.stringify(input.metadata ?? {}),
      embeddingStr,
    ],
  );

  return parseDecision(result.rows[0]);
}

/**
 * Retrieve a single decision by ID. Throws NotFoundError if missing.
 */
export async function getDecision(id: string): Promise<Decision> {
  return fetchDecisionById(id);
}

/**
 * Update mutable fields of a decision by ID.
 */
export async function updateDecision(
  id: string,
  updates: Partial<CreateDecisionInput>,
): Promise<Decision> {
  const db = getDb();
  await fetchDecisionById(id);

  const setClauses: string[] = [];
  const values: unknown[] = [];

  const addField = (col: string, val: unknown, asJson = false) => {
    setClauses.push(`${col} = ?`);
    values.push(asJson ? JSON.stringify(val) : val);
  };

  if (updates.title !== undefined) addField('title', updates.title);
  if (updates.description !== undefined) addField('description', updates.description);
  if (updates.reasoning !== undefined) addField('reasoning', updates.reasoning);
  if (updates.made_by !== undefined) addField('made_by', updates.made_by);
  if (updates.source !== undefined) addField('source', updates.source);
  if (updates.source_session_id !== undefined)
    addField('source_session_id', updates.source_session_id);
  if (updates.confidence !== undefined) addField('confidence', updates.confidence);
  if (updates.status !== undefined) addField('status', updates.status);
  if (updates.supersedes_id !== undefined) addField('supersedes_id', updates.supersedes_id);
  if (updates.alternatives_considered !== undefined)
    addField('alternatives_considered', updates.alternatives_considered, true);
  if (updates.affects !== undefined) {
    setClauses.push(`affects = ?`);
    values.push(db.arrayParam(updates.affects));
  }
  if (updates.tags !== undefined) {
    setClauses.push(`tags = ?`);
    values.push(db.arrayParam(updates.tags));
  }
  if (updates.assumptions !== undefined) addField('assumptions', updates.assumptions, true);
  if (updates.open_questions !== undefined)
    addField('open_questions', updates.open_questions, true);
  if (updates.dependencies !== undefined) addField('dependencies', updates.dependencies, true);
  if (updates.confidence_decay_rate !== undefined)
    addField('confidence_decay_rate', updates.confidence_decay_rate);
  if (updates.metadata !== undefined) addField('metadata', updates.metadata, true);

  const contentChanged =
    updates.title !== undefined ||
    updates.description !== undefined ||
    updates.reasoning !== undefined ||
    updates.tags !== undefined ||
    updates.affects !== undefined;

  if (contentChanged) {
    const current = await fetchDecisionById(id);
    const merged: CreateDecisionInput = {
      project_id: current.project_id,
      title: updates.title ?? current.title,
      description: updates.description ?? current.description,
      reasoning: updates.reasoning ?? current.reasoning,
      tags: updates.tags ?? current.tags,
      affects: updates.affects ?? current.affects,
      made_by: current.made_by,
    };
    const embedding = await generateEmbedding(buildEmbeddingText(merged));
    const embeddingStr = `[${embedding.join(',')}]`;
    setClauses.push(`embedding = ?`);
    values.push(embeddingStr);
  }

  setClauses.push(`updated_at = NOW()`);

  if (setClauses.length === 1) {
    return fetchDecisionById(id);
  }

  values.push(id);
  const result = await db.query<Record<string, unknown>>(
    `UPDATE decisions SET ${setClauses.join(', ')} WHERE id = ? RETURNING *`,
    values,
  );

  return parseDecision(result.rows[0]);
}

/**
 * List decisions for a project with optional filters.
 */
export async function listDecisions(
  projectId: string,
  filters?: {
    status?: Decision['status'];
    tags?: string[];
    made_by?: string;
    limit?: number;
    offset?: number;
  },
): Promise<Decision[]> {
  const db = getDb();
  const conditions: string[] = ['project_id = ?'];
  const values: unknown[] = [projectId];

  if (filters?.status) {
    conditions.push(`status = ?`);
    values.push(filters.status);
  }

  if (filters?.made_by) {
    conditions.push(`made_by = ?`);
    values.push(filters.made_by);
  }

  if (filters?.tags && filters.tags.length > 0) {
    // For tag array overlap: dialect-specific
    if (db.dialect === 'postgres') {
      conditions.push(`tags && ?`);
      values.push(db.arrayParam(filters.tags));
    } else {
      // SQLite: use JSON overlap via EXISTS subquery or JSON_EACH
      const tagPlaceholders = filters.tags.map(() => '?').join(', ');
      conditions.push(
        `EXISTS (SELECT 1 FROM json_each(tags) WHERE value IN (${tagPlaceholders}))`,
      );
      values.push(...filters.tags);
    }
  }

  const limit = filters?.limit ?? 50;
  const offset = filters?.offset ?? 0;

  const sql = `
    SELECT * FROM decisions
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `;
  values.push(limit, offset);

  const result = await db.query<Record<string, unknown>>(sql, values);
  return result.rows.map(parseDecision);
}

/**
 * Vector similarity search using the adapter's vectorSearch method.
 */
export async function searchDecisionsByEmbedding(
  projectId: string,
  embedding: number[],
  limit = 10,
): Promise<Decision[]> {
  const db = getDb();
  const result = await db.vectorSearch('decisions', 'embedding', embedding, limit, {
    project_id: projectId,
  });
  return result.rows.map(parseDecision);
}

// --- Edge CRUD ---

/**
 * Create an edge between two decisions.
 */
export async function createEdge(input: CreateEdgeInput): Promise<DecisionEdge> {
  const db = getDb();
  await fetchDecisionById(input.source_id);
  await fetchDecisionById(input.target_id);

  const result = await db.query<Record<string, unknown>>(
    `INSERT INTO decision_edges (source_id, target_id, relationship, description, strength)
     VALUES (?, ?, ?, ?, ?)
     RETURNING *`,
    [
      input.source_id,
      input.target_id,
      input.relationship,
      input.description ?? null,
      input.strength ?? 1.0,
    ],
  );

  return parseEdge(result.rows[0]);
}

/**
 * Retrieve all edges connected to a decision (as source or target).
 */
export async function getEdges(decisionId: string): Promise<DecisionEdge[]> {
  const db = getDb();
  const result = await db.query<Record<string, unknown>>(
    `SELECT * FROM decision_edges
     WHERE source_id = ? OR target_id = ?
     ORDER BY created_at ASC`,
    [decisionId, decisionId],
  );
  return result.rows.map(parseEdge);
}

/**
 * Delete an edge by ID.
 */
export async function deleteEdge(id: string): Promise<void> {
  const db = getDb();
  const result = await db.query(`DELETE FROM decision_edges WHERE id = ?`, [id]);
  if ((result.rowCount ?? 0) === 0) {
    throw new NotFoundError('DecisionEdge', id);
  }
}

// --- Graph Traversal ---

/**
 * Get connected decisions using a recursive CTE traversal.
 * Works on both SQLite and PostgreSQL without requiring the pg function.
 */
export async function getConnectedDecisions(
  decisionId: string,
  maxDepth = 3,
): Promise<GraphNode[]> {
  await fetchDecisionById(decisionId);
  return getConnectedDecisionsFallback(decisionId, maxDepth);
}

/**
 * Recursive CTE traversal — works on both SQLite and PostgreSQL.
 */
async function getConnectedDecisionsFallback(
  decisionId: string,
  maxDepth: number,
): Promise<GraphNode[]> {
  const db = getDb();
  const result = await db.query<{
    decision_id: string;
    depth: number;
    via_relationship: string;
  }>(
    `WITH RECURSIVE graph AS (
       SELECT
         target_id   AS decision_id,
         1           AS depth,
         relationship AS via_relationship
       FROM decision_edges
       WHERE source_id = ?
       UNION ALL
       SELECT
         e.target_id,
         g.depth + 1,
         e.relationship
       FROM decision_edges e
       JOIN graph g ON e.source_id = g.decision_id
       WHERE g.depth < ?
     )
     SELECT DISTINCT decision_id, MIN(depth) AS depth, via_relationship
     FROM graph
     GROUP BY decision_id, via_relationship
     ORDER BY decision_id`,
    [decisionId, maxDepth],
  );

  const nodes: GraphNode[] = [];
  for (const row of result.rows) {
    try {
      const decision = await fetchDecisionById(row.decision_id);
      nodes.push({
        decision,
        depth: row.depth,
        via_relationship: row.via_relationship,
      });
    } catch {
      // Skip missing decisions
    }
  }
  return nodes;
}

/**
 * Return nodes and edges for graph visualization centered on a decision.
 */
export async function getGraph(decisionId: string, depth = 2): Promise<GraphResult> {
  const db = getDb();
  const rootDecision = await fetchDecisionById(decisionId);
  const connectedNodes = await getConnectedDecisions(decisionId, depth);

  const decisionIds = [decisionId, ...connectedNodes.map((n) => n.decision.id)];

  const uniqueIds = [...new Set(decisionIds)];

  const placeholders = uniqueIds.map(() => `?`).join(', ');
  const edgesResult = await db.query<Record<string, unknown>>(
    `SELECT * FROM decision_edges
     WHERE source_id IN (${placeholders})
        OR target_id IN (${placeholders})`,
    [...uniqueIds, ...uniqueIds],
  );

  const idSet = new Set(uniqueIds);
  const edges = edgesResult.rows
    .map(parseEdge)
    .filter((e) => idSet.has(e.source_id) && idSet.has(e.target_id));

  const nodes = [rootDecision, ...connectedNodes.map((n) => n.decision)];

  const seen = new Set<string>();
  const uniqueNodes: Decision[] = [];
  for (const n of nodes) {
    if (!seen.has(n.id)) {
      seen.add(n.id);
      uniqueNodes.push(n);
    }
  }

  return { nodes: uniqueNodes, edges };
}

// --- Supersession ---

/**
 * Create a new decision that supersedes an existing one.
 * - Creates the new decision
 * - Marks the old decision as 'superseded'
 * - Creates a 'supersedes' edge from new → old
 */
export async function supersedeDecision(
  oldId: string,
  newInput: CreateDecisionInput,
): Promise<{ newDecision: Decision; oldDecision: Decision }> {
  await fetchDecisionById(oldId);

  const db = getDb();
  return db.transaction(async (txQuery) => {
    const embeddingText = buildEmbeddingText(newInput);
    const embedding = await generateEmbedding(embeddingText);
    const embeddingStr = `[${embedding.join(',')}]`;

    const insertResult = await txQuery(
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
        newInput.project_id,
        newInput.title,
        newInput.description,
        newInput.reasoning,
        newInput.made_by,
        newInput.source ?? 'manual',
        newInput.source_session_id ?? null,
        newInput.confidence ?? 'medium',
        newInput.status ?? 'active',
        oldId, // supersedes_id points to the old decision
        JSON.stringify(newInput.alternatives_considered ?? []),
        db.arrayParam(newInput.affects ?? []),
        db.arrayParam(newInput.tags ?? []),
        JSON.stringify(newInput.assumptions ?? []),
        JSON.stringify(newInput.open_questions ?? []),
        JSON.stringify(newInput.dependencies ?? []),
        newInput.confidence_decay_rate ?? 0,
        JSON.stringify(newInput.metadata ?? {}),
        embeddingStr,
      ],
    );

    const newDecision = parseDecision(insertResult.rows[0]);

    const updateResult = await txQuery(
      `UPDATE decisions SET status = 'superseded', updated_at = NOW()
       WHERE id = ? RETURNING *`,
      [oldId],
    );
    const oldDecision = parseDecision(updateResult.rows[0]);

    await txQuery(
      `INSERT INTO decision_edges (source_id, target_id, relationship, strength)
       VALUES (?, ?, 'supersedes', 1.0)`,
      [newDecision.id, oldId],
    );

    return { newDecision, oldDecision };
  });
}

/**
 * Follow the supersedes_id chain from a decision back to the original.
 */
export async function getSupersessionChain(decisionId: string): Promise<Decision[]> {
  const chain: Decision[] = [];
  const visited = new Set<string>();

  let currentId: string | undefined = decisionId;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const decision = await fetchDecisionById(currentId);
    chain.push(decision);
    currentId = decision.supersedes_id;
  }

  return chain;
}

// --- Impact Analysis ---

/**
 * Analyse the downstream impact of a decision:
 * - downstream decisions (those that depend on or are informed by this one)
 * - affected agents (whose 'affects' matches decision's affects)
 * - blocking decisions (edges where this decision is the target of a 'blocks' relationship)
 * - supersession chain
 */
export async function getImpact(decisionId: string): Promise<ImpactAnalysis> {
  const db = getDb();
  const decision = await fetchDecisionById(decisionId);

  const downstreamEdgesResult = await db.query<Record<string, unknown>>(
    `SELECT DISTINCT d.* FROM decisions d
     JOIN decision_edges e ON e.target_id = d.id
     WHERE e.source_id = ? AND e.relationship IN ('requires', 'informs', 'enables', 'depends_on', 'refines')`,
    [decisionId],
  );
  const downstreamDecisions = downstreamEdgesResult.rows.map(parseDecision);

  let affectedAgents: Agent[] = [];
  if (decision.affects.length > 0) {
    const agentsResult = await db.query<Record<string, unknown>>(
      `SELECT * FROM agents
       WHERE project_id = ?`,
      [decision.project_id],
    );
    affectedAgents = agentsResult.rows
      .map(parseAgent)
      .filter(
        (agent) => decision.affects.includes(agent.role) || decision.affects.includes(agent.name),
      );
  }

  const blockingResult = await db.query<Record<string, unknown>>(
    `SELECT DISTINCT d.* FROM decisions d
     JOIN decision_edges e ON e.source_id = d.id
     WHERE e.target_id = ? AND e.relationship = 'blocks'`,
    [decisionId],
  );
  const blockingDecisions = blockingResult.rows.map(parseDecision);

  const supersessionChain = await getSupersessionChain(decisionId);
  const chainWithoutSelf = supersessionChain.slice(1);

  return {
    decision,
    downstream_decisions: downstreamDecisions,
    affected_agents: affectedAgents,
    cached_contexts_invalidated: 0, // Actual cache invalidation handled by context compiler
    blocking_decisions: blockingDecisions,
    supersession_chain: chainWithoutSelf,
  };
}
