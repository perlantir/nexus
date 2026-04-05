import crypto from 'node:crypto';
import { getDb } from '../db/index.js';
import { getPersona as _getPersonaImport } from '../config/agentPersonas.js';
import type { AgentPersona } from '../config/agentPersonas.js';
import {
  parseAgent,
  parseDecision,
  parseArtifact,
  parseSession,
  parseNotification,
} from '../db/parsers.js';
import { DeciGraphError, NotFoundError } from '../types.js';
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
// IMPORTANT: Do NOT cache the zero-vector fallback — retry the real import
// on every call so a transient import failure doesn't permanently disable
// semantic search for the lifetime of the process.
let _generateEmbedding: ((text: string) => Promise<number[]>) | null = null;
let _embeddingImportFailed = false;

const ZERO_VECTOR: number[] = new Array(1536).fill(0) as number[];

async function getEmbeddingFn(): Promise<(text: string) => Promise<number[]>> {
  if (_generateEmbedding) return _generateEmbedding;
  try {
    const mod = await import('../decision-graph/embeddings.js');
    _generateEmbedding = mod.generateEmbedding as (text: string) => Promise<number[]>;
    _embeddingImportFailed = false;
    return _generateEmbedding;
  } catch (err) {
    // Log but do NOT cache the fallback — retry the import next time.
    if (!_embeddingImportFailed) {
      console.warn('[decigraph/embeddings] Failed to import embeddings module — semantic search disabled for this call:', (err as Error).message);
      _embeddingImportFailed = true;
    }
    return async (_text: string) => [...ZERO_VECTOR];
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
function _getPersonaSafe(agentName: string): AgentPersona | undefined {
  try {
    return _getPersonaImport(agentName);
  } catch {
    return undefined;
  }
}

// V3 scoring weights — directAffect reduced, personaMatch nearly doubled
const SCORING_WEIGHTS = {
  directAffect: 0.30,
  tagMatch: 0.20,
  personaMatch: 0.25,  // This is THE differentiator between agents
  semanticSimilarity: 0.25,
};

// Post-processing thresholds
export const MIN_SCORE = 0.50;  // Raise to 0.72 once embeddings are live
export const MAX_RESULTS = 15;

// ── Deduplication ─────────────────────────────────────────────────────────

function deduplicateDecisions(decisions: ScoredDecision[]): ScoredDecision[] {
  const seen = new Set<string>();
  return decisions.filter((d) => {
    const normalized = d.title
      .toLowerCase()
      .replace(/\s*(in decigraph|across ops|for v1|for bouts|for agents)\s*$/i, '')
      .trim();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

// ── Single Output Funnel ──────────────────────────────────────────────────
// EVERY code path must go through this before returning decisions.

function finalizeResults(
  scored: ScoredDecision[],
  agentName: string,
  projectId: string,
  startMs: number,
  minScore: number = MIN_SCORE,
  maxResults: number = MAX_RESULTS,
): ScoredDecision[] {
  // Re-clamp all scores to [0, 1.0]
  for (const d of scored) {
    d.combined_score = Math.max(0, Math.min(1.0, d.combined_score));
  }

  const filtered = scored.filter((d) => d.combined_score >= minScore);
  const deduped = deduplicateDecisions(filtered);
  const sorted = deduped.sort((a, b) => b.combined_score - a.combined_score);
  const capped = sorted.slice(0, maxResults);

  // Normalize: map top score to 0.95, scale others proportionally
  if (capped.length > 0) {
    const maxScore = capped[0].combined_score;
    if (maxScore > 0) {
      const TARGET_MAX = 0.95;
      const scale = TARGET_MAX / maxScore;
      capped.forEach((d) => {
        d.combined_score = Math.round(d.combined_score * scale * 1000) / 1000;
      });
    }
  }

  // After normalization, ensure unique scores via micro-spread
  if (capped.length > 1) {
    for (let i = 1; i < capped.length; i++) {
      if (capped[i].combined_score >= capped[i - 1].combined_score) {
        // Use semantic_similarity to determine spread amount
        const sem = (capped[i].scoring_breakdown as unknown as Record<string, unknown>)?.semantic_similarity as number ?? 0;
        const prevSem = (capped[i - 1].scoring_breakdown as unknown as Record<string, unknown>)?.semantic_similarity as number ?? 0;
        const semDiff = Math.abs(sem - prevSem);
        // Minimum spread of 0.001, up to 0.005 based on semantic difference
        const spread = Math.max(0.001, Math.min(0.005, semDiff * 0.02));
        capped[i].combined_score = Math.round((capped[i - 1].combined_score - spread) * 1000) / 1000;
      }
    }
  }

  // One-line compile trace (always-on, permanent)
  const ms = Date.now() - startMs;
  console.log(
    `[decigraph/compile] agent=${agentName} project=${(projectId ?? '').slice(0, 8)}.. scored=${scored.length} passed=${capped.length} top=${(capped[0]?.combined_score ?? 0).toFixed(3)} semantic=${scored.filter((d) => ((d.scoring_breakdown as unknown) as Record<string, unknown>)?.semantic_similarity as number > 0).length} ms=${ms}`,
  );

  return capped;
}

// ── Conversational Explanation Generator ───────────────────────────────────

function generateExplanation(
  agentName: string,
  decision: { made_by?: string; confidence?: string },
  signals: {
    directAffect: number;
    matchedTags: string[];
    semanticScore: number;
    freshnessMultiplier: number;
    keywordScore: number;
  }
): string {
  const parts: string[] = [];

  // Lead with strongest signal
  if (signals.directAffect > 0) {
    parts.push(`Assigned directly to ${agentName}`);
  }

  // Describe tags in context of the agent's role
  if (signals.matchedTags.length > 0 && signals.directAffect > 0) {
    parts.push(`covers ${signals.matchedTags.slice(0, 3).join(', ')} \u2014 core to your role`);
  } else if (signals.matchedTags.length > 0) {
    parts.push(`Relevant to your focus on ${signals.matchedTags.slice(0, 3).join(', ')}`);
  }

  // Semantic match — only if meaningful
  if (signals.semanticScore > 0.3) {
    parts.push('closely matches your current task');
  } else if (signals.semanticScore > 0.15) {
    parts.push('related to your current task');
  }

  // Attribution
  if (decision.made_by && decision.made_by !== agentName) {
    parts.push(`decided by ${decision.made_by}`);
  }

  // Freshness
  if (signals.freshnessMultiplier > 1.05) {
    parts.push('recent decision');
  } else if (signals.freshnessMultiplier < 0.9) {
    parts.push('older decision \u2014 may need review');
  }

  // Confidence
  if (decision.confidence === 'low') {
    parts.push('low confidence \u2014 verify before acting');
  }

  // Fallback
  if (parts.length === 0) parts.push('Matches general project context');

  return parts.join('. ').replace(/^./, c => c.toUpperCase()) + '.';
}

export function scoreDecision(
  decision: Decision,
  agent: Agent,
  taskEmbedding: number[],
): ScoredDecision {
  const profile = agent.relevance_profile;
  const agentNameLower = agent.name.toLowerCase();
  const agentRoleLower = agent.role.toLowerCase();
  const decisionTags = (decision.tags ?? []).map((t) => t.toLowerCase());
  const affects = (decision.affects ?? []).map((a) => a.toLowerCase());

  // ── Signal A: Direct Affect (0 or 1) ──────────────────────────────
  // Check agent name, role, AND known aliases (e.g. 'pm' for 'makspm')
  const agentAliases = new Set([agentNameLower, agentRoleLower]);
  // Add common aliases
  if (agentNameLower === 'makspm') { agentAliases.add('pm'); agentAliases.add('maks_pm'); }
  if (agentNameLower === 'maks') { agentAliases.add('builder'); }
  const directAffectScore =
    affects.some((a) => agentAliases.has(a)) ? 1.0 : 0.0;

  // ── Signal B: Tag Matching (overlap with profile weights) ─────────
  const profileWeights = profile.weights;
  let tagMatchScore = 0;
  if (decisionTags.length > 0 && Object.keys(profileWeights).length > 0) {
    const matchingTags = decisionTags.filter((tag) => profileWeights[tag] !== undefined);
    if (matchingTags.length > 0) {
      const sumWeights = matchingTags.reduce((sum, tag) => sum + (profileWeights[tag] ?? 0.5), 0);
      tagMatchScore = sumWeights / decisionTags.length;
    }
  }

  // ── Signal C: Persona Match (primaryTags overlap - excludeTags penalty) ─
  const persona = _getPersonaSafe(agent.name);
  if (!persona) {
    console.warn(`[decigraph/scoring] No persona found for agent: "${agent.name}" — persona match signal will be 0`);
  }
  let personaMatchScore = 0;
  let excludePenalty = 0;
  if (persona && decisionTags.length > 0) {
    // Positive: overlap with primaryTags
    const primaryOverlap = persona.primaryTags.filter((t) => decisionTags.includes(t)).length;
    personaMatchScore = persona.primaryTags.length > 0
      ? (primaryOverlap / persona.primaryTags.length) * (persona.boostFactor / 0.20)
      : 0;
    // Negative: excludeTags penalty (-0.10 per match, capped at -0.20)
    const excludeHits = persona.excludeTags.filter((t) => decisionTags.includes(t)).length;
    excludePenalty = Math.min(excludeHits * 0.10, 0.20);
  }

  // ── Signal D: Semantic Similarity ─────────────────────────────────
  // Ensure embedding is number[] (pgvector may return string from DB)
  let decisionEmbedding: number[] = [];
  const rawEmb = decision.embedding as unknown;
  if (Array.isArray(rawEmb) && rawEmb.length > 0 && typeof rawEmb[0] === 'number') {
    decisionEmbedding = rawEmb;
  } else if (typeof rawEmb === 'string' && String(rawEmb).startsWith('[')) {
    try { decisionEmbedding = JSON.parse(rawEmb); } catch { /* invalid */ }
  }

  const semanticScore =
    decisionEmbedding.length > 0 && taskEmbedding.length > 0
      ? Math.max(0, cosineSimilarity(taskEmbedding, decisionEmbedding))
      : 0;

  // ── Signal E: Keyword Matching (title + description substring match) ──
  // Critical for agents like makspm and counsel where tag overlap is weak
  // but decision titles contain PM/legal language.
  let keywordScore = 0;
  if (persona && (persona.keywords ?? []).length > 0) {
    const titleLower = (decision.title ?? '').toLowerCase();
    const descLower = (decision.description ?? '').toLowerCase();
    const keywordHits = persona.keywords.filter((kw) =>
      titleLower.includes(kw.toLowerCase()) ||
      descLower.includes(kw.toLowerCase()),
    ).length;
    keywordScore = Math.min(keywordHits * 0.08, 0.20); // cap at 0.20
  }

  // ── Made-by bonus ─────────────────────────────────────────────────
  const madeByBonus = (decision.made_by ?? '').toLowerCase() === agentNameLower ? 0.15 : 0;

  // ── Weighted sum ──────────────────────────────────────────────────
  let finalScore =
    SCORING_WEIGHTS.directAffect * directAffectScore +
    SCORING_WEIGHTS.tagMatch * tagMatchScore +
    SCORING_WEIGHTS.personaMatch * personaMatchScore +
    SCORING_WEIGHTS.semanticSimilarity * semanticScore +
    keywordScore +
    madeByBonus -
    excludePenalty;

  // ── Specificity Multiplier ────────────────────────────────────────
  // Penalize generic decisions that affect everyone
  const affectsLen = (decision.affects ?? []).length;
  const specificityMultiplier =
    affectsLen <= 1 ? 1.15 :  // Very targeted
    affectsLen <= 3 ? 1.00 :  // Normal
    affectsLen <= 5 ? 0.85 :  // Broad
    0.70;                     // Generic — affects everyone
  finalScore *= specificityMultiplier;

  // ── Freshness Multiplier ──────────────────────────────────────────
  const ageInDays = (Date.now() - new Date(decision.created_at).getTime()) / 86400000;
  const freshnessMultiplier =
    ageInDays <= 7 ? 1.12 :   // Last week: strong boost
    ageInDays <= 30 ? 1.05 :  // Last month: mild boost
    ageInDays <= 90 ? 0.95 :  // 1-3 months: slight decay
    0.88;                     // Older: gentle penalty
  finalScore *= freshnessMultiplier;

  // ── Status Multiplier ─────────────────────────────────────────────
  if (decision.status === 'superseded') finalScore *= 0.4;
  if (decision.status === 'pending') finalScore *= 0.6;

  // ── Confidence Multiplier ─────────────────────────────────────────
  const confidenceMultiplier =
    decision.confidence === 'high' ? 1.15 :
    decision.confidence === 'medium' ? 1.00 :
    0.88;
  finalScore *= confidenceMultiplier;

  // ── Direct agent match bonus (flat add after multipliers) ─────────
  if (affects.some((a) => agentAliases.has(a))) finalScore += 0.25;

  // Normalize to [0, 1.0] — no score exceeds 1.0
  finalScore = Math.max(0, Math.min(1.0, finalScore));

  // ── Build human-readable explanation ────────────────────────────────
  // Collect matched tags (union of profile weight matches + persona primaryTag matches)
  const profileMatchedTags = decisionTags.filter((t) => profileWeights[t] !== undefined);
  const personaMatchedTags = persona ? persona.primaryTags.filter((t) => decisionTags.includes(t)) : [];
  const allMatchedTags = [...new Set([...profileMatchedTags, ...personaMatchedTags])];

  const explanation = generateExplanation(
    agent.name,
    { made_by: decision.made_by, confidence: decision.confidence },
    {
      directAffect: directAffectScore,
      matchedTags: allMatchedTags,
      semanticScore,
      freshnessMultiplier,
      keywordScore,
    },
  );

  const statusPenaltyVal = decision.status === 'superseded' ? 0.4 : decision.status === 'pending' ? 0.6 : 1.0;

  const breakdown: ScoringBreakdown = {
    direct_affect: directAffectScore,
    tag_matching: tagMatchScore,
    role_relevance: personaMatchScore,
    semantic_similarity: semanticScore,
    status_penalty: statusPenaltyVal,
    freshness: freshnessMultiplier,
    combined: finalScore,
    // V4 extended signals
    keyword_score: keywordScore,
    made_by_bonus: madeByBonus,
    confidence_multiplier: confidenceMultiplier,
    specificity_multiplier: specificityMultiplier,
    freshness_multiplier: freshnessMultiplier,
    exclude_penalty: excludePenalty,
    explanation,
  } as ScoringBreakdown;

  return {
    ...decision,
    relevance_score: SCORING_WEIGHTS.directAffect * directAffectScore + SCORING_WEIGHTS.tagMatch * tagMatchScore + SCORING_WEIGHTS.personaMatch * personaMatchScore + SCORING_WEIGHTS.semanticSimilarity * semanticScore,
    freshness_score: freshnessMultiplier,
    combined_score: finalScore,
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
  const db = getDb();
  const result = await db.query<Record<string, unknown>>(
    `SELECT id, compiled_context, expires_at, decision_ids_included, artifact_ids_included, token_count
       FROM context_cache
      WHERE agent_id = ? AND task_hash = ? AND expires_at > NOW()
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
  const db = getDb();
  await db.query(
    `INSERT INTO context_cache
       (agent_id, task_hash, compiled_context, decision_ids_included, artifact_ids_included, token_count, compiled_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW() + INTERVAL '1 hour')
     ON CONFLICT (agent_id, task_hash) DO UPDATE
       SET compiled_context = EXCLUDED.compiled_context,
           decision_ids_included = EXCLUDED.decision_ids_included,
           artifact_ids_included = EXCLUDED.artifact_ids_included,
           token_count = EXCLUDED.token_count,
           compiled_at = NOW(),
           expires_at = NOW() + INTERVAL '1 hour'`,
    [agentId, taskHash, JSON.stringify(pkg), db.arrayParam(decisionIds), db.arrayParam(artifactIds), pkg.token_count],
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
  const db = getDb();
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

    const edgeResult = await db.query<Record<string, unknown>>(
      `SELECT DISTINCT
         CASE WHEN source_id = ? THEN target_id ELSE source_id END AS neighbor_id
       FROM decision_edges
      WHERE source_id = ? OR target_id = ?`,
      [id, id, id],
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
  const db = getDb();
  await db.query(
    `INSERT INTO audit_log (event_type, agent_id, project_id, details)
     VALUES (?, ?, ?, ?)`,
    ['context_compiled', agentId, projectId, JSON.stringify(details)],
  );
}

/**
 * Compile a rich context package for an agent performing a specific task.
 * Implements the full 5-signal scoring pipeline with graph expansion,
 * cache, token budget packing, and dual-format output.
 */
export async function compileContext(request: CompileRequest): Promise<ContextPackage> {
  const db = getDb();
  const startMs = Date.now();
  const compiledAt = new Date().toISOString();

  const { agent_name, project_id, task_description, session_lookback_days = 7 } = request;

  // Agent lookup — try exact name first, then known aliases
  const AGENT_ALIASES: Record<string, string[]> = {
    makspm: ['pm', 'maks_pm', 'maks-pm', 'MaksPM'],
    maks: ['builder'],
  };

  let agentResult = await db.query<Record<string, unknown>>(
    `SELECT * FROM agents WHERE project_id = ? AND name = ? LIMIT 1`,
    [project_id, agent_name],
  );

  // If not found, try aliases
  if (agentResult.rows.length === 0) {
    const aliases = AGENT_ALIASES[agent_name.toLowerCase()] ?? [];
    for (const alias of aliases) {
      agentResult = await db.query<Record<string, unknown>>(
        `SELECT * FROM agents WHERE project_id = ? AND LOWER(name) = LOWER(?) LIMIT 1`,
        [project_id, alias],
      );
      if (agentResult.rows.length > 0) {
        console.warn(`[decigraph/compile] Agent "${agent_name}" not found, matched alias "${alias}"`);
        break;
      }
    }
  }

  // Also try case-insensitive match as last resort
  if (agentResult.rows.length === 0) {
    agentResult = await db.query<Record<string, unknown>>(
      `SELECT * FROM agents WHERE project_id = ? AND LOWER(name) = LOWER(?) LIMIT 1`,
      [project_id, agent_name],
    );
  }

  // Auto-create agent if not found after all lookups
  if (agentResult.rows.length === 0) {
    console.warn(`[decigraph/compile] Agent "${agent_name}" not found in project ${project_id.slice(0, 8)}.. — auto-creating`);
    const newAgent = await db.query(
      `INSERT INTO agents (id, project_id, name, role, relevance_profile, context_budget_tokens)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
      [
        crypto.randomUUID(),
        project_id,
        agent_name,
        agent_name, // role defaults to agent name
        JSON.stringify({ weights: {}, decision_depth: 2, freshness_preference: 'balanced', include_superseded: false }),
        50000,
      ],
    );
    agentResult = newAgent;
  }
  const agent = parseAgent(agentResult.rows[0]!);
  const tokenBudget = request.max_tokens ?? agent.context_budget_tokens;

  const taskHash = buildTaskHash(agent.id, task_description);
  const cached = await readCache(agent.id, taskHash);
  if (cached) {
    // Return cached data directly — it was already finalized before caching.
    // Do NOT re-run finalizeResults, which would double-normalize scores
    // and potentially filter out decisions that originally passed MIN_SCORE.
    const cachedDecisions = (cached.decisions ?? []) as ScoredDecision[];
    console.log(`[decigraph/compile] agent=${agent_name} CACHE HIT decisions=${cachedDecisions.length} ms=${Date.now() - startMs}`);
    return { ...cached, decisions: cachedDecisions, decisions_included: cachedDecisions.length };
  }

  let decisionQuery = `SELECT * FROM decisions WHERE project_id = ?`;
  const queryParams: unknown[] = [project_id];

  if (!agent.relevance_profile.include_superseded && !request.include_superseded) {
    decisionQuery += ` AND status != 'superseded'`;
  }
  decisionQuery += ` ORDER BY created_at DESC`;

  const decisionResult = await db.query<Record<string, unknown>>(decisionQuery, queryParams);
  const allDecisions = decisionResult.rows.map(parseDecision);

  const allDecisionMap = new Map<string, Decision>(allDecisions.map((d) => [d.id, d]));

  const generateEmbedding = await getEmbeddingFn();
  let taskEmbedding: number[];
  try {
    taskEmbedding = await generateEmbedding(task_description);
  } catch (err) {
    // Graceful degradation: if embedding generation fails (API down, rate limit,
    // network error), continue scoring without semantic similarity rather than
    // crashing the entire compile request.
    console.warn(`[decigraph/compile] Embedding generation failed for agent=${agent_name} — falling back to non-semantic scoring:`, (err as Error).message);
    taskEmbedding = [...ZERO_VECTOR];
  }

  const scored = allDecisions.map((d) => scoreDecision(d, agent, taskEmbedding));

  const depth = agent.relevance_profile.decision_depth;

  // Apply minimum score threshold and max results cap
  const qualifiedDecisions = scored
    .filter((d) => d.combined_score >= MIN_SCORE)
    .sort((a, b) => b.combined_score - a.combined_score)
    .slice(0, MAX_RESULTS);

  // Take top-N scored decisions as seeds (configurable via decision_depth)
  const topN = Math.max(25, depth * 5);
  const topDecisions = qualifiedDecisions.slice(0, topN);

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

  const artifactResult = await db.query<Record<string, unknown>>(
    `SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at DESC`,
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

  const notifResult = await db.query<Record<string, unknown>>(
    `SELECT * FROM notifications
      WHERE agent_id = ? AND read_at IS NULL
      ORDER BY created_at DESC`,
    [agent.id],
  );
  const notifications = notifResult.rows.map(parseNotification);

  const sessionResult = await db.query<Record<string, unknown>>(
    `SELECT * FROM session_summaries
      WHERE project_id = ?
        AND created_at >= NOW() - INTERVAL '1 day' * ?
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

  // SINGLE OUTPUT FUNNEL: filter + dedupe + sort + cap
  // Every code path goes through finalizeResults — no exceptions.
  // Log embedding / semantic health for this compile
  const semanticHits = allScored.filter((d) => ((d.scoring_breakdown as unknown) as Record<string, unknown>)?.semantic_similarity as number > 0).length;
  if (allScored.length > 0) {
    // One-time debug: log embedding types for first decision
    const first = allScored[0];
    const rawType = typeof first.embedding;
    const isArr = Array.isArray(first.embedding);
    const embLen = isArr ? (first.embedding as number[]).length : (typeof first.embedding === 'string' ? (first.embedding as string).length : 0);
    console.log(`[decigraph/embeddings] first_decision_embedding: type=${rawType} isArray=${isArr} len=${embLen} semanticHits=${semanticHits}/${allScored.length}`);
  }
  const packedDecisions = finalizeResults(allScored, agent_name, project_id, startMs);
  if (packedDecisions.length === 0 && allScored.length > 0) {
    console.warn('[decigraph/compile] WARNING: finalizeResults returned 0 but allScored had', allScored.length, 'items for agent', agent_name);
    console.warn('[decigraph/compile] Top score:', allScored[0]?.combined_score, 'MIN_SCORE:', MIN_SCORE);
  }

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
    relevance_threshold_used: MIN_SCORE,
    compilation_time_ms: Date.now() - startMs,
  };

  const includedDecisionIds = packedDecisions.map((d) => d.id);
  const includedArtifactIds = packedArtifacts.map((a) => a.id);

  try {
    await writeCache(agent.id, taskHash, pkg, includedDecisionIds, includedArtifactIds);
  } catch (err) {
    // Cache write failures are non-fatal
    console.warn('[decigraph:context-compiler] Cache write failed:', (err as Error).message);
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
    console.warn('[decigraph:context-compiler] Audit log write failed:', (err as Error).message);
  }

  return pkg;
}

// Re-export scoreDecision and cosineSimilarity for external use
export { DeciGraphError };
