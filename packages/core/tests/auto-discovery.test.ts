import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/db/pool.js');
vi.mock('../src/distillery/index.js');

import { query } from '../src/db/pool.js';
import { distill } from '../src/distillery/index.js';
import {
  isAlreadyProcessed,
  markProcessed,
  processChunk,
} from '../src/auto-discovery/index.js';
import type { ConversationChunk } from '../src/connectors/types.js';

const mockQuery = vi.mocked(query);
const mockDistill = vi.mocked(distill);

// Helpers ---------------------------------------------------------------

function makeChunk(overrides: Partial<ConversationChunk> = {}): ConversationChunk {
  return {
    text: 'Agent decided to use TypeScript strict mode for all new modules.',
    source_id: '/workspace-pm/conversations/session-2026-01-10.md',
    agent_name: 'pm',
    timestamp: new Date('2026-01-10T10:00:00Z'),
    metadata: {
      file_path: '/workspace-pm/conversations/session-2026-01-10.md',
      file_ext: '.md',
      size_bytes: 1024,
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// Tests -----------------------------------------------------------------

describe('isAlreadyProcessed', () => {
  it('returns false for a new source_id (query returns empty rows)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
      command: 'SELECT',
      oid: 0,
      fields: [],
    });

    const result = await isAlreadyProcessed('proj-abc', 'source-new-001');
    expect(result).toBe(false);
  });

  it('returns true for an existing source_id (query returns rows with exists: true)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ exists: true }],
      rowCount: 1,
      command: 'SELECT',
      oid: 0,
      fields: [],
    });

    const result = await isAlreadyProcessed('proj-abc', '/workspace-pm/conversations/session-001.md');
    expect(result).toBe(true);
  });
});

describe('markProcessed', () => {
  it('inserts a new record with the correct parameters', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [],
      rowCount: 1,
      command: 'INSERT',
      oid: 0,
      fields: [],
    });

    await markProcessed('proj-abc', 'source-001', 'openclaw', 3, { agent: 'pm' });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO processed_sources');
    expect(params).toEqual([
      'proj-abc',
      'source-001',
      'openclaw',
      3,
      JSON.stringify({ agent: 'pm' }),
    ]);
  });

  it('uses ON CONFLICT DO UPDATE so re-processing refreshes the row', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [],
      rowCount: 1,
      command: 'INSERT',
      oid: 0,
      fields: [],
    });

    await markProcessed('proj-abc', 'source-001', 'directory', 5, {});

    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ON CONFLICT');
    expect(sql).toContain('DO UPDATE');
    expect(sql).toContain('processed_at');
    expect(sql).toContain('NOW()');
  });
});

describe('processChunk', () => {
  it('skips already-processed sources and returns 0 decisions_extracted', async () => {
    // isAlreadyProcessed → true
    mockQuery.mockResolvedValueOnce({
      rows: [{ exists: true }],
      rowCount: 1,
      command: 'SELECT',
      oid: 0,
      fields: [],
    });

    const result = await processChunk('proj-abc', makeChunk(), 'openclaw');

    expect(result).toEqual({ decisions_extracted: 0 });
    expect(mockDistill).not.toHaveBeenCalled();
  });

  it('calls distill and marks processed on success', async () => {
    // isAlreadyProcessed → false
    mockQuery.mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
      command: 'SELECT',
      oid: 0,
      fields: [],
    });

    mockDistill.mockResolvedValueOnce({
      decisions_extracted: 2,
      contradictions_found: 0,
      decisions: [],
      session_summary: undefined,
    });

    // markProcessed INSERT
    mockQuery.mockResolvedValueOnce({
      rows: [],
      rowCount: 1,
      command: 'INSERT',
      oid: 0,
      fields: [],
    });

    const chunk = makeChunk();
    const result = await processChunk('proj-abc', chunk, 'openclaw');

    expect(result).toEqual({ decisions_extracted: 2 });
    expect(mockDistill).toHaveBeenCalledWith(
      'proj-abc',
      chunk.text,
      'pm',
      chunk.source_id,
    );

    const insertCall = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(insertCall[0]).toContain('INSERT INTO processed_sources');
    expect(insertCall[1][3]).toBe(2); // decisions_extracted
  });

  it('handles distill failure gracefully and marks error in processed_sources', async () => {
    // isAlreadyProcessed → false
    mockQuery.mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
      command: 'SELECT',
      oid: 0,
      fields: [],
    });

    mockDistill.mockRejectedValueOnce(new Error('LLM provider unreachable'));

    // markProcessed INSERT (error case)
    mockQuery.mockResolvedValueOnce({
      rows: [],
      rowCount: 1,
      command: 'INSERT',
      oid: 0,
      fields: [],
    });

    const chunk = makeChunk();
    const result = await processChunk('proj-abc', chunk, 'openclaw');

    // Returns 0 decisions on error
    expect(result).toEqual({ decisions_extracted: 0 });

    // markProcessed was still called with 0 decisions and error metadata
    const insertCall = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(insertCall[0]).toContain('INSERT INTO processed_sources');
    expect(insertCall[1][3]).toBe(0); // decisions_extracted = 0

    const metadata = JSON.parse(insertCall[1][4] as string) as Record<string, unknown>;
    expect(metadata['error']).toBe('LLM provider unreachable');
  });
});
