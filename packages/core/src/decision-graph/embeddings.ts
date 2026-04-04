import { resolveLLMConfig, createLLMClient } from '../config/llm.js';
import type { LLMEndpoint } from '../config/llm.js';
import type OpenAI from 'openai';

const EMBEDDING_DIM = 1536;

let _client: OpenAI | null = null;
let _endpoint: LLMEndpoint | null | undefined;

function getEmbeddingClient(): { client: OpenAI; model: string } | null {
  if (_endpoint === undefined) {
    _endpoint = resolveLLMConfig().embeddings;
  }
  if (!_endpoint) return null;
  if (!_client) {
    _client = createLLMClient(_endpoint);
  }
  return { client: _client, model: _endpoint.model };
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const ctx = getEmbeddingClient();

  if (!ctx) {
    console.warn('\n⚠️  [decigraph:embeddings] No embedding provider configured — returning zero-vector!');
    console.warn('    Set OPENAI_API_KEY or DECIGRAPH_EMBEDDINGS_URL in .env to enable semantic search.');
    console.warn('    Without embeddings, context compilation cannot differentiate by semantic similarity.\n');
    return new Array(EMBEDDING_DIM).fill(0) as number[];
  }

  try {
    const response = await ctx.client.embeddings.create({
      model: ctx.model,
      input: text.slice(0, 8191),
    });
    return response.data[0]?.embedding ?? (new Array(EMBEDDING_DIM).fill(0) as number[]);
  } catch (err) {
    console.error('[decigraph:embeddings] Failed to generate embedding:', err);
    throw err;
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    normA += (a[i] ?? 0) ** 2;
    normB += (b[i] ?? 0) ** 2;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
