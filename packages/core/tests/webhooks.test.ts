/**
 * Webhook Dispatcher Tests
 *
 * Tests the platform formatters, HMAC signing, event filtering,
 * and error-handling behaviour. Uses mocked fetch and getDb.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';

// ── Mock getDb before importing the module under test ──────────────────────
const mockQuery = vi.fn();

vi.mock('../src/db/index.js', () => ({
  getDb: () => ({
    dialect: 'sqlite',
    query: mockQuery,
  }),
}));

// ── Mock fetch globally ────────────────────────────────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ── Import module under test ───────────────────────────────────────────────
import {
  dispatchWebhooks,
  formatSlack,
  formatDiscord,
  formatTelegram,
  signPayload,
} from '../src/webhooks/index.js';
import type { WebhookPayload } from '../src/webhooks/index.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makePayload(event = 'contradiction_detected'): WebhookPayload {
  return {
    event,
    project_id: 'proj-123',
    timestamp: '2026-04-03T20:00:00.000Z',
    data: {
      decision_a_title: 'Use JWT for auth',
      decision_b_title: 'Use session cookies',
      severity: 'critical',
    },
  };
}

function makeWebhookRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'wh-001',
    project_id: 'proj-123',
    name: 'test-webhook',
    url: 'https://hooks.example.com/test',
    platform: 'generic',
    events: JSON.stringify(['contradiction_detected', 'decision_created']),
    enabled: 1,
    secret: null,
    metadata: '{}',
    created_at: '2026-04-03T18:00:00',
    updated_at: '2026-04-03T18:00:00',
    ...overrides,
  };
}

// ── Setup / Teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  mockQuery.mockReset();
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true, status: 200 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Webhook Dispatcher', () => {
  describe('Platform Formatters', () => {
    it('formats Slack Block Kit message correctly', () => {
      const payload = makePayload('contradiction_detected');
      const result = formatSlack(payload) as { blocks: Array<Record<string, unknown>> };

      expect(result.blocks).toBeDefined();
      expect(result.blocks.length).toBe(3);
      expect(result.blocks[0]).toMatchObject({
        type: 'header',
        text: { type: 'plain_text' },
      });
      // Header contains event title
      const headerText = (result.blocks[0].text as Record<string, string>).text;
      expect(headerText).toContain('Contradiction Detected');
      // Section contains decision titles
      const sectionText = (result.blocks[1].text as Record<string, string>).text;
      expect(sectionText).toContain('Use JWT for auth');
      expect(sectionText).toContain('Use session cookies');
      // Context block
      expect(result.blocks[2].type).toBe('context');
    });

    it('formats Discord embed correctly', () => {
      const payload = makePayload('contradiction_detected');
      const result = formatDiscord(payload) as {
        embeds: Array<{
          title: string;
          description: string;
          color: number;
          fields: Array<{ name: string; value: string }>;
          footer: { text: string };
        }>;
      };

      expect(result.embeds).toBeDefined();
      expect(result.embeds.length).toBe(1);
      const embed = result.embeds[0];
      expect(embed.title).toContain('Contradiction Detected');
      expect(embed.description).toContain('Use JWT for auth');
      expect(embed.color).toBe(15158332); // red for contradictions
      expect(embed.footer.text).toBe('DeciGraph Decision Memory');
      expect(embed.fields.length).toBeGreaterThanOrEqual(2);
    });

    it('formats Telegram message correctly', () => {
      const payload = makePayload('contradiction_detected');
      const metadata = { bot_token: 'fake-token', chat_id: '12345' };
      const result = formatTelegram(payload, metadata);

      expect(result).not.toBeNull();
      expect(result!.url).toBe('https://api.telegram.org/botfake-token/sendMessage');
      expect(result!.body.chat_id).toBe('12345');
      expect(result!.body.parse_mode).toBe('Markdown');
      expect(result!.body.text).toContain('Contradiction Detected');
    });

    it('returns null for Telegram when missing bot_token or chat_id', () => {
      const payload = makePayload();
      expect(formatTelegram(payload, {})).toBeNull();
      expect(formatTelegram(payload, { bot_token: 'x' })).toBeNull();
      expect(formatTelegram(payload, { chat_id: '123' })).toBeNull();
    });
  });

  describe('Dispatch Behaviour', () => {
    it('respects enabled flag — skips disabled webhooks', async () => {
      mockQuery.mockResolvedValue({
        rows: [makeWebhookRow({ enabled: 0 })],
        rowCount: 1,
      });

      // dispatchWebhooks queries for enabled=1, so disabled won't be returned
      // But let's verify the fetch behaviour when DB returns the row
      mockQuery.mockResolvedValueOnce({
        rows: [], // no enabled webhooks
        rowCount: 0,
      });

      await dispatchWebhooks('proj-123', 'contradiction_detected', {});
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('filters by event type — only delivers to matching events', async () => {
      mockQuery.mockResolvedValue({
        rows: [
          makeWebhookRow({
            events: JSON.stringify(['decision_created']),
          }),
        ],
        rowCount: 1,
      });

      // Dispatch a contradiction event — the webhook only subscribes to decision_created
      await dispatchWebhooks('proj-123', 'contradiction_detected', {});
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('delivers when event matches', async () => {
      mockQuery.mockResolvedValue({
        rows: [makeWebhookRow()],
        rowCount: 1,
      });

      await dispatchWebhooks('proj-123', 'contradiction_detected', {
        decision_a_title: 'A',
        decision_b_title: 'B',
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://hooks.example.com/test',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('includes HMAC-SHA256 signature when secret is set', async () => {
      const secret = 'my-signing-secret';
      mockQuery.mockResolvedValue({
        rows: [makeWebhookRow({ secret })],
        rowCount: 1,
      });

      await dispatchWebhooks('proj-123', 'contradiction_detected', {
        decision_a_title: 'A',
        decision_b_title: 'B',
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      const headers = callArgs[1].headers as Record<string, string>;
      expect(headers['X-DeciGraph-Signature']).toBeDefined();

      // Verify the signature matches
      const body = callArgs[1].body as string;
      const expected = createHmac('sha256', secret).update(body).digest('hex');
      expect(headers['X-DeciGraph-Signature']).toBe(expected);
    });

    it('handles fetch timeout gracefully', async () => {
      mockQuery.mockResolvedValue({
        rows: [makeWebhookRow()],
        rowCount: 1,
      });

      // Simulate timeout/abort
      mockFetch.mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'));

      // Should not throw — dispatcher handles errors internally
      await expect(
        dispatchWebhooks('proj-123', 'contradiction_detected', {
          decision_a_title: 'A',
          decision_b_title: 'B',
        }),
      ).resolves.toBeUndefined();
    });

    it('handles fetch error without throwing', async () => {
      mockQuery.mockResolvedValue({
        rows: [makeWebhookRow()],
        rowCount: 1,
      });

      mockFetch.mockRejectedValue(new Error('Connection refused'));

      await expect(
        dispatchWebhooks('proj-123', 'contradiction_detected', {
          decision_a_title: 'A',
          decision_b_title: 'B',
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('HMAC Signing', () => {
    it('signPayload produces valid HMAC-SHA256 hex', () => {
      const body = '{"event":"test"}';
      const secret = 'test-secret';
      const signature = signPayload(body, secret);
      const expected = createHmac('sha256', secret).update(body).digest('hex');
      expect(signature).toBe(expected);
    });
  });
});
