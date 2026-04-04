import type { ExtractedDecision, Decision, NotificationType } from '../types.js';
import { getDb } from '../db/index.js';
import { parseDecision } from '../db/parsers.js';
import { generateEmbedding } from '../decision-graph/embeddings.js';
import { propagateChange } from '../change-propagator/index.js';

const SUPERSEDE_SIMILARITY_THRESHOLD = 0.92;

interface SupersedeCandidate {
  id: string;
  similarity: number;
}

/**
 * Stage 4 — Persist extracted decisions into the DB and integrate into the graph.
 * Inserts with source='auto_distilled', status='pending'. Auto-creates a
 * 'supersedes' edge when similarity to an existing decision exceeds threshold.
 */
export async function integrateDecisions(
  projectId: string,
  extracted: ExtractedDecision[],
  sessionId?: string,
): Promise<Decision[]> {
  if (extracted.length === 0) return [];

  const created: Decision[] = [];

  for (const ext of extracted) {
    try {
      const embedding = await generateEmbedding(`${ext.title}\n${ext.description}`).catch(
        (err: unknown) => {
          console.warn(
            `[nexus:distillery] integrateDecisions: embedding failed for "${ext.title}":`,
            err,
          );
          return null;
        },
      );

      const vectorLiteral =
        embedding && !embedding.every((v) => v === 0) ? `[${embedding.join(',')}]` : null;

      let supersedes_id: string | undefined;
      if (vectorLiteral) {
        const db = getDb();
        const supersedeResult = await db.query<SupersedeCandidate>(
          `SELECT id,
                  1 - (embedding <=> ?) AS similarity
           FROM decisions
           WHERE project_id = ?
             AND status = 'active'
             AND embedding IS NOT NULL
             AND 1 - (embedding <=> ?) > ?
           ORDER BY similarity DESC
           LIMIT 1`,
          [vectorLiteral, projectId, vectorLiteral, SUPERSEDE_SIMILARITY_THRESHOLD],
        ).catch((err: unknown) => {
          console.warn('[nexus:distillery] Supersede candidate query failed:', err);
          return { rows: [] as SupersedeCandidate[] };
        });

        supersedes_id = supersedeResult.rows[0]?.id;
      }

      const db = getDb();

      // Auto-approve logic: high confidence → active, medium/low → pending review
      const autoApproveThreshold = parseFloat(process.env.NEXUS_AUTO_APPROVE_THRESHOLD ?? '0.85');
      const confidenceScore = ext.confidence === 'high' ? 0.9 : ext.confidence === 'medium' ? 0.6 : 0.3;
      const autoApproved = confidenceScore >= autoApproveThreshold;
      const decisionStatus = autoApproved ? 'active' : 'pending';
      const reviewStatus = autoApproved ? 'approved' : 'pending_review';

      const decision = await db.transaction(async (txQuery) => {
        const insertResult = await txQuery(
          `INSERT INTO decisions
             (project_id, title, description, reasoning, made_by, source,
              source_session_id, confidence, status, supersedes_id,
              alternatives_considered, affects, tags, assumptions,
              open_questions, dependencies, confidence_decay_rate, metadata,
              embedding, review_status)
           VALUES
             (?, ?, ?, ?, ?, 'auto_distilled',
              ?, ?, ?, ?,
              ?, ?, ?, ?,
              ?, ?, 0, '{}',
              ?, ?)
           RETURNING *`,
          [
            projectId,
            ext.title,
            ext.description,
            ext.reasoning,
            'distillery',
            sessionId ?? null,
            ext.confidence,
            decisionStatus,
            supersedes_id ?? null,
            JSON.stringify(ext.alternatives_considered),
            db.arrayParam(ext.affects),
            db.arrayParam(ext.tags),
            JSON.stringify(ext.assumptions),
            JSON.stringify(ext.open_questions),
            JSON.stringify(ext.dependencies),
            vectorLiteral,
            reviewStatus,
          ],
        );

        const row = insertResult.rows[0];
        if (!row) throw new Error('Insert returned no rows');
        const dec = parseDecision(row);

        if (supersedes_id) {
          await txQuery(
            `UPDATE decisions SET status = 'superseded', updated_at = NOW()
             WHERE id = ?`,
            [supersedes_id],
          );

          await txQuery(
            `INSERT INTO decision_edges
               (source_id, target_id, relationship, description, strength)
             VALUES (?, ?, 'supersedes', 'Auto-detected supersession by distillery', 1.0)
             ON CONFLICT (source_id, target_id, relationship) DO NOTHING`,
            [dec.id, supersedes_id],
          );

          console.warn(`[nexus:distillery] "${dec.title}" supersedes decision ${supersedes_id}`);
        }

        return dec;
      });

      created.push(decision);

      // Fire-and-forget; errors caught inside propagateChange
      propagateChange(decision, 'decision_created' as NotificationType).catch((err: unknown) => {
        console.warn(`[nexus:distillery] propagateChange failed for decision ${decision.id}:`, err);
      });
    } catch (err) {
      console.error(`[nexus:distillery] integrateDecisions: failed to insert "${ext.title}":`, err);
    }
  }

  return created;
}
