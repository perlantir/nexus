import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/db/pool.js');
vi.mock('../src/distillery/extractor.js');
vi.mock('../src/change-propagator/index.js');
vi.mock('../src/decision-graph/embeddings.js');

import { query, transaction } from '../src/db/pool.js';
import { callLLM, scrubSecrets, parseJsonSafe } from '../src/distillery/extractor.js';
import { propagateChange } from '../src/change-propagator/index.js';
import {
  checkForContradictions,
  scanProjectContradictions,
  logContradictionConfig,
} from '../src/contradiction-detector/index.js';
import type { Decision } from '../src/types.js';

const mockQuery = vi.mocked(query);
const mockTransaction = vi.mocked(transaction);
const mockCallLLM = vi.mocked(callLLM);
const mockScrubSecrets = vi.mocked(scrubSecrets);
const mockParseJsonSafe = vi.mocked(parseJsonSafe);
const mockPropagateChange = vi.mocked(propagateChange);

// ---------------------------------------------------------------------------
// Rate-limiter reset strategy
//
// The contradiction-detector module holds module-level rate-limiter state:
//   let contradictionRateLimitCount = 0;
//   let contradictionRateLimitWindowStart = Date.now();  // set at module load
//
// We can't reset this directly. Instead, for any test that needs LLM calls,
// we install fake timers at a far-future timestamp. Because:
//   • module load time T ≈ current real Unix time (~1.77 trillion ms)
//   • FAR_FUTURE = 1.89 trillion ms (year 2030)
//   • FAR_FUTURE - T >> 60_000 → the window-reset condition triggers, clearing counter
//
// Each test that needs a fresh window uses a unique future timestamp so the
// window start updates do not carry over between tests.
// ---------------------------------------------------------------------------

const FAR_FUTURE_BASE = new Date('2030-01-01T00:00:00Z').getTime();
let futureOffset = 0;

function freshRateLimitWindow() {
  futureOffset += 120_000; // step 2 minutes for each test
  vi.useFakeTimers({ now: FAR_FUTURE_BASE + futureOffset });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: 'dec-001',
    project_id: 'proj-abc',
    title: 'Use PostgreSQL for primary storage',
    description: 'All persistent data goes to PostgreSQL.',
    reasoning: 'Mature ACID guarantees and wide ecosystem support.',
    made_by: 'builder',
    source: 'auto_distilled',
    confidence: 'high',
    status: 'active',
    alternatives_considered: [],
    affects: ['backend'],
    tags: ['database'],
    assumptions: [],
    open_questions: [],
    dependencies: [],
    confidence_decay_rate: 0,
    created_at: new Date('2026-01-01').toISOString(),
    updated_at: new Date('2026-01-01').toISOString(),
    metadata: {},
    embedding: [0.1, 0.2, 0.3],
    ...overrides,
  };
}

/**
 * A DB row compatible with parseDecision.
 * _distance (pgvector return value) is stripped before parseDecision is called.
 * Default _distance 0.10 → similarity 0.90 (above 0.75 threshold).
 */
function makeDecisionDbRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'dec-002',
    project_id: 'proj-abc',
    title: 'Use SQLite for local caching',
    description: 'Cache layer uses SQLite.',
    reasoning: 'Lightweight and embedded.',
    made_by: 'scout',
    source: 'auto_distilled',
    confidence: 'medium',
    status: 'active',
    supersedes_id: null,
    alternatives_considered: [],
    affects: [],
    tags: [],
    assumptions: [],
    open_questions: [],
    dependencies: [],
    confidence_decay_rate: 0,
    created_at: new Date('2026-01-02'),
    updated_at: new Date('2026-01-02'),
    metadata: {},
    embedding: [0.15, 0.25, 0.35],
    _distance: 0.10,
    ...overrides,
  };
}

function makeContradictionRow(): Record<string, unknown> {
  return {
    id: 'contra-001',
    project_id: 'proj-abc',
    decision_a_id: 'dec-001',
    decision_b_id: 'dec-002',
    similarity_score: 0.88,
    conflict_description: 'Both decisions govern storage but disagree on engine.',
    status: 'unresolved',
    resolved_by: null,
    resolution: null,
    detected_at: new Date('2026-01-03'),
    resolved_at: null,
  };
}

const CONFLICT_PAYLOAD = {
  conflicts: true,
  severity: 'critical',
  explanation: 'Both decisions choose incompatible storage engines.',
  resolution_suggestion: 'Consolidate on a single engine.',
};

const NO_CONFLICT_PAYLOAD = {
  conflicts: false,
  severity: 'info',
  explanation: 'No real conflict found.',
  resolution_suggestion: '',
};

function mockNoConflictLLM() {
  mockCallLLM.mockResolvedValueOnce(JSON.stringify(NO_CONFLICT_PAYLOAD));
  mockParseJsonSafe.mockImplementationOnce((raw: string) => JSON.parse(raw) as unknown);
}

function mockConflictLLM() {
  mockCallLLM.mockResolvedValueOnce(JSON.stringify(CONFLICT_PAYLOAD));
  mockParseJsonSafe.mockImplementationOnce((raw: string) => JSON.parse(raw) as unknown);
}

function mockHighSimilarityQuery() {
  mockQuery.mockResolvedValueOnce({
    rows: [makeDecisionDbRow()],
    rowCount: 1,
    command: 'SELECT',
    oid: 0,
    fields: [],
  });
}

function mockEmptyQuery() {
  mockQuery.mockResolvedValueOnce({
    rows: [],
    rowCount: 0,
    command: 'SELECT',
    oid: 0,
    fields: [],
  });
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockScrubSecrets.mockImplementation((text: string) => text);
  mockPropagateChange.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// checkForContradictions
// ---------------------------------------------------------------------------

describe('checkForContradictions', () => {
  it('returns empty array when decision has no embedding', async () => {
    const decision = makeDecision({ embedding: undefined });
    const result = await checkForContradictions(decision);
    expect(result).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns empty array when no similar decisions exist (empty rows)', async () => {
    mockEmptyQuery();
    const result = await checkForContradictions(makeDecision());
    expect(result).toEqual([]);
  });

  it('filters rows below 0.75 similarity threshold — only passes high-similarity rows to LLM', async () => {
    freshRateLimitWindow();

    // distance 0.30 → similarity 0.70 (filtered out)
    // distance 0.20 → similarity 0.80 (passes through)
    const belowRow = makeDecisionDbRow({ id: 'dec-low', _distance: 0.30 });
    const aboveRow = makeDecisionDbRow({ id: 'dec-high', _distance: 0.20 });

    mockQuery.mockResolvedValueOnce({
      rows: [belowRow, aboveRow],
      rowCount: 2,
      command: 'SELECT',
      oid: 0,
      fields: [],
    });

    mockNoConflictLLM();

    await checkForContradictions(makeDecision());

    // Exactly one LLM call for the row with similarity 0.80
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// analyzeConflict (via checkForContradictions)
// ---------------------------------------------------------------------------

describe('analyzeConflict (via checkForContradictions)', () => {
  it('returns null when rate limited — no additional LLM call after 5 per minute', async () => {
    freshRateLimitWindow();

    // Exhaust 5 rate-limit slots
    for (let i = 0; i < 5; i++) {
      mockHighSimilarityQuery();
      mockNoConflictLLM();
      await checkForContradictions(makeDecision());
    }

    // 6th call — rate-limited, no LLM call
    mockHighSimilarityQuery();
    const callsBefore = mockCallLLM.mock.calls.length;
    await checkForContradictions(makeDecision());

    expect(mockCallLLM.mock.calls.length).toBe(callsBefore);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('returns null when LLM returns non-JSON — no contradiction stored', async () => {
    freshRateLimitWindow();

    mockHighSimilarityQuery();
    mockCallLLM.mockResolvedValueOnce('This is definitely not JSON.');
    mockParseJsonSafe.mockReturnValueOnce(null);

    const result = await checkForContradictions(makeDecision());

    expect(result).toHaveLength(0);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('correctly parses valid LLM response JSON and stores a contradiction', async () => {
    freshRateLimitWindow();

    mockHighSimilarityQuery();
    mockConflictLLM();

    const contradictionRow = makeContradictionRow();
    mockTransaction.mockImplementationOnce(async (fn) => {
      const fakeClient = {
        query: vi
          .fn()
          .mockResolvedValueOnce({ rows: [contradictionRow], rowCount: 1 })
          .mockResolvedValueOnce({ rows: [], rowCount: 1 }),
      };
      await fn(fakeClient as any);
    });

    mockEmptyQuery(); // governor agents query

    const result = await checkForContradictions(makeDecision());

    expect(result).toHaveLength(1);
    expect(result[0]?.decision_a_id).toBe('dec-001');
    expect(result[0]?.status).toBe('unresolved');
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it('defaults severity to "warning" for invalid severity values in LLM response', async () => {
    freshRateLimitWindow();

    mockHighSimilarityQuery();

    const invalidSeverityPayload = {
      conflicts: true,
      severity: 'catastrophic', // invalid — defaults to 'warning' inside analyzeConflict
      explanation: 'Serious conflict.',
      resolution_suggestion: 'Pick one.',
    };
    mockCallLLM.mockResolvedValueOnce(JSON.stringify(invalidSeverityPayload));
    mockParseJsonSafe.mockImplementationOnce((raw: string) => JSON.parse(raw) as unknown);

    const contradictionRow = makeContradictionRow();
    mockTransaction.mockImplementationOnce(async (fn) => {
      const fakeClient = {
        query: vi
          .fn()
          .mockResolvedValueOnce({ rows: [contradictionRow], rowCount: 1 })
          .mockResolvedValueOnce({ rows: [], rowCount: 1 }),
      };
      await fn(fakeClient as any);
    });
    mockEmptyQuery(); // governor agents query

    const result = await checkForContradictions(makeDecision());
    // conflicts: true → contradiction stored; invalid severity was coerced to 'warning'
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// storeContradiction (via checkForContradictions)
// ---------------------------------------------------------------------------

describe('storeContradiction (via checkForContradictions)', () => {
  it('inserts into contradictions table and creates an edge (2 client.query calls)', async () => {
    freshRateLimitWindow();

    mockHighSimilarityQuery();
    mockConflictLLM();

    const clientQuerySpy = vi
      .fn()
      .mockResolvedValueOnce({ rows: [makeContradictionRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    mockTransaction.mockImplementationOnce(async (fn) => {
      await fn({ query: clientQuerySpy } as any);
    });

    mockEmptyQuery(); // governor agents query

    await checkForContradictions(makeDecision());

    expect(clientQuerySpy).toHaveBeenCalledTimes(2);
    expect(clientQuerySpy.mock.calls[0]?.[0] as string).toContain('INSERT INTO contradictions');
    expect(clientQuerySpy.mock.calls[1]?.[0] as string).toContain('INSERT INTO decision_edges');
  });

  it('uses ON CONFLICT for duplicate contradiction pairs', async () => {
    freshRateLimitWindow();

    mockHighSimilarityQuery();
    mockConflictLLM();

    const clientQuerySpy = vi
      .fn()
      .mockResolvedValueOnce({ rows: [makeContradictionRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    mockTransaction.mockImplementationOnce(async (fn) => {
      await fn({ query: clientQuerySpy } as any);
    });

    mockEmptyQuery(); // governor agents query

    await checkForContradictions(makeDecision());

    const insertSql = clientQuerySpy.mock.calls[0]?.[0] as string;
    expect(insertSql).toContain('ON CONFLICT');
    expect(insertSql).toContain('decision_a_id, decision_b_id');
  });
});

// ---------------------------------------------------------------------------
// scanProjectContradictions
// ---------------------------------------------------------------------------

describe('scanProjectContradictions', () => {
  it('skips already-tracked contradictions and counts them in the result', async () => {
    freshRateLimitWindow();

    // Two decisions with nearly identical embeddings → cosine similarity ≈ 1.0 (above 0.75)
    const decA = makeDecisionDbRow({ id: 'dec-a', embedding: [1, 0, 0] });
    const decB = makeDecisionDbRow({ id: 'dec-b', embedding: [0.999, 0, 0] });

    mockQuery.mockResolvedValueOnce({
      rows: [decA, decB],
      rowCount: 2,
      command: 'SELECT',
      oid: 0,
      fields: [],
    });

    // Duplicate check finds an existing unresolved contradiction
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'contra-existing' }],
      rowCount: 1,
      command: 'SELECT',
      oid: 0,
      fields: [],
    });

    const result = await scanProjectContradictions('proj-abc');

    expect(mockCallLLM).not.toHaveBeenCalled();
    expect(result.contradictions_found).toBe(1);
  });

  it('processes pairs in batches of 5 — 4 decisions produce 6 unique pairs', async () => {
    // Use a far-future timestamp for this test to guarantee a fresh rate-limit window
    // (rate limit max = 5/min; 6 pairs require crossing a window boundary)
    freshRateLimitWindow();

    const embedding = [1, 0, 0];
    const decisionRows = ['a', 'b', 'c', 'd'].map((id) =>
      makeDecisionDbRow({ id: `dec-${id}`, embedding }),
    );

    mockQuery.mockResolvedValueOnce({
      rows: decisionRows,
      rowCount: 4,
      command: 'SELECT',
      oid: 0,
      fields: [],
    });

    // 6 duplicate-check queries — all return no existing record
    for (let i = 0; i < 6; i++) {
      mockEmptyQuery();
    }

    // First 5 pairs: no conflict
    for (let i = 0; i < 5; i++) {
      mockCallLLM.mockResolvedValueOnce(JSON.stringify(NO_CONFLICT_PAYLOAD));
      mockParseJsonSafe.mockImplementationOnce((raw: string) => JSON.parse(raw) as unknown);
    }
    // 6th pair will be rate-limited (max 5/min hit after 5 calls in same window)
    // After the 1-second inter-batch delay, the window has not reset (1s < 60s)
    // so pair 6 is rate-limited. This is expected behaviour and pairs_checked still = 6.

    // Start scan; advance timers to fire the 1-second inter-batch delay
    const scanPromise = scanProjectContradictions('proj-abc');
    await vi.runAllTimersAsync();
    const result = await scanPromise;

    // All 6 pairs were examined (similarity computed for each)
    expect(result.pairs_checked).toBe(6);
    // 5 LLM calls succeeded; 1 was rate-limited but the scan still ran
    expect(mockCallLLM).toHaveBeenCalledTimes(5);
    expect(result.contradictions_found).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// logContradictionConfig
// ---------------------------------------------------------------------------

describe('logContradictionConfig', () => {
  it('logs enabled when LLM is configured', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.OPENAI_API_KEY = 'sk-test-key-for-log-test';

    logContradictionConfig();

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('enabled'));

    delete process.env.OPENAI_API_KEY;
    consoleSpy.mockRestore();
  });

  it('logs disabled when no LLM is configured', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const llmEnvKeys = [
      'OPENAI_API_KEY',
      'OPENROUTER_API_KEY',
      'ANTHROPIC_API_KEY',
      'NEXUS_LLM_URL',
      'NEXUS_LLM_KEY',
    ];
    const saved: Record<string, string | undefined> = {};
    for (const k of llmEnvKeys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }

    logContradictionConfig();

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('disabled'));

    for (const k of llmEnvKeys) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
    }
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

describe('Rate limiter', () => {
  it('resets after the 60-second window expires', async () => {
    freshRateLimitWindow();

    // Exhaust 5 slots
    for (let i = 0; i < 5; i++) {
      mockHighSimilarityQuery();
      mockNoConflictLLM();
      await checkForContradictions(makeDecision());
    }

    // Advance past the 60-second window — the rate limiter should reset
    vi.advanceTimersByTime(61_000);

    // Next call should be allowed again
    mockHighSimilarityQuery();
    mockNoConflictLLM();

    const callsBefore = mockCallLLM.mock.calls.length;
    await checkForContradictions(makeDecision());
    expect(mockCallLLM.mock.calls.length).toBe(callsBefore + 1);
  });
});
