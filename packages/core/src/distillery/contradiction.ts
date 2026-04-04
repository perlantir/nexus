import type { Decision, Contradiction, NotificationType } from '../types.js';
import { getDb } from '../db/index.js';
import { generateEmbedding } from '../decision-graph/embeddings.js';
import { propagateChange } from '../change-propagator/index.js';
import { callLLM, parseJsonSafe } from './extractor.js';

const CONTRADICTION_SIMILARITY_THRESHOLD = 0.8;

const CONTRADICTION_SYSTEM_PROMPT = `You are analysing two architectural decisions to determine if they contradict each other.

Respond with a JSON object exactly like this:
{"contradicts": true, "explanation": "Reason for contradiction"}
or
{"contradicts": false, "explanation": ""}

Only flag real logical contradictions — not merely different concerns or overlapping areas.`;

interface ContradictionCheckResult {
  contradicts: boolean;
  explanation: string;
}

async function checkContradiction(
  decisionA: { title: string; description: string },
  decisionB: { title: string; description: string },
): Promise<ContradictionCheckResult> {
  const userMessage =
    `Decision A: ${decisionA.title}\n${decisionA.description}\n\n` +
    `Decision B: ${decisionB.title}\n${decisionB.description}`;

  let rawResponse: string;
  try {
    rawResponse = await callLLM(CONTRADICTION_SYSTEM_PROMPT, userMessage);
  } catch (err) {
    console.error('[decigraph:distillery] checkContradiction LLM call failed');
    return { contradicts: false, explanation: '' };
  }

  const parsed = parseJsonSafe<ContradictionCheckResult>(rawResponse);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'contradicts' in parsed) {
    return {
      contradicts: Boolean((parsed as ContradictionCheckResult).contradicts),
      explanation: String((parsed as ContradictionCheckResult).explanation ?? ''),
    };
  }

  return { contradicts: false, explanation: '' };
}

interface ExistingDecisionRow {
  id: string;
  title: string;
  description: string;
  similarity: number;
}

/**
 * Stage 3 — Detect contradictions between new decisions and existing ones.
 * Finds existing active decisions within CONTRADICTION_SIMILARITY_THRESHOLD,
 * asks the LLM if the pair truly contradicts, then persists the result.
 */
export async function detectContradictions(
  projectId: string,
  newDecisions: Decision[],
): Promise<Contradiction[]> {
  if (newDecisions.length === 0) return [];

  const detected: Contradiction[] = [];

  for (const newDecision of newDecisions) {
    const textToEmbed = `${newDecision.title}\n${newDecision.description}`;

    let embedding: number[];
    try {
      embedding = await generateEmbedding(textToEmbed);
    } catch (err) {
      console.error(
        `[decigraph:distillery] detectContradictions: embedding failed for "${newDecision.title}":`,
        err,
      );
      continue;
    }

    const isZeroVector = embedding.every((v) => v === 0);
    if (isZeroVector) continue;

    const vectorLiteral = `[${embedding.join(',')}]`;

    let similar: ExistingDecisionRow[] = [];
    try {
      const db = getDb();
      const result = await db.query<ExistingDecisionRow>(
        `SELECT id, title, description,
                1 - (embedding <=> ?) AS similarity
         FROM decisions
         WHERE project_id = ?
           AND status = 'active'
           AND id != ?
           AND embedding IS NOT NULL
           AND 1 - (embedding <=> ?) > ?
         ORDER BY similarity DESC
         LIMIT 10`,
        [vectorLiteral, projectId, newDecision.id, vectorLiteral, CONTRADICTION_SIMILARITY_THRESHOLD],
      );
      similar = result.rows;
    } catch (err) {
      console.error(
        `[decigraph:distillery] detectContradictions: similarity query failed for "${newDecision.title}":`,
        err,
      );
      continue;
    }

    for (const existingRow of similar) {
      // Avoid checking the same pair twice within a batch
      const alreadyFound = detected.some(
        (c) =>
          (c.decision_a_id === newDecision.id && c.decision_b_id === existingRow.id) ||
          (c.decision_a_id === existingRow.id && c.decision_b_id === newDecision.id),
      );
      if (alreadyFound) continue;

      const { contradicts, explanation } = await checkContradiction(
        { title: newDecision.title, description: newDecision.description },
        { title: existingRow.title, description: existingRow.description },
      );

      if (!contradicts) continue;

      try {
        const db = getDb();
        const contradictionResult = await db.query<{ id: string; detected_at: Date }>(
          `INSERT INTO contradictions
             (project_id, decision_a_id, decision_b_id, similarity_score, conflict_description, status)
           VALUES (?, ?, ?, ?, ?, 'unresolved')
           ON CONFLICT (decision_a_id, decision_b_id) DO UPDATE
             SET conflict_description = EXCLUDED.conflict_description,
                 similarity_score = EXCLUDED.similarity_score
           RETURNING id, detected_at`,
          [projectId, newDecision.id, existingRow.id, existingRow.similarity, explanation],
        );

        const contradictionRow = contradictionResult.rows[0];
        if (!contradictionRow) continue;

        await db.query(
          `INSERT INTO decision_edges
             (source_id, target_id, relationship, description, strength)
           VALUES (?, ?, 'contradicts', ?, ?)
           ON CONFLICT (source_id, target_id, relationship) DO NOTHING`,
          [newDecision.id, existingRow.id, explanation, existingRow.similarity],
        ).catch((err: unknown) => {
          console.warn('[decigraph:distillery] Failed to insert contradicts edge:', err);
        });

        await propagateChange(newDecision, 'contradiction_detected' as NotificationType).catch(
          (err: unknown) => {
            console.warn('[decigraph:distillery] propagateChange failed for contradiction:', err);
          },
        );

        const contradiction: Contradiction = {
          id: contradictionRow.id,
          project_id: projectId,
          decision_a_id: newDecision.id,
          decision_b_id: existingRow.id,
          similarity_score: existingRow.similarity,
          conflict_description: explanation,
          status: 'unresolved',
          detected_at: contradictionRow.detected_at.toISOString(),
        };

        detected.push(contradiction);

        console.warn(
          `[decigraph:distillery] Contradiction: "${newDecision.title}" ↔ "${existingRow.title}"`,
        );
      } catch (err) {
        console.error('[decigraph:distillery] Failed to persist contradiction:', err);
      }
    }
  }

  return detected;
}
