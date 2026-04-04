import type { SourceConnector, ConversationChunk, PollConfig } from './types.js';

// TODO: Implement LangSmith API integration.
// LangSmith exposes runs via GET /api/v1/runs with filtering by project & start_time.
// Required env vars: LANGSMITH_API_KEY, LANGSMITH_PROJECT (or pass via PollConfig).
// Reference: https://api.smith.langchain.com/redoc

export const langSmithConnector: SourceConnector = {
  name: 'langsmith',
  type: 'api',

  async poll(_config: PollConfig): Promise<ConversationChunk[]> {
    console.warn(
      '[decigraph:langsmith] LangSmith connector is not yet implemented. ' +
        'Returning empty result. Set LANGSMITH_API_KEY and implement poll() to enable.',
    );
    return [];
  },
};
