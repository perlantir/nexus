/**
 * Slack Webhook Connector for Decision Ingestion.
 *
 * Provides:
 * - POST /api/webhooks/slack/events — Slack Events API endpoint
 * - URL verification challenge response
 * - Slack signing secret verification
 * - Message events + lock reaction capture
 * - Slash commands: /decigraph-decision, /decigraph-ask, /decigraph-status
 * - Idempotency by event_id/message_ts
 */
import type { Hono } from 'hono';
import crypto from 'node:crypto';
import { submitForExtraction } from '../queue/index.js';
import { getDb } from '@decigraph/core/db/index.js';
import { callLLM } from '@decigraph/core/distillery/index.js';

// ── Decision pattern matching ──────────────────────────────────────────────
const DECISION_PATTERNS: RegExp[] = [
  /\bdecision\s*:/i,
  /\bwe decided\b/i,
  /\bgoing with\b/i,
  /\bapproved\s*:/i,
  /\bchose\b.*\bover\b/i,
  /\bwill use\b.*\binstead\b/i,
  /\bfinal call\s*:/i,
  /\bagreed to\b/i,
  /\baction item\s*:/i,
  /\blet'?s go with\b/i,
  /\bconfirmed\s*:/i,
];

function matchesDecisionPattern(text: string): boolean {
  return DECISION_PATTERNS.some((p) => p.test(text));
}

// ── State ──────────────────────────────────────────────────────────────────
let _connected = false;
const _processedEvents = new Set<string>();

// Prune processed events cache every 5 minutes
setInterval(() => {
  if (_processedEvents.size > 10000) _processedEvents.clear();
}, 5 * 60_000).unref();

// ── Public API ─────────────────────────────────────────────────────────────
export function isSlackConnected(): boolean {
  return _connected;
}

export function getSlackStatus(): Record<string, unknown> {
  return {
    connected: _connected,
    events_processed: _processedEvents.size,
  };
}

// ── Signing secret verification ────────────────────────────────────────────
function verifySlackSignature(
  signingSecret: string,
  signature: string | undefined,
  timestamp: string | undefined,
  body: string,
): boolean {
  if (!signature || !timestamp) return false;

  // Check timestamp freshness (5 min window)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 60 * 5) return false;

  const sigBasestring = `v0:${timestamp}:${body}`;
  const mySignature = 'v0=' + crypto.createHmac('sha256', signingSecret).update(sigBasestring).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(mySignature), Buffer.from(signature));
  } catch {
    return false;
  }
}

// ── Slack event types ──────────────────────────────────────────────────────
interface SlackEvent {
  type: string;
  challenge?: string;
  event_id?: string;
  event?: {
    type: string;
    text?: string;
    user?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
    bot_id?: string;
    reaction?: string;
    item?: {
      type: string;
      channel: string;
      ts: string;
    };
  };
}

/**
 * Register Slack webhook routes on the Hono app.
 */
export function registerSlackConnector(app: Hono): void {
  const signingSecret = process.env.DECIGRAPH_SLACK_SIGNING_SECRET ?? '';
  const projectId = process.env.DECIGRAPH_SLACK_PROJECT_ID
    ?? process.env.DECIGRAPH_DEFAULT_PROJECT_ID
    ?? '';
  const allowedChannels = new Set(
    (process.env.DECIGRAPH_SLACK_CHANNEL_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  );

  if (!signingSecret) {
    console.warn('[decigraph/slack] No DECIGRAPH_SLACK_SIGNING_SECRET — Slack disabled');
    return;
  }

  if (!projectId) {
    console.error('[decigraph/slack] DECIGRAPH_SLACK_PROJECT_ID required when Slack is enabled');
    return;
  }

  _connected = true;

  // Events endpoint
  app.post('/api/webhooks/slack/events', async (c) => {
    const rawBody = await c.req.text();
    const slackSignature = c.req.header('X-Slack-Signature') ?? c.req.header('x-slack-signature');
    const slackTimestamp = c.req.header('X-Slack-Request-Timestamp') ?? c.req.header('x-slack-request-timestamp');

    // Verify signature
    if (!verifySlackSignature(signingSecret, slackSignature, slackTimestamp, rawBody)) {
      console.warn('[decigraph/slack] Signature verification failed');
      return c.json({ error: 'Invalid signature' }, 401);
    }

    let payload: SlackEvent;
    try {
      payload = JSON.parse(rawBody) as SlackEvent;
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    // URL verification challenge
    if (payload.type === 'url_verification' && payload.challenge) {
      return c.json({ challenge: payload.challenge });
    }

    // Idempotency check
    if (payload.event_id) {
      if (_processedEvents.has(payload.event_id)) {
        return c.json({ status: 'already_processed' });
      }
      _processedEvents.add(payload.event_id);
    }

    const event = payload.event;
    if (!event) return c.json({ status: 'no_event' });

    // Skip bot messages
    if (event.bot_id) return c.json({ status: 'ignored', reason: 'bot_message' });

    // Channel filter
    const channel = event.channel ?? event.item?.channel ?? '';
    if (allowedChannels.size > 0 && channel && !allowedChannels.has(channel)) {
      return c.json({ status: 'ignored', reason: 'channel_not_allowed' });
    }

    // Handle message events
    if (event.type === 'message' && event.text) {
      const text = event.text;
      const ts = event.ts ?? '';
      const threadTs = event.thread_ts ?? '';

      // Idempotency by message_ts
      const msgKey = `msg:${channel}:${ts}`;
      if (_processedEvents.has(msgKey)) {
        return c.json({ status: 'already_processed' });
      }
      _processedEvents.add(msgKey);

      // Short messages ignored
      if (text.length < 50) {
        return c.json({ status: 'ignored', reason: 'too_short' });
      }

      // Check for decision patterns
      if (!matchesDecisionPattern(text)) {
        return c.json({ status: 'ignored', reason: 'no_decision_pattern' });
      }

      await submitForExtraction({
        raw_text: text,
        source: 'telegram', // Maps to 'auto_distilled' in ingestion worker
        source_session_id: `slack:${channel}:${ts}${threadTs ? ':' + threadTs : ''}`,
        made_by: event.user ?? 'slack-user',
        project_id: projectId,
      });

      console.log(`[decigraph/slack] Decision detected in channel ${channel} — queued for extraction`);
      return c.json({ status: 'processing' });
    }

    // Handle lock reaction (decision capture)
    if (event.type === 'reaction_added' && event.reaction === 'lock') {
      console.log(`[decigraph/slack] Lock reaction in channel ${event.item?.channel} — could fetch message for extraction`);
      return c.json({ status: 'reaction_noted' });
    }

    return c.json({ status: 'ignored', reason: 'unhandled_event_type' });
  });

  // Slash commands endpoint
  app.post('/api/webhooks/slack/commands', async (c) => {
    const rawBody = await c.req.text();
    const slackSignature = c.req.header('X-Slack-Signature') ?? c.req.header('x-slack-signature');
    const slackTimestamp = c.req.header('X-Slack-Request-Timestamp') ?? c.req.header('x-slack-request-timestamp');

    if (!verifySlackSignature(signingSecret, slackSignature, slackTimestamp, rawBody)) {
      return c.json({ error: 'Invalid signature' }, 401);
    }

    // Parse URL-encoded form data
    const params = new URLSearchParams(rawBody);
    const command = params.get('command') ?? '';
    const text = params.get('text') ?? '';
    const userId = params.get('user_id') ?? 'slack-user';

    switch (command) {
      case '/decigraph-decision': {
        if (text.length < 10) {
          return c.json({ response_type: 'ephemeral', text: 'Decision text must be at least 10 characters.' });
        }

        await submitForExtraction({
          raw_text: text,
          source: 'telegram',
          source_session_id: `slack:cmd:${Date.now()}:${userId}`,
          made_by: userId,
          project_id: projectId,
        });

        return c.json({ response_type: 'in_channel', text: 'Processing decision...' });
      }

      case '/decigraph-ask': {
        if (!text) {
          return c.json({ response_type: 'ephemeral', text: 'Please provide a question.' });
        }

        try {
          const db = getDb();
          const result = await db.query(
            "SELECT title, description, made_by FROM decisions WHERE project_id = ? AND status != 'superseded' ORDER BY created_at DESC LIMIT 20",
            [projectId],
          );
          const decisions = result.rows as Array<Record<string, unknown>>;
          const decisionContext = decisions.map((d, i) =>
            `${i + 1}. "${d.title}" - ${d.description ?? ''} (by ${d.made_by ?? 'unknown'})`,
          ).join('\n');

          const answer = await callLLM(
            'You are a decision memory assistant. Answer the question using only the provided decisions. Be concise (2-4 sentences). No markdown.',
            `Question: ${text}\n\nDecisions:\n${decisionContext}`,
          );

          return c.json({ response_type: 'in_channel', text: answer || 'No relevant decisions found.' });
        } catch (err) {
          console.error('[decigraph/slack] /decigraph-ask error:', (err as Error).message);
          return c.json({ response_type: 'ephemeral', text: 'Failed to process question.' });
        }
      }

      case '/decigraph-status': {
        try {
          const db = getDb();
          const [decResult, agentResult] = await Promise.all([
            db.query('SELECT count(*) as c FROM decisions WHERE project_id = ?', [projectId]),
            db.query('SELECT count(*) as c FROM agents WHERE project_id = ?', [projectId]),
          ]);
          const decCount = parseInt((decResult.rows[0] as Record<string, unknown>)?.c as string ?? '0', 10);
          const agentCount = parseInt((agentResult.rows[0] as Record<string, unknown>)?.c as string ?? '0', 10);

          return c.json({ response_type: 'in_channel', text: `DeciGraph: ${decCount} decisions, ${agentCount} agents` });
        } catch (err) {
          console.error('[decigraph/slack] /decigraph-status error:', (err as Error).message);
          return c.json({ response_type: 'ephemeral', text: 'Failed to get status.' });
        }
      }

      default:
        return c.json({ response_type: 'ephemeral', text: 'Unknown command.' });
    }
  });

  console.warn('[decigraph/slack] Webhook connector registered');
}
