import crypto from 'node:crypto';
import { query } from '../db/pool.js';
import {
  parseAgent,
  parseDecision,
  parseArtifact,
  parseSession,
  parseNotification,
} from '../db/parsers.js';
import { NexusError, NotFoundError } from '../types.js';
import { computeFreshness, blendScores, computeEffectiveConfidence } from '../temporal/index.js';
import type {
  Agent,
  Decision,
  ScoredDecision,
  ScoredArtifact,
  Artifact,
  Notification,
  SessionSummary,
  CompileRequest,
  ContextPackage,
  ScoringBreakdown,
} from '../types.js';

// Embedding helper — imported from decision-graph (generated at runtime).
// We use a dynamic import shape so the module can be provided at runtime.
let _generateEmbedding: ((text: string) => Promise<number[]>) | null = null;

async function getEmbeddingFn(): Promise<(text: string) => Promise<number[]>> {
  if (_generateEmbedding) return _generateEmbedding;
  try {
    const mod = await import('../decision-graph/embeddings.js');
    _generateEmbedding = mod.generateEmbedding as (text: string) => Promise<number[]>;
    return _generateEmbedding;
  } catch {
    // Fallback: return a zero vector of dimension 1536 when the module is absent.
    _generateEmbedding = async (_text: string) => new Array(1536).fill(0) as number[];
    return _generateEmbedding;
  }
}

/**
 * Compute cosine similarity between two equal-length numeric vectors.
 * Returns 0 if either vector has zero magnitude.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

function statusPenalty(decision: Decision, agent: Agent): number {
  switch (decision.status) {
    case 'active':
    case 'pending':
      return 1.0;
    case 'superseded':
      return agent.relevance_profile.include_superseded ? 0.4 : 0.1;
    case 'reverted':
      return 0.05;
    default:
      return 1.0;
  }
}

/**
 * Score a single decision for a specific agent using the 5-signal algorithm.
 *
 * Signal A (0.40): Direct affect — agent name or role in decision.affects
 * Signal B (0.20): Tag matching — average weight of matching profile tags
 * Signal C (0.15): Role relevance — count of high-priority tag matches
 * Signal D (0.25): Semantic similarity — cosine similarity of embeddings
 * Signal E     : Status penalty multiplier
 */
export function scoreDecision(
  decision: Decision,
  agent: Agent,
  taskEmbedding: number[],
): ScoredDecision {
  const profile = agent.relevance_profile;

  // Signal A: Direct Affect
  const affectsLower = decision.affects.map((a) => a.toLowerCase());
  const agentNameLower = agent.name.toLowerCase();
  const agentRoleLower = agent.role.toLowerCase();
  const directAffect =
    affectsLower.includes(agentNameLower) || affectsLower.includes(agentRoleLower) ? 0.4 : 0.0;

  // Signal B: Tag Matching
  const profileWeights = profile.weights;
  const matchingTags = decision.tags.filter((tag) => profileWeights[tag] !== undefined);
  let tagMatching = 0;
  if (matchingTags.length > 0) {
    const sumWeights = matchingTags.reduce((sum, tag) => sum + (profileWeights[tag] ?? 0), 0);
    const avgWeight = sumWeights / matchingTags.length;
    tagMatching = avgWeight * 0.2;
  }

  // Signal C: Role Relevance — tags with weight >= 0.8 are "high-priority"
  const highPriorityTags = Object.entries(profileWeights)
    .filter(([, w]) => w >= 0.8)
    .map(([tag]) => tag);
  const highPriorityMatches = decision.tags.filter((tag) => highPriorityTags.includes(tag)).length;
  const roleRelevance = Math.min(1.0, highPriorityMatches * 0.25) * 0.15;

  // Signal D: Semantic Similarity
  const decisionEmbedding = decision.embedding ?? [];
  const semanticSimilarity =
    decisionEmbedding.length > 0 && taskEmbedding.length > 0
      ? cosineSimilarity(taskEmbedding, decisionEmbedding) * 0.25
      : 0;

  // Signal E: Status Penalty multiplier
  const penalty = statusPenalty(decision, agent);

  const rawScore = directAffect + tagMatching + roleRelevance + semanticSimilarity;
  const penalizedScore = rawScore * penalty;

  // Freshness — exponential decay with validated/unvalidated half-lives
  const freshness = computeFreshness(decision);

  // Confidence decay — low-confidence decisions rank lower
  const effectiveConfidence = computeEffectiveConfidence(decision);
  const confidenceMultiplier = 0.5 + 0.5 * effectiveConfidence;

  // Blend relevance and freshness per agent preference
  const blended = blendScores(
    penalizedScore,
    freshness,
    agent.relevance_profile.freshness_preference,
  );
  const combined = blended * confidenceMultiplier;

  const breakdown: ScoringBreakdown = {
    direct_affect: directAffect,
    tag_matching: tagMatching,
    role_relevance: roleRelevance,
    semantic_similarity: semanticSimilarity,
    status_penalty: penalty,
    freshness,
    combined,
  };

  return {
    ...decision,
    relevance_score: rawScore,
    freshness_score: freshness,
    combined_score: combined,
    scoring_breakdown: breakdown,
  };
}

// --- Cache helpers ---

function buildTaskHash(agentId: string, taskDescription: string): string {
  return crypto.createHash('sha256').update(`${agentId}::${taskDescription}`).digest('hex');
}

interface CacheRow {
  id: string;
  compiled_context: unknown;
  expires_at: Date;
  decision_ids_included: string[];
  artifact_ids_included: string[];
  token_count: number;
}

async function readCache(agentId: string, taskHash: string): Promise<ContextPackage | null> {
  const result = await query<Record<string, unknown>>(
    `SELECT id, compiled_context, expires_at, decision_ids_included, artifact_ids_included, token_count
       FROM context_cache
      WHERE agent_id = $1 AND task_hash = $2 AND expires_at > NOW()
      LIMIT 1`,
    [agentId, taskHash],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0] as unknown as CacheRow;
  return row.compiled_context as ContextPackage;
}

async function writeCache(
  agentId: string,
  taskHash: string,
  pkg: ContextPackage,
  decisionIds: string[],
  artifactIds: string[],
): Promise<void> {
  await query(
    `INSERT INTO context_cache
       (agent_id, task_hash, compiled_context, decision_ids_included, artifact_ids_included, token_count, compiled_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW() + INTERVAL '1 hour')
     ON CONFLICT (agent_id, task_hash) DO UPDATE
       SET compiled_context = EXCLUDED.compiled_context,
           decision_ids_included = EXCLUDED.decision_ids_included,
           artifact_ids_included = EXCLUDED.artifact_ids_included,
           token_count = EXCLUDED.token_count,
           compiled_at = NOW(),
           expires_at = NOW() + INTERVAL '1 hour'`,
    [agentId, taskHash, JSON.stringify(pkg), decisionIds, artifactIds, pkg.token_count],
  );
}

// --- Token budget packing ---

/** Rough token estimate: chars / 4 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function packItems<T>(
  items: T[],
  scorer: (item: T) => number,
  tokenizer: (item: T) => number,
  budget: number,
): T[] {
  const sorted = [...items].sort((a, b) => scorer(b) - scorer(a));
  const packed: T[] = [];
  let used = 0;
  for (const item of sorted) {
    const t = tokenizer(item);
    if (used + t <= budget) {
      packed.push(item);
      used += t;
    }
  }
  return packed;
}

// --- Graph expansion — fetch neighbors via decision_edges ---

interface ExpandedDecision {
  decision: Decision;
  parentScore: number;
  depth: number;
}

async function expandGraphContext(
  topDecisions: ScoredDecision[],
  maxDepth: number,
  allDecisionMap: Map<string, Decision>,
): Promise<ExpandedDecision[]> {
  const visited = new Set<string>(topDecisions.map((d) => d.id));
  const expansions: ExpandedDecision[] = [];

  // BFS queue: [decisionId, parentScore, depth]
  const queue: Array<{ id: string; parentScore: number; depth: number }> = topDecisions.map(
    (d) => ({ id: d.id, parentScore: d.combined_score, depth: 1 }),
  );

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    const { id, parentScore, depth } = item;
    if (depth > maxDepth) continue;

    const edgeResult = await query<Record<string, unknown>>(
      `SELECT DISTINCT
         CASE WHEN source_id = $1 THEN target_id ELSE source_id END AS neighbor_id
       FROM decision_edges
      WHERE source_id = $1 OR target_id = $1`,
      [id],
    );

    for (const row of edgeResult.rows) {
      const neighborId = row['neighbor_id'] as string;
      if (visited.has(neighborId)) continue;
      visited.add(neighborId);

      const neighbor = allDecisionMap.get(neighborId);
      if (!neighbor) continue;

      const decayedScore = parentScore * Math.pow(0.6, depth);
      expansions.push({ decision: neighbor, parentScore: decayedScore, depth });

      if (depth < maxDepth) {
        queue.push({ id: neighborId, parentScore: decayedScore, depth: depth + 1 });
      }
    }
  }

  return expansions;
}

// --- Markdown + JSON formatters ---

function formatTemporalFlags(d: ScoredDecision): string {
  const flags: string[] = [];
  if (d.open_questions.length > 0) {
    flags.push(`⚠️ Open questions: ${d.open_questions.join('; ')}`);
  }
  if (d.assumptions.length > 0) {
    flags.push(`🔷 Assumptions: ${d.assumptions.join('; ')}`);
  }
  return flags.length > 0 ? `\n${flags.join('\n')}` : '';
}

function formatMarkdown(
  agent: Agent,
  request: CompileRequest,
  compiledAt: string,
  decisions: ScoredDecision[],
  artifacts: ScoredArtifact[],
  notifications: Notification[],
  sessions: SessionSummary[],
  totalTokens: number,
): string {
  const lines: string[] = [];

  lines.push(`# Context for ${agent.name} (${agent.role})`);
  lines.push(`## Task: ${request.task_description}`);
  lines.push(`*Compiled at ${compiledAt} | ${decisions.length} decisions | ${totalTokens} tokens*`);
  lines.push('');

  lines.push('## 🔔 Notifications');
  if (notifications.length === 0) {
    lines.push('_No unread notifications._');
  } else {
    for (const n of notifications) {
      const urgencyBadge = n.urgency === 'critical' || n.urgency === 'high' ? '🔴' : '🟡';
      lines.push(`- ${urgencyBadge} **[${n.notification_type}]** ${n.message}`);
      if (n.role_context) {
        lines.push(`  _${n.role_context}_`);
      }
    }
  }
  lines.push('');

  lines.push('## 📋 Active Decisions');
  if (decisions.length === 0) {
    lines.push('_No relevant decisions found._');
  } else {
    for (const d of decisions) {
      lines.push(`### ${d.title} (score: ${d.combined_score.toFixed(2)})`);
      lines.push(
        `**Status:** ${d.status} | **Confidence:** ${d.confidence} | **By:** ${d.made_by}`,
      );
      lines.push(`**Description:** ${d.description}`);
      lines.push(`**Reasoning:** ${d.reasoning}`);
      if (d.tags.length > 0) {
        lines.push(`**Tags:** ${d.tags.join(', ')}`);
      }
      if (d.affects.length > 0) {
        lines.push(`**Affects:** ${d.affects.join(', ')}`);
      }
      if (d.dependencies.length > 0) {
        lines.push(`**Dependencies:** ${d.dependencies.join(', ')}`);
      }
      const temporalFlags = formatTemporalFlags(d);
      if (temporalFlags) {
        lines.push(temporalFlags);
      }
      lines.push('');
    }
  }

  lines.push('## 📦 Artifacts');
  if (artifacts.length === 0) {
    lines.push('_No relevant artifacts found._');
  } else {
    for (const a of artifacts) {
      lines.push(`### ${a.name} (${a.artifact_type}) — relevance: ${a.relevance_score.toFixed(2)}`);
      if (a.description) lines.push(`**Description:** ${a.description}`);
      if (a.content_summary) lines.push(`**Summary:** ${a.content_summary}`);
      if (a.path) lines.push(`**Path:** \`${a.path}\``);
      lines.push(`**Produced by:** ${a.produced_by}`);
      lines.push('');
    }
  }

  lines.push('## 📝 Recent Sessions');
  if (sessions.length === 0) {
    lines.push('_No recent sessions found._');
  } else {
    for (const s of sessions) {
      lines.push(`### ${s.topic} — ${s.session_date}`);
      lines.push(`**Agent:** ${s.agent_name}`);
      lines.push(s.summary);
      if (s.lessons_learned.length > 0) {
        lines.push(`**Lessons:** ${s.lessons_learned.join('; ')}`);
      }
      if (s.open_questions.length > 0) {
        lines.push(`**Open questions:** ${s.open_questions.join('; ')}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

// --- Audit log helper ---

async function writeAuditLog(
  agentId: string,
  projectId: string,
  details: Record<string, unknown>,
): Promise<void> {
  await query(
    `INSERT INTO audit_log (event_type, agent_id, project_id, details)
     VALUES ($1, $2, $3, $4)`,
    ['context_compiled', agentId, projectId, JSON.stringify(details)],
  );
}

/**
 * Compile a rich context package for an agent performing a specific task.
 * Implements the full 5-signal scoring pipeline with graph expansion,
 * cache, token budget packing, and dual-format output.
 */
export async function compileContext(request: CompileRequest): Promise<ContextPackage> {
  const startMs = Date.now();
  const compiledAt = new Date().toISOString();

  const { agent_name, project_id, task_description, session_lookback_days = 7 } = request;

  const agentResult = await query<Record<string, unknown>>(
    `SELECT * FROM agents WHERE project_id = $1 AND name = $2 LIMIT 1`,
    [project_id, agent_name],
  );
  if (agentResult.rows.length === 0) {
    throw new NotFoundError('Agent', `${agent_name} in project ${project_id}`);
  }
  const agent = parseAgent(agentResult.rows[0]!);
  const tokenBudget = request.max_tokens ?? agent.context_budget_tokens;

  const taskHash = buildTaskHash(agent.id, task_description);
  const cached = await readCache(agent.id, taskHash);
  if (cached) return cached;

  let decisionQuery = `SELECT * FROM decisions WHERE project_id = $1`;
  const queryParams: unknown[] = [project_id];

  if (!agent.relevance_profile.include_superseded && !request.include_superseded) {
    decisionQuery += ` AND status != 'superseded'`;
  }
  decisionQuery += ` ORDER BY created_at DESC`;

  const decisionResult = await query<Record<string, unknown>>(decisionQuery, queryParams);
  const allDecisions = decisionResult.rows.map(parseDecision);

  const allDecisionMap = new Map<string, Decision>(allDecisions.map((d) => [d.id, d]));

  const generateEmbedding = await getEmbeddingFn();
  const taskEmbedding = await generateEmbedding(task_description);

  const scored = allDecisions.map((d) => scoreDecision(d, agent, taskEmbedding));

  const depth = agent.relevance_profile.decision_depth;

  // Take top-N scored decisions as seeds (configurable via decision_depth)
  const topN = Math.max(5, depth * 3);
  const topDecisions = [...scored]
    .sort((a, b) => b.combined_score - a.combined_score)
    .slice(0, topN);

  const expanded = await expandGraphContext(topDecisions, depth, allDecisionMap);

  const scoredIds = new Set(scored.map((d) => d.id));
  const expandedScored: ScoredDecision[] = expanded
    .filter((e) => !scoredIds.has(e.decision.id))
    .map((e) => {
      const base = scoreDecision(e.decision, agent, taskEmbedding);
      const decayed: ScoredDecision = {
        ...base,
        combined_score: e.parentScore,
        relevance_score: e.parentScore,
        scoring_breakdown: { ...base.scoring_breakdown, combined: e.parentScore },
      };
      return decayed;
    });

  const allScored = [...scored, ...expandedScored];

  const artifactResult = await query<Record<string, unknown>>(
    `SELECT * FROM artifacts WHERE project_id = $1 ORDER BY created_at DESC`,
    [project_id],
  );
  const allArtifacts = artifactResult.rows.map(parseArtifact);

  const decisionScoreMap = new Map<string, number>(allScored.map((d) => [d.id, d.combined_score]));

  const scoredArtifacts: ScoredArtifact[] = allArtifacts.map((a) => {
    const relatedScores = a.related_decision_ids
      .map((id) => decisionScoreMap.get(id) ?? 0)
      .filter((s) => s > 0);
    const relevance_score =
      relatedScores.length > 0
        ? relatedScores.reduce((sum, s) => sum + s, 0) / relatedScores.length
        : 0;
    return { ...a, relevance_score };
  });

  const notifResult = await query<Record<string, unknown>>(
    `SELECT * FROM notifications
      WHERE agent_id = $1 AND read_at IS NULL
      ORDER BY created_at DESC`,
    [agent.id],
  );
  const notifications = notifResult.rows.map(parseNotification);

  const sessionResult = await query<Record<string, unknown>>(
    `SELECT * FROM session_summaries
      WHERE project_id = $1
        AND created_at >= NOW() - INTERVAL '1 day' * $2
      ORDER BY created_at DESC`,
    [project_id, session_lookback_days],
  );
  const sessions = sessionResult.rows.map(parseSession);

  // Token budget allocation: Notifications 10%, Decisions 55%, Artifacts 30%, Sessions remainder
  const notifBudget = Math.floor(tokenBudget * 0.1);
  const decisionBudget = Math.floor(tokenBudget * 0.55);
  const artifactBudget = Math.floor(tokenBudget * 0.3);

  const packedNotifications = packItems<Notification>(
    notifications,
    (n) =>
      n.urgency === 'critical' ? 4 : n.urgency === 'high' ? 3 : n.urgency === 'medium' ? 2 : 1,
    (n) => estimateTokens(n.message + (n.role_context ?? '')),
    notifBudget,
  );

  const packedDecisions = packItems<ScoredDecision>(
    allScored,
    (d) => d.combined_score,
    (d) => estimateTokens(d.title + d.description + d.reasoning),
    decisionBudget,
  );

  const packedArtifacts = packItems<ScoredArtifact>(
    scoredArtifacts,
    (a) => a.relevance_score,
    (a) => estimateTokens(a.name + (a.description ?? '') + (a.content_summary ?? '')),
    artifactBudget,
  );

  const usedSoFar =
    packedNotifications.reduce(
      (s, n) => s + estimateTokens(n.message + (n.role_context ?? '')),
      0,
    ) +
    packedDecisions.reduce((s, d) => s + estimateTokens(d.title + d.description + d.reasoning), 0) +
    packedArtifacts.reduce(
      (s, a) => s + estimateTokens(a.name + (a.description ?? '') + (a.content_summary ?? '')),
      0,
    );
  const sessionBudget = Math.max(0, tokenBudget - usedSoFar);

  const packedSessions = packItems<SessionSummary>(
    sessions,
    (_s) => 1, // equal priority — ordered by recency from query
    (s) => estimateTokens(s.topic + s.summary),
    sessionBudget,
  );

  const totalTokens =
    usedSoFar + packedSessions.reduce((s, ss) => s + estimateTokens(ss.topic + ss.summary), 0);

  const formatted_markdown = formatMarkdown(
    agent,
    request,
    compiledAt,
    packedDecisions,
    packedArtifacts,
    packedNotifications,
    packedSessions,
    totalTokens,
  );

  const formatted_json = JSON.stringify(
    {
      agent: { name: agent.name, role: agent.role },
      task: task_description,
      compiled_at: compiledAt,
      token_count: totalTokens,
      decisions: packedDecisions,
      artifacts: packedArtifacts,
      notifications: packedNotifications,
      recent_sessions: packedSessions,
    },
    null,
    2,
  );

  const pkg: ContextPackage = {
    agent: { name: agent.name, role: agent.role },
    task: task_description,
    compiled_at: compiledAt,
    token_count: totalTokens,
    budget_used_pct: Math.min(100, Math.round((totalTokens / tokenBudget) * 100)),
    decisions: packedDecisions,
    artifacts: packedArtifacts,
    notifications: packedNotifications,
    recent_sessions: packedSessions,
    formatted_markdown,
    formatted_json,
    decisions_considered: allScored.length,
    decisions_included: packedDecisions.length,
    relevance_threshold_used: 0, // no hard threshold — all packed by budget
    compilation_time_ms: Date.now() - startMs,
  };

  const includedDecisionIds = packedDecisions.map((d) => d.id);
  const includedArtifactIds = packedArtifacts.map((a) => a.id);

  try {
    await writeCache(agent.id, taskHash, pkg, includedDecisionIds, includedArtifactIds);
  } catch (err) {
    // Cache write failures are non-fatal
    console.warn('[nexus:context-compiler] Cache write failed:', (err as Error).message);
  }

  try {
    await writeAuditLog(agent.id, project_id, {
      agent_name,
      task_description,
      decisions_considered: allScored.length,
      decisions_included: packedDecisions.length,
      token_count: totalTokens,
      compilation_time_ms: pkg.compilation_time_ms,
    });
  } catch (err) {
    console.warn('[nexus:context-compiler] Audit log write failed:', (err as Error).message);
  }

  return pkg;
}

// Re-export scoreDecision and cosineSimilarity for external use
export { NexusError };
