/**
 * Contradiction Detection Engine
 *
 * Proactively scans for semantic conflicts between decisions in a project.
 * Runs in 3 stages:
 *   1. Semantic similarity scan (pgvector cosine distance)
 *   2. LLM conflict analysis for high-similarity pairs
 *   3. Store contradiction record, create edge, propagate change, notify governors
 *
 * Never throws — all errors are caught and logged gracefully so contradiction
 * detection cannot crash the server.
 */

import { getDb } from '../db/index.js';
import { parseDecision, parseContradiction } from '../db/parsers.js';
import { callLLM, scrubSecrets, INJECTION_GUARD, parseJsonSafe } from '../distillery/extractor.js';
import { propagateChange } from '../change-propagator/index.js';
import { dispatchWebhooks } from '../webhooks/index.js';
import { resolveLLMConfig } from '../config/llm.js';
import type { Decision, Contradiction } from '../types.js';
import type { ContradictionAnalysis } from './types.js';

export type { ContradictionAnalysis } from './types.js';

// ---------------------------------------------------------------------------
// Rate limiter — separate from distillery, max 5 contradiction checks per min
// ---------------------------------------------------------------------------

const CONTRADICTION_RATE_LIMIT_MAX = 5;
const CONTRADICTION_RATE_LIMIT_WINDOW_MS = 60_000;
let contradictionRateLimitCount = 0;
let contradictionRateLimitWindowStart = Date.now();

function checkContradictionRateLimit(): boolean {
  const now = Date.now();
  if (now - contradictionRateLimitWindowStart >= CONTRADICTION_RATE_LIMIT_WINDOW_MS) {
    contradictionRateLimitCount = 0;
    contradictionRateLimitWindowStart = now;
  }
  if (contradictionRateLimitCount >= CONTRADICTION_RATE_LIMIT_MAX) return false;
  contradictionRateLimitCount++;
  return true;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SIMILARITY_THRESHOLD = 0.75;
const VECTOR_SCAN_LIMIT = 20;

// ---------------------------------------------------------------------------
// Stage 1: Semantic Similarity Scan
// ---------------------------------------------------------------------------

interface SimilarDecision {
  decision: Decision;
  similarity: number;
}

async function findSimilarDecisions(newDecision: Decision): Promise<SimilarDecision[]> {
  if (!newDecision.embedding || newDecision.embedding.length === 0) {
    console.warn(
      `[decigraph:contradiction] Decision "${newDecision.id}" has no embedding — skipping similarity scan.`,
    );
    return [];
  }

  // Format embedding as a pgvector literal string
  const embeddingLiteral = `[${newDecision.embedding.join(',')}]`;

  let rows: Record<string, unknown>[];
  try {
    const db = getDb();
    const result = await db.query<Record<string, unknown>>(
      `SELECT *, (embedding <=> ?) AS _distance
         FROM decisions
        WHERE project_id = ?
          AND status = 'active'
          AND id != ?
          AND embedding IS NOT NULL
        ORDER BY embedding <=> ?
        LIMIT ${VECTOR_SCAN_LIMIT}`,
      [embeddingLiteral, newDecision.project_id, newDecision.id, embeddingLiteral],
    );
    rows = result.rows;
  } catch (err) {
    console.error(
      '[decigraph:contradiction] Stage 1 pgvector query failed:',
      (err as Error).message,
    );
    return [];
  }

  const similar: SimilarDecision[] = [];
  for (const row of rows) {
    const distance = Number((row as Record<string, unknown>)['_distance'] ?? 2);
    const similarity = 1 - distance;

    if (similarity > SIMILARITY_THRESHOLD) {
      try {
        // Build a clean row without the synthetic _distance column
        const cleanRow: Record<string, unknown> = { ...row };
        delete cleanRow['_distance'];
        similar.push({ decision: parseDecision(cleanRow), similarity });
      } catch (err) {
        console.warn('[decigraph:contradiction] Failed to parse similar decision row:', err);
      }
    }
  }

  return similar;
}

// ---------------------------------------------------------------------------
// Stage 2: LLM Conflict Analysis
// ---------------------------------------------------------------------------

const CONTRADICTION_SYSTEM_PROMPT =
  `You are an expert at detecting contradictions between decisions in multi-agent AI systems.

Given two decisions from the same project, determine if they GENUINELY conflict.

RULES:
- Direct opposites or mutually exclusive choices = CONFLICT
- Same concern, different layers (frontend vs backend) = usually NOT a conflict
- Complementary approaches in different contexts = NOT a conflict
- Different opinions on the same specific choice = CONFLICT

Return only JSON:
{
  "conflicts": true | false,
  "severity": "critical" | "warning" | "info",
  "explanation": "Clear 1-2 sentence explanation",
  "resolution_suggestion": "How to resolve if they conflict"
}

EXAMPLES OF SUBTLE CASES:

Decision A: "Use JWT for API authentication with short-lived tokens"
Decision B: "Implement session-based auth with server-side storage"
\u2192 {"conflicts": true, "severity": "critical", "explanation": "Mutually exclusive auth approaches."}

Decision A: "Use PostgreSQL with pgvector for embeddings"
Decision B: "Store embeddings in a dedicated Pinecone instance"
\u2192 {"conflicts": true, "severity": "warning", "explanation": "Two different storage solutions for the same data."}

Decision A: "REST APIs for all backend services"
Decision B: "Use GraphQL for the marketing dashboard"
\u2192 {"conflicts": false, "severity": "info", "explanation": "Hybrid API approach \u2014 different tools for different interfaces."}

Decision A: "Deploy everything via Docker Compose on single server"
Decision B: "Use Kubernetes for production orchestration"
\u2192 {"conflicts": true, "severity": "critical", "explanation": "Mutually exclusive deployment strategies."}

Decision A: "Use Tailwind CSS for styling"
Decision B: "All components must use CSS modules"
\u2192 {"conflicts": true, "severity": "warning", "explanation": "Two different CSS methodologies for the same components."}

Decision A: "API rate limiting at 100 req/min per user"
Decision B: "Auth endpoints limited to 10 req/min per IP"
\u2192 {"conflicts": false, "severity": "info", "explanation": "Different rate limits for different endpoint types. Complementary."}

Only return conflicts: true if the decisions genuinely cannot coexist in the same project.

Now analyze these two decisions:`;

function buildDecisionText(label: 'Decision A' | 'Decision B', d: Decision): string {
  return `${label}:\nTitle: ${d.title}\nDescription: ${d.description}\nReasoning: ${d.reasoning}`;
}

async function analyzeConflict(
  decisionA: Decision,
  decisionB: Decision,
): Promise<ContradictionAnalysis | null> {
  if (!checkContradictionRateLimit()) {
    console.warn(
      '[decigraph:contradiction] Rate limit exceeded (max 5/min); skipping LLM conflict check.',
    );
    return null;
  }

  const rawText =
    buildDecisionText('Decision A', decisionA) +
    '\n\n' +
    buildDecisionText('Decision B', decisionB);

  const safeText = scrubSecrets(rawText);
  const userMessage = INJECTION_GUARD + safeText;

  let rawResponse: string;
  try {
    rawResponse = await callLLM(CONTRADICTION_SYSTEM_PROMPT, userMessage);
  } catch (err) {
    console.error(
      '[decigraph:contradiction] LLM call failed for conflict analysis:',
      (err as Error).message,
    );
    return null;
  }

  const parsed = parseJsonSafe<unknown>(rawResponse);
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  ) {
    console.warn(
      '[decigraph:contradiction] LLM returned unexpected shape; treating as no conflict.',
    );
    return null;
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj['conflicts'] !== 'boolean') {
    console.warn('[decigraph:contradiction] LLM response missing "conflicts" boolean field.');
    return null;
  }

  const validSeverities = ['critical', 'warning', 'info'] as const;
  type ValidSeverity = (typeof validSeverities)[number];

  const rawSeverity = String(obj['severity'] ?? 'warning');
  const severity: ValidSeverity = (validSeverities as readonly string[]).includes(rawSeverity)
    ? (rawSeverity as ValidSeverity)
    : 'warning';

  const analysis: ContradictionAnalysis = {
    conflicts: obj['conflicts'] as boolean,
    severity,
    explanation: String(obj['explanation'] ?? ''),
    resolution_suggestion: String(obj['resolution_suggestion'] ?? ''),
  };

  return analysis;
}

// ---------------------------------------------------------------------------
// Stage 3: Store and Notify
// ---------------------------------------------------------------------------

async function storeContradiction(
  newDecision: Decision,
  existingDecision: Decision,
  analysis: ContradictionAnalysis,
  similarity: number,
): Promise<Contradiction | null> {
  let contradiction: Contradiction | null = null;

  try {
    const db = getDb();
    await db.transaction(async (txQuery) => {
      // 1. Insert into contradictions table
      const contradictionResult = await txQuery(
        `INSERT INTO contradictions
           (project_id, decision_a_id, decision_b_id, similarity_score, conflict_description, status)
         VALUES (?, ?, ?, ?, ?, 'unresolved')
         ON CONFLICT (decision_a_id, decision_b_id) DO UPDATE
           SET conflict_description = EXCLUDED.conflict_description,
               similarity_score     = EXCLUDED.similarity_score
         RETURNING *`,
        [
          newDecision.project_id,
          newDecision.id,
          existingDecision.id,
          similarity,
          analysis.explanation,
        ],
      );

      const contradictionRow = contradictionResult.rows[0];
      if (!contradictionRow) {
        throw new Error('Failed to insert contradiction record — no row returned');
      }
      contradiction = parseContradiction(contradictionRow);

      // 2. Create 'contradicts' edge between the two decisions
      await txQuery(
        `INSERT INTO decision_edges (source_id, target_id, relationship, description, strength)
         VALUES (?, ?, 'contradicts', ?, 1.0)
         ON CONFLICT (source_id, target_id, relationship) DO UPDATE
           SET description = EXCLUDED.description`,
        [newDecision.id, existingDecision.id, analysis.explanation],
      );
    });
  } catch (err) {
    console.error(
      '[decigraph:contradiction] Failed to store contradiction:',
      (err as Error).message,
    );
    return null;
  }

  return contradiction;
}

/**
 * Directly notify all governor agents in the project about a contradiction.
 * This is in addition to the subscription-based propagateChange notification —
 * governors are always notified regardless of subscription.
 */
async function notifyGovernors(
  newDecision: Decision,
  existingDecision: Decision,
  analysis: ContradictionAnalysis,
): Promise<number> {
  let notified = 0;

  try {
    const db = getDb();
    const agentsResult = await db.query<Record<string, unknown>>(
      `SELECT id FROM agents WHERE project_id = ? AND role = 'governor'`,
      [newDecision.project_id],
    );

    if (agentsResult.rows.length === 0) return 0;

    const message =
      `Contradiction detected (${analysis.severity}): ` +
      `"${newDecision.title}" conflicts with "${existingDecision.title}". ` +
      `${analysis.explanation}`;

    const urgency = analysis.severity === 'critical' ? 'critical' : 'high';

    for (const agentRow of agentsResult.rows) {
      const agentId = agentRow['id'] as string;
      try {
        await db.query(
          `INSERT INTO notifications
             (agent_id, decision_id, notification_type, message, role_context, urgency)
           VALUES (?, ?, 'contradiction_detected', ?, ?, ?)`,
          [agentId, newDecision.id, message, 'governor', urgency],
        );
        notified++;
      } catch (err) {
        console.warn(
          `[decigraph:contradiction] Failed to notify governor agent ${agentId}:`,
          (err as Error).message,
        );
      }
    }
  } catch (err) {
    console.warn(
      '[decigraph:contradiction] Failed to query governor agents:',
      (err as Error).message,
    );
  }

  return notified;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Main entry point — runs all 3 stages for a single new decision.
 *
 * Stage 1: Query active decisions with pgvector cosine similarity > 0.75.
 * Stage 2: For each high-similarity pair, call the LLM to confirm conflict.
 * Stage 3: Persist contradiction, create 'contradicts' edge, propagate change,
 *          and notify all governor agents.
 *
 * Never throws — all errors are caught and logged gracefully.
 */
export async function checkForContradictions(decision: Decision): Promise<Contradiction[]> {
  const found: Contradiction[] = [];

  try {
    // Stage 1: Semantic similarity scan
    const similar = await findSimilarDecisions(decision);
    if (similar.length === 0) return found;

    // Stage 2 + 3: Analyze each high-similarity pair
    for (const { decision: existingDecision, similarity } of similar) {
      let analysis: ContradictionAnalysis | null = null;

      try {
        analysis = await analyzeConflict(decision, existingDecision);
      } catch (err) {
        console.error(
          '[decigraph:contradiction] Unexpected error during conflict analysis:',
          (err as Error).message,
        );
        continue;
      }

      if (!analysis || !analysis.conflicts) continue;

      // Stage 3a: Persist contradiction record + edge
      const contradiction = await storeContradiction(
        decision,
        existingDecision,
        analysis,
        similarity,
      );

      if (!contradiction) continue;

      found.push(contradiction);

      // Stage 3b: Propagate change to subscribed agents
      try {
        await propagateChange(decision, 'contradiction_detected');
      } catch (err) {
        console.warn(
          '[decigraph:contradiction] propagateChange failed:',
          (err as Error).message,
        );
      }

      // Stage 3b-ii: Dispatch webhooks (fire-and-forget)
      dispatchWebhooks(decision.project_id, 'contradiction_detected', {
        contradiction_id: contradiction.id,
        decision_a_title: decision.title,
        decision_b_title: existingDecision.title,
        severity: analysis.severity,
      }).catch((err) => console.warn('[decigraph:webhook]', (err as Error).message));

      // Stage 3c: Always notify governor agents regardless of subscriptions
      const governorCount = await notifyGovernors(decision, existingDecision, analysis);

      console.warn(
        `[decigraph:contradiction] ${analysis.severity.toUpperCase()}: ` +
          `"${decision.title}" conflicts with "${existingDecision.title}" ` +
          `— notifying ${governorCount} agents`,
      );
    }
  } catch (err) {
    console.error(
      '[decigraph:contradiction] Unexpected top-level error in checkForContradictions:',
      (err as Error).message,
    );
  }

  return found;
}

/**
 * One-time full scan — checks ALL active decision pairs in a project.
 *
 * Fetches all active decisions with embeddings, generates all unique pairs,
 * and processes them in batches of 5 with 1-second delays between batches.
 *
 * Pairs with cosine similarity <= 0.75 are skipped before the LLM call.
 * Already-tracked contradictions are skipped to avoid duplicate records.
 *
 * Returns a summary of pairs examined and contradictions found.
 */
export async function scanProjectContradictions(
  projectId: string,
): Promise<{ pairs_checked: number; contradictions_found: number }> {
  let pairsChecked = 0;
  let contradictionsFound = 0;

  try {
    // Fetch all active decisions that have embeddings
    const db = getDb();
    const result = await db.query<Record<string, unknown>>(
      `SELECT * FROM decisions
        WHERE project_id = ?
          AND status = 'active'
          AND embedding IS NOT NULL
        ORDER BY created_at ASC`,
      [projectId],
    );

    const decisions: Decision[] = [];
    for (const row of result.rows) {
      try {
        decisions.push(parseDecision(row));
      } catch (err) {
        console.warn('[decigraph:contradiction] Failed to parse decision during scan:', err);
      }
    }

    if (decisions.length < 2) {
      console.warn(
        `[decigraph:contradiction] scanProjectContradictions: fewer than 2 decisions with ` +
          `embeddings in project ${projectId} — nothing to scan.`,
      );
      return { pairs_checked: 0, contradictions_found: 0 };
    }

    // Generate all unique ordered pairs (i < j)
    const pairs: Array<[Decision, Decision]> = [];
    for (let i = 0; i < decisions.length; i++) {
      for (let j = i + 1; j < decisions.length; j++) {
        const dA = decisions[i];
        const dB = decisions[j];
        if (dA !== undefined && dB !== undefined) {
          pairs.push([dA, dB]);
        }
      }
    }

    const BATCH_SIZE = 5;
    const BATCH_DELAY_MS = 1_000;

    for (let batchStart = 0; batchStart < pairs.length; batchStart += BATCH_SIZE) {
      const batch = pairs.slice(batchStart, batchStart + BATCH_SIZE);

      for (const [decisionA, decisionB] of batch) {
        // Fast pre-filter: compute cosine similarity without the LLM
        const embA = decisionA.embedding;
        const embB = decisionB.embedding;

        if (!embA || !embB || embA.length === 0 || embB.length === 0) continue;

        let dot = 0;
        let normA = 0;
        let normB = 0;
        for (let k = 0; k < embA.length; k++) {
          const a = embA[k] ?? 0;
          const b = embB[k] ?? 0;
          dot += a * b;
          normA += a * a;
          normB += b * b;
        }
        const denom = Math.sqrt(normA) * Math.sqrt(normB);
        const similarity = denom === 0 ? 0 : dot / denom;

        pairsChecked++;

        if (similarity <= SIMILARITY_THRESHOLD) continue;

        // Skip pairs already tracked as unresolved contradictions
        try {
          const existing = await db.query<Record<string, unknown>>(
            `SELECT id FROM contradictions
              WHERE project_id = ?
                AND (
                  (decision_a_id = ? AND decision_b_id = ?) OR
                  (decision_a_id = ? AND decision_b_id = ?)
                )
                AND status = 'unresolved'
              LIMIT 1`,
            [projectId, decisionA.id, decisionB.id, decisionB.id, decisionA.id],
          );

          if ((existing.rowCount ?? 0) > 0) {
            contradictionsFound++;
            continue;
          }
        } catch (err) {
          console.warn(
            '[decigraph:contradiction] Duplicate check query failed:',
            (err as Error).message,
          );
        }

        // LLM conflict analysis
        let analysis: ContradictionAnalysis | null = null;
        try {
          analysis = await analyzeConflict(decisionA, decisionB);
        } catch (err) {
          console.error(
            '[decigraph:contradiction] scanProjectContradictions: analysis error:',
            (err as Error).message,
          );
          continue;
        }

        if (!analysis || !analysis.conflicts) continue;

        // Store + notify
        const contradiction = await storeContradiction(
          decisionA,
          decisionB,
          analysis,
          similarity,
        );

        if (!contradiction) continue;

        contradictionsFound++;

        try {
          await propagateChange(decisionA, 'contradiction_detected');
        } catch (err) {
          console.warn(
            '[decigraph:contradiction] propagateChange failed during scan:',
            (err as Error).message,
          );
        }

        const governorCount = await notifyGovernors(decisionA, decisionB, analysis);

        console.warn(
          `[decigraph:contradiction] ${analysis.severity.toUpperCase()}: ` +
            `"${decisionA.title}" conflicts with "${decisionB.title}" ` +
            `— notifying ${governorCount} agents`,
        );
      }

      // Pause between batches (skip delay after the final batch)
      const isLastBatch = batchStart + BATCH_SIZE >= pairs.length;
      if (!isLastBatch) {
        await new Promise<void>((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }
  } catch (err) {
    console.error(
      '[decigraph:contradiction] Unexpected top-level error in scanProjectContradictions:',
      (err as Error).message,
    );
  }

  return { pairs_checked: pairsChecked, contradictions_found: contradictionsFound };
}

/**
 * Logs whether contradiction detection is enabled.
 * Contradiction detection requires an LLM provider configured in the distillery slot.
 */
export function logContradictionConfig(): void {
  const config = resolveLLMConfig();
  if (config.distillery) {
    console.warn(
      `[decigraph:contradiction] Contradiction detection enabled ` +
        `(${config.distillery.model} via ${config.distillery.provider})`,
    );
  } else {
    console.warn(
      '[decigraph:contradiction] Contradiction detection disabled — no LLM provider configured.',
    );
  }
}
