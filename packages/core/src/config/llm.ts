import OpenAI from 'openai';

export interface LLMEndpoint {
  url: string;
  key: string;
  model: string;
  provider: string;
}

export interface LLMConfig {
  embeddings: LLMEndpoint | null;
  distillery: LLMEndpoint | null;
}

export function resolveLLMConfig(): LLMConfig {
  return {
    embeddings: resolveEmbeddings(),
    distillery: resolveDistillery(),
  };
}

function resolveEmbeddings(): LLMEndpoint | null {
  if (process.env.DECIGRAPH_EMBEDDINGS_URL && process.env.DECIGRAPH_EMBEDDINGS_KEY) {
    return {
      url: process.env.DECIGRAPH_EMBEDDINGS_URL,
      key: process.env.DECIGRAPH_EMBEDDINGS_KEY,
      model: process.env.DECIGRAPH_EMBEDDINGS_MODEL || 'text-embedding-3-small',
      provider: new URL(process.env.DECIGRAPH_EMBEDDINGS_URL).hostname,
    };
  }

  if (process.env.OPENROUTER_API_KEY) {
    return {
      url: 'https://openrouter.ai/api/v1',
      key: process.env.OPENROUTER_API_KEY,
      model: 'openai/text-embedding-3-small',
      provider: 'openrouter',
    };
  }

  if (process.env.OPENAI_API_KEY) {
    return {
      url: 'https://api.openai.com/v1',
      key: process.env.OPENAI_API_KEY,
      model: process.env.DECIGRAPH_EMBEDDINGS_MODEL || 'text-embedding-3-small',
      provider: 'openai',
    };
  }

  return null;
}

function resolveDistillery(): LLMEndpoint | null {
  if (process.env.DECIGRAPH_LLM_URL && process.env.DECIGRAPH_LLM_KEY) {
    return {
      url: process.env.DECIGRAPH_LLM_URL,
      key: process.env.DECIGRAPH_LLM_KEY,
      model: process.env.DECIGRAPH_LLM_MODEL || 'gpt-4o-mini',
      provider: new URL(process.env.DECIGRAPH_LLM_URL).hostname,
    };
  }

  if (process.env.OPENROUTER_API_KEY) {
    return {
      url: 'https://openrouter.ai/api/v1',
      key: process.env.OPENROUTER_API_KEY,
      model: process.env.DECIGRAPH_LLM_MODEL || 'anthropic/claude-opus-4-6',
      provider: 'openrouter',
    };
  }

  if (process.env.ANTHROPIC_API_KEY) {
    return {
      url: '__anthropic_sdk__',
      key: process.env.ANTHROPIC_API_KEY,
      model: process.env.DECIGRAPH_LLM_MODEL || 'claude-opus-4-6',
      provider: 'anthropic',
    };
  }

  if (process.env.OPENAI_API_KEY) {
    return {
      url: 'https://api.openai.com/v1',
      key: process.env.OPENAI_API_KEY,
      model: process.env.DECIGRAPH_LLM_MODEL || 'gpt-4o-mini',
      provider: 'openai',
    };
  }

  return null;
}

export function createLLMClient(endpoint: LLMEndpoint): OpenAI {
  const headers: Record<string, string> = {};

  if (endpoint.url.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'https://github.com/perlantir/decigraph';
    headers['X-Title'] = 'DeciGraph';
  }

  return new OpenAI({
    baseURL: endpoint.url,
    apiKey: endpoint.key,
    defaultHeaders: Object.keys(headers).length > 0 ? headers : undefined,
  });
}

export function logLLMConfig(config: LLMConfig): void {
  if (config.embeddings) {
    console.warn(
      `[decigraph] Embeddings: ${config.embeddings.model} via ${config.embeddings.provider}`,
    );
  } else {
    console.warn('[decigraph] Embeddings: disabled (text search fallback)');
  }

  if (config.distillery) {
    console.warn(
      `[decigraph] Distillery: ${config.distillery.model} via ${config.distillery.provider}`,
    );
  } else {
    console.warn('[decigraph] Distillery: disabled (manual recording only)');
  }
}
