/**
 * Extraction Worker — processes raw text through Distillery to produce
 * structured decision JSON, then forwards to the ingestion queue.
 *
 * Uses Sonnet (not Opus) for extraction — structured JSON output at 1/10th
 * the cost. Opus is reserved for Ask Anything (synthesis needs reasoning).
 */
import { scrubSecrets, INJECTION_GUARD } from '@decigraph/core/distillery/index.js';
import { resolveLLMConfig } from '@decigraph/core/config/llm.js';
import type { ExtractionJobData, IngestionJobData } from './index.js';
import { addIngestionJob } from './index.js';

// Sonnet model for extraction — much cheaper than Opus for structured output
const EXTRACTION_MODEL = 'claude-sonnet-4-20250514';

const EXTRACTION_SYSTEM_PROMPT = `You are a decision extractor. Given a raw message from a team conversation, determine if it contains an actual decision.

If the message contains a decision, return ONLY valid JSON (no markdown, no backticks):
{
  "title": "Short imperative title, max 80 chars (e.g., 'Use Supabase Auth for user login')",
  "description": "2-3 sentence description of what was decided and why",
  "tags": ["relevant", "topic", "tags"],
  "affects": ["agent1", "agent2"],
  "confidence": "high",
  "reasoning": "Why this decision was made, based on the conversation context",
  "alternatives_considered": [{"option": "Alternative X", "rejected_reason": "Why it was rejected"}]
}

If the message does NOT contain a decision, return ONLY: null

Rules:
- Not every message is a decision. Be selective.
- A decision requires a clear commitment or choice, not just a preference or idea.
- Title should be imperative ("Use X for Y", "Implement Z", "Delay W until...")
- Tags should be lowercase, 1-3 words each, relevant to the topic
- affects should list agent names who need to know about this decision
- Known agents: maks, makspm, scout, clawexpert, launch, forge, pixel, chain, counsel, gauntlet
- confidence: "high" for explicit decisions, "medium" for implied decisions, "low" for uncertain ones`;

interface ExtractedResult {
  title: string;
  description: string;
  tags: string[];
  affects: string[];
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  alternatives_considered: Array<{ option: string; rejected_reason: string }>;
}

/**
 * Call LLM using Sonnet for extraction (cheaper than Opus).
 * Falls back to the configured distillery model if Anthropic SDK is unavailable.
 */
async function callExtractionLLM(systemPrompt: string, userMessage: string): Promise<string> {
  const endpoint = resolveLLMConfig().distillery;

  if (!endpoint) {
    console.warn('[decigraph/extraction] No LLM provider configured');
    return '[]';
  }

  try {
    if (endpoint.url === '__anthropic_sdk__') {
      // Use Anthropic SDK directly with Sonnet model
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client = new Anthropic({ apiKey: endpoint.key });

      const response = await client.messages.create({
        model: EXTRACTION_MODEL,
        max_tokens: 2048, // Extraction responses are short JSON
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      });

      const block = response.content[0];
      return block?.type === 'text' ? block.text : '[]';
    }

    // OpenAI-compatible path — use configured model (can't force Sonnet)
    // Import OpenAI dynamically
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({
      baseURL: endpoint.url,
      apiKey: endpoint.key,
    });

    const response = await client.chat.completions.create({
      model: EXTRACTION_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: 2048,
    });

    return response.choices[0]?.message?.content ?? '[]';
  } catch (err) {
    console.error('[decigraph/extraction] LLM call failed:', (err as Error).message);
    throw err;
  }
}

/**
 * Process extraction job: call Distillery (Sonnet), parse result, forward to ingestion.
 */
export async function handleExtractionJob(data: ExtractionJobData): Promise<void> {
  const scrubbed = scrubSecrets(data.raw_text);
  const userMessage = INJECTION_GUARD + scrubbed;

  console.log(`[decigraph/extraction] Processing: source=${data.source} by=${data.made_by} len=${data.raw_text.length} model=${EXTRACTION_MODEL}`);

  const llmResponse = await callExtractionLLM(EXTRACTION_SYSTEM_PROMPT, userMessage);

  // Check if Distillery thinks this is not a decision
  if (!llmResponse || llmResponse.trim() === 'null' || llmResponse.trim() === 'NO_DECISION' || llmResponse.trim() === '[]') {
    console.log(`[decigraph/extraction] No decision found in message from ${data.made_by}`);
    return;
  }

  // Parse the JSON response
  let parsed: ExtractedResult;
  try {
    // Strip markdown code fences if present
    let cleaned = llmResponse.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }
    parsed = JSON.parse(cleaned) as ExtractedResult;
  } catch {
    console.warn(`[decigraph/extraction] Failed to parse LLM response as JSON:`, llmResponse.slice(0, 200));
    return;
  }

  // Validate required fields
  if (!parsed.title || typeof parsed.title !== 'string') {
    console.warn('[decigraph/extraction] Missing or invalid title in extracted decision');
    return;
  }

  // Forward to ingestion queue
  const ingestionData: IngestionJobData = {
    title: parsed.title.slice(0, 80),
    description: parsed.description ?? '',
    tags: Array.isArray(parsed.tags) ? parsed.tags : [],
    affects: Array.isArray(parsed.affects) ? parsed.affects : [],
    confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'medium',
    reasoning: parsed.reasoning ?? '',
    alternatives_considered: Array.isArray(parsed.alternatives_considered) ? parsed.alternatives_considered : [],
    source: data.source,
    source_session_id: data.source_session_id,
    made_by: data.made_by,
    project_id: data.project_id,
  };

  await addIngestionJob(ingestionData);
  console.log(`[decigraph/extraction] Decision extracted: "${ingestionData.title}" → ingestion queue`);
}
