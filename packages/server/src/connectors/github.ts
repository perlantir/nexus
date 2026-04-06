/**
 * GitHub PR Decision Ingestion Connector.
 *
 * Webhook endpoint: POST /api/webhooks/github
 * Extracts decisions from merged pull request bodies + comments.
 *
 * Flow:
 * 1. GitHub sends pull_request.closed webhook with merged: true
 * 2. Verify webhook signature (HMAC SHA-256)
 * 3. Scan PR body for decision language
 * 4. If matches → Sonnet extraction → embed → insert
 */
import type { Hono } from 'hono';
import crypto from 'node:crypto';
import { submitForExtraction } from '../queue/index.js';

// Decision patterns (same as OpenClaw watcher)
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

const MAX_EXTRACTION_LENGTH = 2000;

/**
 * Verify GitHub webhook HMAC-SHA256 signature.
 */
function verifySignature(payload: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

interface PRPayload {
  action: string;
  pull_request?: {
    merged: boolean;
    body?: string;
    title?: string;
    number?: number;
    html_url?: string;
    user?: { login?: string };
    labels?: Array<{ name: string }>;
    requested_reviewers?: Array<{ login?: string }>;
  };
}

/**
 * Register GitHub webhook route.
 */
export function registerGitHubWebhook(app: Hono): void {
  const webhookSecret = process.env.DECIGRAPH_GITHUB_WEBHOOK_SECRET ?? '';
  const projectId = process.env.DECIGRAPH_GITHUB_PROJECT_ID
    ?? process.env.DECIGRAPH_DEFAULT_PROJECT_ID
    ?? '';

  app.post('/api/webhooks/github', async (c) => {
    // Get raw body for signature verification
    const rawBody = await c.req.text();
    const signature = c.req.header('X-Hub-Signature-256') ?? c.req.header('x-hub-signature-256');

    // Verify signature if secret is configured
    if (webhookSecret) {
      if (!verifySignature(rawBody, signature, webhookSecret)) {
        console.warn('[decigraph/github] Webhook signature verification failed');
        return c.json({ error: 'Invalid signature' }, 401);
      }
    }

    let payload: PRPayload;
    try {
      payload = JSON.parse(rawBody) as PRPayload;
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    // Only process pull_request.closed with merged: true
    if (payload.action !== 'closed' || !payload.pull_request?.merged) {
      return c.json({ status: 'ignored', reason: 'Not a merged PR' });
    }

    const pr = payload.pull_request;
    const body = pr.body ?? '';

    // Skip PRs with no body text
    if (body.length < 20) {
      return c.json({ status: 'ignored', reason: 'PR body too short' });
    }

    // Pre-filter by decision patterns
    if (!matchesDecisionPattern(body)) {
      return c.json({ status: 'ignored', reason: 'No decision language found' });
    }

    if (!projectId) {
      console.error('[decigraph/github] No project ID configured');
      return c.json({ error: 'No project ID configured' }, 500);
    }

    // Extract metadata
    const madeBy = pr.user?.login ?? 'github';
    const tags = (pr.labels ?? []).map((l) => l.name.toLowerCase());
    const affects = (pr.requested_reviewers ?? [])
      .map((r) => r.login)
      .filter(Boolean) as string[];

    // Truncate body for token efficiency
    const truncatedBody = body.slice(0, MAX_EXTRACTION_LENGTH);

    // Build context: PR title + body
    const rawText = `PR #${pr.number}: ${pr.title ?? ''}\n\n${truncatedBody}`;

    await submitForExtraction({
      raw_text: rawText,
      source: 'telegram', // Maps to 'auto_distilled' in ingestion worker
      source_session_id: `github:pr:${pr.number}`,
      made_by: madeBy,
      project_id: projectId,
    });

    console.log(`[decigraph/github] PR #${pr.number} merged — decision extraction queued (by ${madeBy})`);

    return c.json({
      status: 'processing',
      pr_number: pr.number,
      made_by: madeBy,
      tags,
      affects,
    });
  });
}
