/**
 * Decision Validation Endpoint Tests
 *
 * Tests POST /validate, POST /invalidate, and POST /validate-bulk
 * using the same mock patterns as app.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp } from '../src/app.js';

// ── DB Mock ───────────────────────────────────────────────────────────────────

const mockQuery = vi.fn();
vi.mock('@decigraph/core/db/index.js', () => ({
  getDb: () => ({
    query: mockQuery,
    transaction: vi.fn().mockImplementation(async (fn: Function) => fn(mockQuery)),
    arrayParam: (v: unknown[]) => JSON.stringify(v),
    healthCheck: vi.fn().mockResolvedValue(true),
    dialect: 'sqlite' as const,
  }),
  initDb: vi.fn().mockResolvedValue({}),
  closeDb: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@decigraph/core/db/pool.js', () => ({
  query: mockQuery,
  getPool: vi.fn(),
  getClient: vi.fn(),
  closePool: vi.fn(),
  healthCheck: vi.fn().mockResolvedValue(true),
  transaction: vi.fn().mockImplementation(async (fn: Function) => fn({ query: mockQuery })),
}));

vi.mock('@decigraph/core/db/parsers.js', () => ({
  parseProject: vi.fn((row: Record<string, unknown>) => row),
  parseAgent: vi.fn((row: Record<string, unknown>) => row),
  parseDecision: vi.fn((row: Record<string, unknown>) => row),
  parseEdge: vi.fn((row: Record<string, unknown>) => row),
  parseArtifact: vi.fn((row: Record<string, unknown>) => row),
  parseSession: vi.fn((row: Record<string, unknown>) => row),
  parseSubscription: vi.fn((row: Record<string, unknown>) => row),
  parseNotification: vi.fn((row: Record<string, unknown>) => row),
  parseContradiction: vi.fn((row: Record<string, unknown>) => row),
  parseFeedback: vi.fn((row: Record<string, unknown>) => row),
  parseAuditEntry: vi.fn((row: Record<string, unknown>) => row),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

async function request(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const url = `http://localhost${path}`;
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  return app.fetch(new Request(url, init));
}

const DECISION_ID = '11111111-1111-1111-1111-111111111111';
const PROJECT_ID = '22222222-2222-2222-2222-222222222222';

function makeDecisionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: DECISION_ID,
    project_id: PROJECT_ID,
    title: 'Use JWT for auth',
    description: 'Token-based auth',
    reasoning: 'Stateless',
    made_by: 'alice',
    source: 'manual',
    confidence: 'high',
    status: 'active',
    supersedes_id: null,
    alternatives_considered: '[]',
    affects: '[]',
    tags: '[]',
    assumptions: '[]',
    open_questions: '[]',
    dependencies: '[]',
    validated_at: null,
    validation_source: null,
    confidence_decay_rate: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    metadata: '{}',
    ...overrides,
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

vi.stubEnv('NODE_ENV', 'development');

let app: ReturnType<typeof createApp>;

beforeEach(() => {
  app = createApp();
  vi.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Validate ──────────────────────────────────────────────────────────────────

describe('POST /api/decisions/:id/validate', () => {
  it('sets validated_at and validation_source', async () => {
    const row = makeDecisionRow();
    // First call: SELECT to check existence
    mockQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 });
    // Second call: UPDATE RETURNING
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...row, validated_at: new Date().toISOString(), validation_source: 'production_verified' }],
      rowCount: 1,
    });
    // Subsequent calls (audit log, etc.)
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const res = await request(app, 'POST', `/api/decisions/${DECISION_ID}/validate`, {
      validation_source: 'production_verified',
      notes: 'Works great',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.validation_source).toBe('production_verified');
  });

  it('rejects missing validation_source', async () => {
    const res = await request(app, 'POST', `/api/decisions/${DECISION_ID}/validate`, {});
    expect(res.status).toBe(400);
  });

  it('rejects invalid validation_source value', async () => {
    const row = makeDecisionRow();
    mockQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 });

    const res = await request(app, 'POST', `/api/decisions/${DECISION_ID}/validate`, {
      validation_source: 'invalid_source',
    });

    expect(res.status).toBe(400);
  });

  it('returns 404 for nonexistent decision', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app, 'POST', `/api/decisions/${DECISION_ID}/validate`, {
      validation_source: 'manual_review',
    });

    expect(res.status).toBe(404);
  });
});

// ── Invalidate ────────────────────────────────────────────────────────────────

describe('POST /api/decisions/:id/invalidate', () => {
  it('clears validated_at and validation_source', async () => {
    const row = makeDecisionRow({
      validated_at: new Date().toISOString(),
      validation_source: 'production_verified',
    });
    // SELECT
    mockQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 });
    // UPDATE RETURNING
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...row, validated_at: null, validation_source: null, confidence: 'medium' }],
      rowCount: 1,
    });
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const res = await request(app, 'POST', `/api/decisions/${DECISION_ID}/invalidate`, {
      reason: 'Failed under load testing',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.validated_at).toBeNull();
    expect(body.validation_source).toBeNull();
  });

  it('stores reason in metadata', async () => {
    const row = makeDecisionRow();
    mockQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 });

    const reason = 'Failed under load testing';
    const updatedMeta = JSON.stringify({ invalidation_reason: reason });
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...row, validated_at: null, validation_source: null, confidence: 'medium', metadata: updatedMeta }],
      rowCount: 1,
    });
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const res = await request(app, 'POST', `/api/decisions/${DECISION_ID}/invalidate`, { reason });

    expect(res.status).toBe(200);
    // Verify the UPDATE query was called with metadata containing the reason
    const updateCall = mockQuery.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('validated_at = NULL'),
    );
    expect(updateCall).toBeDefined();
    const metaParam = updateCall![1][1] as string;
    expect(JSON.parse(metaParam).invalidation_reason).toBe(reason);
  });
});

// ── Bulk Validation ───────────────────────────────────────────────────────────

describe('POST /api/projects/:id/decisions/validate-bulk', () => {
  const ID_A = '33333333-3333-3333-3333-333333333333';
  const ID_B = '44444444-4444-4444-4444-444444444444';

  it('validates multiple decisions', async () => {
    const rowA = makeDecisionRow({ id: ID_A });
    const rowB = makeDecisionRow({ id: ID_B });

    // Transaction calls: SELECT A, SELECT B, UPDATE A, UPDATE B
    mockQuery
      .mockResolvedValueOnce({ rows: [rowA], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [rowB], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // Audit log
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const res = await request(app, 'POST', `/api/projects/${PROJECT_ID}/decisions/validate-bulk`, {
      decision_ids: [ID_A, ID_B],
      validation_source: 'production_verified',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { validated: number; failed: number };
    expect(body.validated).toBe(2);
    expect(body.failed).toBe(0);
  });

  it('rejects if any ID not found', async () => {
    const rowA = makeDecisionRow({ id: ID_A });
    const BAD_ID = '55555555-5555-5555-5555-555555555555';

    mockQuery
      .mockResolvedValueOnce({ rows: [rowA], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // not found

    const res = await request(app, 'POST', `/api/projects/${PROJECT_ID}/decisions/validate-bulk`, {
      decision_ids: [ID_A, BAD_ID],
      validation_source: 'manual_review',
    });

    expect(res.status).toBe(400);
  });

  it('is transactional — rolls back on not-found ID', async () => {
    // If one ID is not found, the transaction should throw and nothing is committed
    const BAD_ID = '66666666-6666-6666-6666-666666666666';
    const rowA = makeDecisionRow({ id: ID_A });

    mockQuery
      .mockResolvedValueOnce({ rows: [rowA], rowCount: 1 })  // SELECT A — found
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });      // SELECT BAD — not found

    const res = await request(app, 'POST', `/api/projects/${PROJECT_ID}/decisions/validate-bulk`, {
      decision_ids: [ID_A, BAD_ID],
      validation_source: 'test_passed',
    });

    // Should reject with 400 — no UPDATE queries should have been issued
    expect(res.status).toBe(400);
    // Verify no UPDATE calls were made (only 2 SELECTs)
    const updateCalls = mockQuery.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('UPDATE'),
    );
    expect(updateCalls.length).toBe(0);
  });
});
