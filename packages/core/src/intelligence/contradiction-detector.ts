/**
 * Phase 2 Intelligence: Contradiction Detector
 *
 * Detects contradictions between a new decision and existing decisions
 * using vector similarity + LLM analysis (Sonnet).
 */
import { getDb } from '../db/index.js';
import { resolveLLMConfig } from '../config/llm.js';

const SONNET_MODEL = 'claude-sonnet-4-20250514';
const SIMILARITY_THRESHOLD = 0.40;
const MAX_CHECKS = 5;
const MAX_DESC_LENGTH = 500;

interface ContradictionResult {
  contradicts: boolean;
  confidence: 'high' | 'medium' | 'low';
  explanation: string;
}

async function callSonnet(systemPrompt: string, userMessage: string): Promise<string> {
  const endpoint = resolveLLMConfig().distillery;
  if (!endpoint) {
    console.warn('[decigraph/contradictions] No LLM provider configured');
    return '{}';
  }

  try {
    if (endpoint.url === '__anthropic_sdk__') {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client = new Anthropic({ apiKey: endpoint.key });

      const response = await client.messages.create({
        model: SONNET_MODEL,
        max_tokens: 512,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      });

      console.log(`[decigraph/contradictions] LLM call: model=${SONNET_MODEL}`);
      const block = response.content[0];
      return block?.type === 'text' ? block.text : '{}';
    }

    const { callLLM } = await import('../distillery/index.js');
    return await callLLM(systemPrompt, userMessage);
  } catch (err) {
    console.error('[decigraph/contradictions] LLM call failed:', (err as Error).message);
    throw err;
  }
}

const SYSTEM_PROMPT = `You are a contradiction detector. Given two team decisions, determine if they contradict each other.

Two decisions contradict if:
- They recommend opposite approaches to the same problem
- Following both simultaneously would be impossible or create conflicts
- One explicitly rejects what the other recommends

They do NOT contradict if:
- They address different scopes (e.g., different products, different environments)
- They are complementary or additive
- One is a refinement of the other

Respond with ONLY valid JSON (no markdown, no backticks):
{"contradicts": true/false, "confidence": "high"/"medium"/"low", "explanation": "brief explanation"}`;

export async function detectContradictions(newDecisionId: string, projectId: string): Promise<void> {
  const db = getDb();

  // Fetch the new decision
  const newResult = await db.query(
    'SELECT id, title, description, confidence, embedding FROM decisions WHERE id = ? AND project_id = ?',
    [newDecisionId, projectId],
  );
  if (newResult.rows.length === 0) return;

  const newDec = newResult.rows[0] as Record<string, unknown>;

  // Skip low confidence decisions
  if (newDec.confidence === 'low') {
    console.log(`[decigraph/contradictions] Skipping low-confidence decision: "${newDec.title}"`);
    return;
  }

  // Skip if no embedding
  if (!newDec.embedding) {
    console.log(`[decigraph/contradictions] No embedding for decision "${newDec.title}" — skipping`);
    return;
  }

  // Find top similar decisions via vector search
  const embeddingStr = typeof newDec.embedding === 'string'
    ? newDec.embedding
    : `[${(newDec.embedding as number[]).join(',')}]`;

  let similarResult;
  try {
    similarResult = await db.query(
      `SELECT id, title, description, confidence,
              1 - (embedding <=> ?) as similarity
       FROM decisions
       WHERE project_id = ? AND id != ? AND embedding IS NOT NULL AND status = 'active'
       ORDER BY embedding <=> ?
       LIMIT ?`,
      [embeddingStr, projectId, newDecisionId, embeddingStr, MAX_CHECKS],
    );
  } catch {
    console.warn('[decigraph/contradictions] Vector search not available — skipping');
    return;
  }

  const candidates = (similarResult.rows as Array<Record<string, unknown>>)
    .filter((r) => (r.similarity as number) >= SIMILARITY_THRESHOLD);

  const newTitle = String(newDec.title ?? '');
  const newDesc = String(newDec.description ?? '').slice(0, MAX_DESC_LENGTH);

  if (candidates.length === 0) {
    console.log(`[decigraph/contradictions] Scanning decision "${newTitle}" — 0 candidates above threshold (${SIMILARITY_THRESHOLD})`);
    return;
  }

  console.log(`[decigraph/contradictions] Scanning decision "${newTitle}" against ${candidates.length} candidates (threshold: ${SIMILARITY_THRESHOLD})`);

  let sonnetCalls = 0;
  for (const candidate of candidates) {
    if (sonnetCalls >= MAX_CHECKS) break;

    const candTitle = String(candidate.title ?? '');
    const candDesc = String(candidate.description ?? '').slice(0, MAX_DESC_LENGTH);
    const similarity = (candidate.similarity as number).toFixed(2);

    console.log(`[decigraph/contradictions] Candidate: "${candTitle}" (similarity: ${similarity}) → sending to Sonnet`);

    const userMessage = `Decision A: "${newTitle}" — ${newDesc}\n\nDecision B: "${candTitle}" — ${candDesc}`;

    try {
      sonnetCalls++;
      const response = await callSonnet(SYSTEM_PROMPT, userMessage);
      let cleaned = response.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
      }

      const result = JSON.parse(cleaned) as ContradictionResult;

      console.log(`[decigraph/contradictions] Sonnet verdict: contradicts=${result.contradicts}, confidence=${result.confidence}`);

      if (result.contradicts && (result.confidence === 'high' || result.confidence === 'medium')) {
        // Insert into phase2_contradictions
        await db.query(
          `INSERT INTO phase2_contradictions (decision_a_id, decision_b_id, confidence, explanation)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (decision_a_id, decision_b_id) DO NOTHING`,
          [newDecisionId, candidate.id, result.confidence, result.explanation ?? ''],
        );

        console.log(`[decigraph/contradictions] Contradiction created: "${newTitle}" ↔ "${candTitle}"`);
      }
    } catch (err) {
      console.warn(`[decigraph/contradictions] Check failed for "${candTitle}":`, (err as Error).message);
    }
  }
}
