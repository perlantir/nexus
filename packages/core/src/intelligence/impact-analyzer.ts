/**
 * Phase 2 Intelligence: Impact Analyzer
 *
 * Analyzes the potential impact of a proposed decision on existing decisions
 * using vector similarity + LLM analysis (Sonnet).
 */
import { getDb } from '../db/index.js';
import { generateEmbedding } from '../decision-graph/embeddings.js';
import { resolveLLMConfig } from '../config/llm.js';

const SONNET_MODEL = 'claude-sonnet-4-20250514';
const MAX_CHECKS = 15;
const MAX_DESC_LENGTH = 500;

interface ImpactResult {
  affected: boolean;
  impact_level: 'high' | 'medium' | 'low';
  description: string;
}

interface AffectedDecision {
  id: string;
  title: string;
  impact_level: string;
  description: string;
}

export interface ImpactAnalysis {
  affected_decisions: AffectedDecision[];
  summary: string;
  agents_affected: string[];
  decision_count: number;
}

async function callSonnet(systemPrompt: string, userMessage: string): Promise<string> {
  const endpoint = resolveLLMConfig().distillery;
  if (!endpoint) {
    console.warn('[decigraph/impact] No LLM provider configured');
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

      console.log(`[decigraph/impact] LLM call: model=${SONNET_MODEL}`);
      const block = response.content[0];
      return block?.type === 'text' ? block.text : '{}';
    }

    const { callLLM } = await import('../distillery/index.js');
    return await callLLM(systemPrompt, userMessage);
  } catch (err) {
    console.error('[decigraph/impact] LLM call failed:', (err as Error).message);
    throw err;
  }
}

const SYSTEM_PROMPT = `You are an impact analyzer for a decision graph system. Given a proposed new decision and an existing decision, determine if the proposed decision would affect the existing one.

Respond with ONLY valid JSON (no markdown, no backticks):
{"affected": true/false, "impact_level": "high"/"medium"/"low", "description": "Brief description of how it's affected"}

Consider: Would the proposed decision invalidate, modify, depend on, or conflict with the existing decision?`;

export async function analyzeImpact(proposedDecision: string, projectId: string): Promise<ImpactAnalysis> {
  const db = getDb();

  // Generate embedding for proposed text
  let embedding: number[];
  try {
    embedding = await generateEmbedding(proposedDecision);
    if (embedding.every((v) => v === 0)) {
      return { affected_decisions: [], summary: 'Impact analysis unavailable (no embeddings configured)', agents_affected: [], decision_count: 0 };
    }
  } catch {
    return { affected_decisions: [], summary: 'Impact analysis unavailable (embedding generation failed)', agents_affected: [], decision_count: 0 };
  }

  const embeddingStr = `[${embedding.join(',')}]`;

  // Find top similar decisions
  let similarResult;
  try {
    similarResult = await db.query(
      `SELECT id, title, description, affects,
              1 - (embedding <=> ?) as similarity
       FROM decisions
       WHERE project_id = ? AND embedding IS NOT NULL AND status = 'active'
       ORDER BY embedding <=> ?
       LIMIT ?`,
      [embeddingStr, projectId, embeddingStr, MAX_CHECKS],
    );
  } catch {
    return { affected_decisions: [], summary: 'Impact analysis unavailable (vector search not available)', agents_affected: [], decision_count: 0 };
  }

  const candidates = similarResult.rows as Array<Record<string, unknown>>;
  if (candidates.length === 0) {
    return { affected_decisions: [], summary: 'No similar existing decisions found', agents_affected: [], decision_count: 0 };
  }

  const proposedTruncated = proposedDecision.slice(0, MAX_DESC_LENGTH);
  const affectedDecisions: AffectedDecision[] = [];
  const agentsSet = new Set<string>();

  for (const candidate of candidates) {
    const candTitle = String(candidate.title ?? '');
    const candDesc = String(candidate.description ?? '').slice(0, MAX_DESC_LENGTH);
    const affects = candidate.affects as string[] | undefined;

    const userMessage = `Proposed decision: "${proposedTruncated}"\n\nExisting decision: "${candTitle}" — ${candDesc}`;

    try {
      const response = await callSonnet(SYSTEM_PROMPT, userMessage);
      let cleaned = response.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
      }

      const result = JSON.parse(cleaned) as ImpactResult;

      if (result.affected) {
        affectedDecisions.push({
          id: candidate.id as string,
          title: candTitle,
          impact_level: result.impact_level,
          description: result.description,
        });

        if (affects && Array.isArray(affects)) {
          for (const agent of affects) agentsSet.add(agent);
        }
      }
    } catch (err) {
      console.warn(`[decigraph/impact] Check failed for "${candTitle}":`, (err as Error).message);
    }
  }

  const summary = affectedDecisions.length > 0
    ? `${affectedDecisions.length} existing decision(s) would be affected. ${affectedDecisions.filter((d) => d.impact_level === 'high').length} high impact.`
    : 'No significant impact on existing decisions detected.';

  return {
    affected_decisions: affectedDecisions,
    summary,
    agents_affected: Array.from(agentsSet),
    decision_count: affectedDecisions.length,
  };
}
