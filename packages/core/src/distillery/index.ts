import type {
  ExtractedDecision,
  Contradiction,
  SessionSummary,
  DistilleryResult,
} from '../types.js';

import { extractDecisions } from './extractor.js';
import { deduplicateDecisions } from './deduplicator.js';
import { detectContradictions } from './contradiction.js';
import { integrateDecisions } from './graph-integrator.js';
import { createSessionSummary } from './summarizer.js';
import { dispatchWebhooks } from '../webhooks/index.js';

// Re-export everything for consumers
export { extractDecisions, scrubSecrets, INJECTION_GUARD, callLLM } from './extractor.js';
export { deduplicateDecisions } from './deduplicator.js';
export { detectContradictions } from './contradiction.js';
export { integrateDecisions } from './graph-integrator.js';
export { createSessionSummary } from './summarizer.js';

/** Run the full 5-stage distillery pipeline on a raw conversation transcript. */
export async function distill(
  projectId: string,
  conversationText: string,
  agentName: string = 'unknown',
  sessionId?: string,
): Promise<DistilleryResult> {
  if (!conversationText.trim()) {
    console.warn('[decigraph:distillery] Empty conversation text; pipeline skipped.');
    return {
      decisions_extracted: 0,
      contradictions_found: 0,
      decisions: [],
      session_summary: undefined,
    };
  }

  // Stage 1: Extract
  let extracted: ExtractedDecision[];
  try {
    extracted = await extractDecisions(conversationText);
  } catch (err) {
    console.error('[decigraph:distillery] Stage 1 (extraction) failed:', err);
    extracted = [];
  }

  // Stage 2: Deduplicate
  let deduped: ExtractedDecision[];
  try {
    deduped = await deduplicateDecisions(projectId, extracted);
  } catch (err) {
    console.error('[decigraph:distillery] Stage 2 (deduplication) failed:', err);
    deduped = extracted;
  }

  // Stage 4: Graph Integration (before stage 3 — needs IDs)
  let createdDecisions: import('../types.js').Decision[];
  try {
    createdDecisions = await integrateDecisions(projectId, deduped, sessionId);
  } catch (err) {
    console.error('[decigraph:distillery] Stage 4 (graph integration) failed:', err);
    createdDecisions = [];
  }

  // Stage 3: Contradiction Detection
  let contradictions: Contradiction[];
  try {
    contradictions = await detectContradictions(projectId, createdDecisions);
  } catch (err) {
    console.error('[decigraph:distillery] Stage 3 (contradiction detection) failed:', err);
    contradictions = [];
  }

  // Stage 5: Session Summary
  const topic =
    createdDecisions[0]?.tags[0] ?? createdDecisions[0]?.title ?? 'General Development Session';

  let sessionSummary: SessionSummary | undefined;
  try {
    sessionSummary = await createSessionSummary(
      projectId,
      agentName,
      topic,
      conversationText,
      createdDecisions,
    );
  } catch (err) {
    console.error('[decigraph:distillery] Stage 5 (session summary) failed:', err);
    sessionSummary = undefined;
  }

  // Dispatch webhooks if any decisions were extracted
  if (extracted.length > 0) {
    dispatchWebhooks(projectId, 'distillery_completed', {
      decisions_extracted: extracted.length,
      contradictions_found: contradictions.length,
      agent_name: agentName,
    }).catch((err) => console.warn('[decigraph:webhook]', (err as Error).message));
  }

  return {
    decisions_extracted: extracted.length,
    contradictions_found: contradictions.length,
    decisions: createdDecisions,
    session_summary: sessionSummary,
  };
}
