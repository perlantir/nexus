import type { SourceConnector, ConversationChunk } from './types.js';

/** Shape of an inbound webhook payload. */
interface WebhookPayload {
  text: string;
  source_id: string;
  agent_name?: string;
  metadata?: Record<string, unknown>;
}

function isWebhookPayload(value: unknown): value is WebhookPayload {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj['text'] === 'string' && typeof obj['source_id'] === 'string';
}

export const webhookConnector: SourceConnector = {
  name: 'webhook',
  type: 'webhook',

  handleWebhook(payload: unknown): ConversationChunk[] {
    if (Array.isArray(payload)) {
      const chunks: ConversationChunk[] = [];
      for (const item of payload) {
        if (!isWebhookPayload(item)) {
          console.warn('[decigraph:webhook] Skipping invalid payload item:', JSON.stringify(item));
          continue;
        }
        chunks.push(payloadToChunk(item));
      }
      return chunks;
    }

    if (!isWebhookPayload(payload)) {
      console.warn('[decigraph:webhook] Invalid webhook payload received:', JSON.stringify(payload));
      return [];
    }

    return [payloadToChunk(payload)];
  },
};

function payloadToChunk(payload: WebhookPayload): ConversationChunk {
  return {
    text: payload.text,
    source_id: payload.source_id,
    agent_name: payload.agent_name,
    timestamp: new Date(),
    metadata: {
      ...(payload.metadata ?? {}),
      connector: 'webhook',
      received_at: new Date().toISOString(),
    },
  };
}
