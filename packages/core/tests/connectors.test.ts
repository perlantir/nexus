import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';

vi.mock('node:fs/promises');

import fs from 'node:fs/promises';
import { extractAgentName } from '../src/connectors/openclaw.js';
import { directoryConnector } from '../src/connectors/directory.js';
import { webhookConnector } from '../src/connectors/webhook.js';

const mockFs = vi.mocked(fs);

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// extractAgentName
// ---------------------------------------------------------------------------

describe('extractAgentName', () => {
  it('returns "pm" for a path containing "workspace-pm"', () => {
    const filePath = ['/home', 'user', 'workspace-pm', 'conversations', 'session.md'].join(path.sep);
    expect(extractAgentName(filePath)).toBe('pm');
  });

  it('returns "forge" for a path containing "workspace-forge"', () => {
    const filePath = ['/home', 'user', 'workspace-forge', 'conversations', 'chat.txt'].join(path.sep);
    expect(extractAgentName(filePath)).toBe('forge');
  });

  it('returns the default agent name for a bare "workspace" segment', () => {
    const filePath = ['/home', 'user', 'workspace', 'conversations', 'notes.md'].join(path.sep);
    // No suffix after "workspace" → falls back to env var or 'main'
    delete process.env.NEXUS_OPENCLAW_DEFAULT_AGENT;
    expect(extractAgentName(filePath)).toBe('main');
  });

  it('returns "scout" for a path containing "workspace_scout" (underscore separator)', () => {
    const filePath = ['/projects', 'workspace_scout', 'conversations', 'output.log'].join(path.sep);
    expect(extractAgentName(filePath)).toBe('scout');
  });
});

// ---------------------------------------------------------------------------
// Directory connector
// ---------------------------------------------------------------------------

describe('directoryConnector', () => {
  it('handles a missing directory gracefully (ENOENT)', async () => {
    const enoent = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    mockFs.readdir.mockRejectedValue(enoent);

    // The watch generator silently continues on readdir errors; collect first tick
    const gen = directoryConnector.watch({ path: '/nonexistent/dir', poll_interval_ms: 1 });

    // We cannot simply iterate because the generator loops forever. Instead,
    // confirm that calling next() returns a pending promise that does not throw
    // by racing it against a short timeout.
    const result = await Promise.race([
      gen.next().then(() => 'yielded'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ]);

    // No file was found in the missing directory, so nothing is yielded before timeout
    expect(result).toBe('timeout');
    expect(mockFs.readdir).toHaveBeenCalledWith('/nonexistent/dir', { withFileTypes: true });
  });

  it('matches glob patterns correctly', async () => {
    const makeEntry = (name: string, isFile = true) => ({
      name,
      isFile: () => isFile,
      isDirectory: () => !isFile,
    });

    // Directory contains two .md files and one .log file
    const dirEntries = [makeEntry('decision-log.md'), makeEntry('notes.md'), makeEntry('trace.log')];
    const statResult = { mtime: new Date('2026-03-01'), size: 512 };

    mockFs.readdir.mockResolvedValue(dirEntries as any);
    mockFs.stat.mockResolvedValue(statResult as any);
    mockFs.readFile.mockResolvedValue('# Decision\nUse microservices for scalability.' as any);

    const chunks: string[] = [];
    const gen = directoryConnector.watch({ path: '/data/decisions', pattern: '*.md', poll_interval_ms: 1 });

    // Drain exactly 2 chunks (the two .md files) via .next()
    for (let i = 0; i < 2; i++) {
      const { value } = await gen.next();
      if (value) chunks.push(value.source_id);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks.every((p) => p.endsWith('.md'))).toBe(true);
    // The .log file should not appear in chunks
    expect(chunks.some((p) => p.endsWith('.log'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Webhook connector
// ---------------------------------------------------------------------------

describe('webhookConnector', () => {
  it('validates required fields and returns a chunk for a valid payload', () => {
    const payload = {
      text: 'Decided to use Redis for session storage.',
      source_id: 'webhook-event-001',
      agent_name: 'pm',
      metadata: { origin: 'ci-pipeline' },
    };

    const chunks = webhookConnector.handleWebhook!(payload);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe(payload.text);
    expect(chunks[0]?.source_id).toBe('webhook-event-001');
    expect(chunks[0]?.agent_name).toBe('pm');
    expect(chunks[0]?.metadata?.['connector']).toBe('webhook');
  });

  it('rejects a payload missing the text field (returns empty array)', () => {
    const invalidPayload = {
      source_id: 'webhook-event-002',
      project_id: 'proj-xyz',
      // text is missing
    };

    const chunks = webhookConnector.handleWebhook!(invalidPayload);
    expect(chunks).toHaveLength(0);
  });

  it('validates required fields on array payload — skips invalid items', () => {
    const payloads = [
      { text: 'Valid decision text.', source_id: 'evt-valid' },
      { source_id: 'evt-no-text' }, // missing text
      { text: 'Another valid decision.', source_id: 'evt-valid-2' },
    ];

    const chunks = webhookConnector.handleWebhook!(payloads);
    expect(chunks).toHaveLength(2);
    expect(chunks.map((c) => c.source_id)).toEqual(['evt-valid', 'evt-valid-2']);
  });

  it('rejects a payload missing the source_id field (returns empty array)', () => {
    const invalidPayload = {
      text: 'We decided to use Kafka for event streaming.',
      project_id: 'proj-xyz',
      // source_id is missing
    };

    const chunks = webhookConnector.handleWebhook!(invalidPayload);
    expect(chunks).toHaveLength(0);
  });
});
