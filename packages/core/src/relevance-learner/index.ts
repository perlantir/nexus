/**
 * Relevance Learner — evolves agent weights based on feedback signals.
 *
 * Rating signals:
 *   critical   → +0.10 (essential for the task)
 *   useful     → +0.03 (relevant to the task)
 *   irrelevant → -0.05 (appeared but not needed)
 *   missing    → +0.08 (wanted but not included)
 *
 * Algorithm:
 *   1. Collect feedback grouped by decision tags
 *   2. Compute average signal per tag
 *   3. adjustment = LEARNING_RATE * average_signal
 *   4. new_weight = clamp(current + adjustment, 0.0, 1.0)
 *   5. Only adjust tags with >= MIN_FEEDBACK entries
 *   6. Record changes in weight_history
 */

import { getDb } from '../db/index.js';
import { parseFeedback } from '../db/parsers.js';
import type { RelevanceFeedback, RelevanceProfile, CreateFeedbackInput } from '../types.js';
import { NotFoundError } from '../types.js';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Conservative learning rate — prevents wild swings. */
export const LEARNING_RATE = 0.05;

/** Minimum feedback entries per tag before adjusting. */
export const MIN_FEEDBACK_PER_TAG = 5;

/** Auto-apply threshold: run evolution after this many new feedback entries. */
export const AUTO_APPLY_THRESHOLD = 10;

/** Days without feedback before decaying toward defaults. */
export const DECAY_AFTER_DAYS = 30;

/** Decay rate per check — drift 10% toward default. */
export const DECAY_RATE = 0.10;

const WEIGHT_MIN = 0.0;
const WEIGHT_MAX = 1.0;

/** Signal values per rating type. */
export const RATING_SIGNALS: Record<string, number> = {
  critical: 0.10,
  useful: 0.03,
  irrelevant: -0.05,
  missing: 0.08,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WeightUpdate {
  tag: string;
  current_weight: number;
  adjustment: number;
  new_weight: number;
  feedback_count: number;
  signal: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function fetchAgentById(agentId: string): Promise<{
  id: string;
  project_id: string;
  role: string;
  relevance_profile: RelevanceProfile;
}> {
  const db = getDb();
  const result = await db.query<Record<string, unknown>>(
    'SELECT id, project_id, role, relevance_profile FROM agents WHERE id = ?',
    [agentId],
  );

  if (result.rows.length === 0) throw new NotFoundError('Agent', agentId);

  const row = result.rows[0];
  let profile: RelevanceProfile;
  const raw = row.relevance_profile;
  if (typeof raw === 'string') {
    try { profile = JSON.parse(raw) as RelevanceProfile; } catch {
      profile = { weights: {}, decision_depth: 2, freshness_preference: 'balanced', include_superseded: false };
    }
  } else if (raw && typeof raw === 'object') {
    profile = raw as RelevanceProfile;
  } else {
    profile = { weights: {}, decision_depth: 2, freshness_preference: 'balanced', include_superseded: false };
  }

  return { id: row.id as string, project_id: row.project_id as string, role: (row.role as string) ?? 'builder', relevance_profile: profile };
}

async function fetchDecisionTags(decisionId: string): Promise<string[]> {
  const db = getDb();
  const result = await db.query<{ tags: unknown }>('SELECT tags FROM decisions WHERE id = ?', [decisionId]);
  if (result.rows.length === 0) return [];
  const tags = result.rows[0].tags;
  if (Array.isArray(tags)) return tags as string[];
  if (typeof tags === 'string') {
    try { return JSON.parse(tags) as string[]; } catch { return []; }
  }
  return [];
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

// ---------------------------------------------------------------------------
// Feedback recording
// ---------------------------------------------------------------------------

/**
 * Record a single feedback entry with the new rating system.
 * Falls back to was_useful boolean for backward compatibility.
 */
export async function recordFeedback(input: CreateFeedbackInput): Promise<RelevanceFeedback> {
  const db = getDb();
  await fetchAgentById(input.agent_id);

  const decCheck = await db.query('SELECT id FROM decisions WHERE id = ?', [input.decision_id]);
  if (decCheck.rows.length === 0) throw new NotFoundError('Decision', input.decision_id);

  // Determine rating from new field or backward-compat was_useful
  const rating = (input as unknown as Record<string, unknown>).rating as string | undefined;
  const wasUseful = input.was_useful ?? (rating === 'useful' || rating === 'critical');

  const result = await db.query<Record<string, unknown>>(
    `INSERT INTO relevance_feedback
       (id, agent_id, decision_id, compile_request_id, was_useful, usage_signal, rating, task_description, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING *`,
    [
      randomUUID(),
      input.agent_id,
      input.decision_id,
      input.compile_request_id ?? null,
      db.dialect === 'sqlite' ? (wasUseful ? 1 : 0) : wasUseful,
      input.usage_signal ?? null,
      rating ?? (wasUseful ? 'useful' : 'irrelevant'),
      (input as unknown as Record<string, unknown>).task_description ?? null,
      (input as unknown as Record<string, unknown>).notes ?? null,
    ],
  );

  return parseFeedback(result.rows[0]);
}

/**
 * Record batch feedback entries.
 */
export async function recordBatchFeedback(
  agentId: string,
  compileRequestId: string | undefined,
  taskDescription: string | undefined,
  ratings: Array<{ decision_id: string; rating: string }>,
): Promise<{ recorded: number }> {
  const db = getDb();
  let recorded = 0;

  for (const entry of ratings) {
    const wasUseful = entry.rating === 'useful' || entry.rating === 'critical';
    try {
      await db.query(
        `INSERT INTO relevance_feedback
           (id, agent_id, decision_id, compile_request_id, was_useful, rating, task_description)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          agentId,
          entry.decision_id,
          compileRequestId ?? null,
          db.dialect === 'sqlite' ? (wasUseful ? 1 : 0) : wasUseful,
          entry.rating,
          taskDescription ?? null,
        ],
      );
      recorded++;
    } catch (err) {
      console.warn(`[decigraph:learner] Feedback skipped for ${entry.decision_id}: ${(err as Error).message}`);
    }
  }

  return { recorded };
}

/**
 * Get feedback history for an agent.
 */
export async function getFeedbackForAgent(
  agentId: string,
  limit = 50,
): Promise<RelevanceFeedback[]> {
  const db = getDb();
  const result = await db.query<Record<string, unknown>>(
    'SELECT * FROM relevance_feedback WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?',
    [agentId, limit],
  );
  return result.rows.map(parseFeedback);
}

// ---------------------------------------------------------------------------
// Weight Evolution Engine
// ---------------------------------------------------------------------------

/**
 * Compute weight updates based on accumulated feedback.
 * Returns the updates without applying them (useful for manual mode preview).
 */
export function computeWeightUpdates(
  currentWeights: Record<string, number>,
  tagFeedback: Record<string, Array<{ rating: string }>>,
): WeightUpdate[] {
  const updates: WeightUpdate[] = [];

  for (const [tag, entries] of Object.entries(tagFeedback)) {
    if (entries.length < MIN_FEEDBACK_PER_TAG) continue;

    // Compute average signal
    let totalSignal = 0;
    for (const entry of entries) {
      totalSignal += RATING_SIGNALS[entry.rating] ?? 0;
    }
    const avgSignal = totalSignal / entries.length;
    const adjustment = LEARNING_RATE * avgSignal;

    const current = currentWeights[tag] ?? 0.5;
    const newWeight = clamp(current + adjustment, WEIGHT_MIN, WEIGHT_MAX);

    if (Math.abs(adjustment) > 1e-9) {
      updates.push({
        tag,
        current_weight: current,
        adjustment: Math.round(adjustment * 10000) / 10000,
        new_weight: Math.round(newWeight * 10000) / 10000,
        feedback_count: entries.length,
        signal: Math.round(avgSignal * 10000) / 10000,
      });
    }
  }

  return updates;
}

/**
 * Compute and apply weight updates for an agent.
 */
export async function computeAndApplyWeightUpdates(
  agentId: string,
): Promise<WeightUpdate[]> {
  const db = getDb();
  const agent = await fetchAgentById(agentId);
  const feedback = await getFeedbackForAgent(agentId, 1000);

  if (feedback.length === 0) return [];

  // Group feedback by decision tags
  const tagFeedback: Record<string, Array<{ rating: string }>> = {};
  for (const fb of feedback) {
    const tags = await fetchDecisionTags(fb.decision_id);
    const rating = (fb as unknown as Record<string, unknown>).rating as string | undefined;
    const effectiveRating = rating ?? (fb.was_useful ? 'useful' : 'irrelevant');

    for (const tag of tags) {
      if (!tagFeedback[tag]) tagFeedback[tag] = [];
      tagFeedback[tag].push({ rating: effectiveRating });
    }
  }

  const updates = computeWeightUpdates(agent.relevance_profile.weights, tagFeedback);

  if (updates.length === 0) return [];

  // Apply updates
  const weightsBefore = { ...agent.relevance_profile.weights };
  const weightsAfter = { ...weightsBefore };
  const adjustments: Record<string, number> = {};

  for (const u of updates) {
    weightsAfter[u.tag] = u.new_weight;
    adjustments[u.tag] = u.adjustment;
  }

  const updatedProfile: RelevanceProfile = {
    ...agent.relevance_profile,
    weights: weightsAfter,
  };

  // Save to agent
  await db.query(
    `UPDATE agents SET relevance_profile = ? WHERE id = ?`,
    [JSON.stringify(updatedProfile), agentId],
  );

  // Record in weight_history
  await db.query(
    `INSERT INTO weight_history (id, agent_id, weights_before, weights_after, adjustments, feedback_count)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      agentId,
      JSON.stringify(weightsBefore),
      JSON.stringify(weightsAfter),
      JSON.stringify(adjustments),
      feedback.length,
    ],
  );

  // Record weight snapshot for time travel
  try {
    await db.query(
      `INSERT INTO weight_snapshots (id, agent_id, weights, snapshot_at)
       VALUES (?, ?, ?, ?)`,
      [randomUUID(), agentId, JSON.stringify(weightsAfter), new Date().toISOString()],
    );
  } catch (err) {
    console.warn('[decigraph:learner] Weight snapshot failed:', (err as Error).message);
  }

  // Log changes
  for (const u of updates) {
    console.warn(
      `[decigraph:learner] Agent "${agentId}" weight updated: ${u.tag}: ${u.current_weight.toFixed(2)} → ${u.new_weight.toFixed(2)} (${u.adjustment > 0 ? '+' : ''}${u.adjustment.toFixed(4)}, ${u.feedback_count} entries)`,
    );
  }

  return updates;
}

/**
 * Get weight suggestions without applying them (manual mode).
 */
export async function getWeightSuggestions(agentId: string): Promise<WeightUpdate[]> {
  const agent = await fetchAgentById(agentId);
  const feedback = await getFeedbackForAgent(agentId, 1000);

  if (feedback.length === 0) return [];

  const tagFeedback: Record<string, Array<{ rating: string }>> = {};
  for (const fb of feedback) {
    const tags = await fetchDecisionTags(fb.decision_id);
    const rating = (fb as unknown as Record<string, unknown>).rating as string | undefined;
    const effectiveRating = rating ?? (fb.was_useful ? 'useful' : 'irrelevant');
    for (const tag of tags) {
      if (!tagFeedback[tag]) tagFeedback[tag] = [];
      tagFeedback[tag].push({ rating: effectiveRating });
    }
  }

  return computeWeightUpdates(agent.relevance_profile.weights, tagFeedback);
}

/**
 * Reset agent weights to role template defaults.
 */
export async function resetWeights(agentId: string): Promise<RelevanceProfile> {
  const db = getDb();
  const agent = await fetchAgentById(agentId);

  // Try to load role template defaults
  let defaultWeights: Record<string, number> = {};
  try {
    const { ROLE_TEMPLATES } = await import('../roles.js');
    const template = ROLE_TEMPLATES[agent.role];
    if (template) {
      defaultWeights = { ...template.profile.weights };
    }
  } catch {
    // roles module not available — use empty defaults
  }

  const updatedProfile: RelevanceProfile = {
    ...agent.relevance_profile,
    weights: defaultWeights,
  };

  await db.query(
    'UPDATE agents SET relevance_profile = ? WHERE id = ?',
    [JSON.stringify(updatedProfile), agentId],
  );

  return updatedProfile;
}

/**
 * Get weight history for an agent.
 */
export async function getWeightHistory(
  agentId: string,
  limit = 20,
): Promise<Array<Record<string, unknown>>> {
  const db = getDb();
  const result = await db.query(
    'SELECT * FROM weight_history WHERE agent_id = ? ORDER BY applied_at DESC LIMIT ?',
    [agentId, limit],
  );
  return result.rows as Array<Record<string, unknown>>;
}

/**
 * Evolve weights — backward-compatible wrapper.
 */
export async function evolveWeights(agentId: string): Promise<RelevanceProfile> {
  const updates = await computeAndApplyWeightUpdates(agentId);
  const agent = await fetchAgentById(agentId);
  return agent.relevance_profile;
}

/**
 * Get evolution statistics — backward-compatible wrapper.
 */
export async function getEvolutionStats(agentId: string): Promise<{
  total_feedback: number;
  useful_rate: number;
  weight_changes: Record<string, { before: number; after: number }>;
}> {
  const feedback = await getFeedbackForAgent(agentId, 1000);
  const suggestions = await getWeightSuggestions(agentId);

  const usefulCount = feedback.filter((fb) => fb.was_useful).length;
  const usefulRate = feedback.length > 0 ? usefulCount / feedback.length : 0;

  const weightChanges: Record<string, { before: number; after: number }> = {};
  for (const u of suggestions) {
    weightChanges[u.tag] = { before: u.current_weight, after: u.new_weight };
  }

  return {
    total_feedback: feedback.length,
    useful_rate: usefulRate,
    weight_changes: weightChanges,
  };
}
