/**
 * Decisions CRUD Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp } from '../src/app.js';

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
  query: mockQuery, getPool: vi.fn(), getClient: vi.fn(), closePool: vi.fn(),
  healthCheck: vi.fn().mockResolvedValue(true),
  transaction: vi.fn().mockImplementation(async (fn: Function) => fn({ query: mockQuery })),
}));

vi.mock('@decigraph/core/db/parsers.js', () => ({
  parseProject: vi.fn((r: Record<string, unknown>) => r),
  parseAgent: vi.fn((r: Record<string, unknown>) => r),
  parseDecision: vi.fn((r: Record<string, unknown>) => r),
  parseEdge: vi.fn((r: Record<string, unknown>) => r),
  parseArtifact: vi.fn((r: Record<string, unknown>) => r),
  parseSession: vi.fn((r: Record<string, unknown>) => r),
  parseSubscription: vi.fn((r: Record<string, unknown>) => r),
  parseNotification: vi.fn((r: Record<string, unknown>) => r),
  parseContradiction: vi.fn((r: Record<string, unknown>) => r),
  parseFeedback: vi.fn((r: Record<string, unknown>) => r),
  parseAuditEntry: vi.fn((r: Record<string, unknown>) => r),
}));

async function request(app: ReturnType<typeof createApp>, method: string, path: string, body?: unknown) {
  const url = `http://localhost${path}`;
  const init: RequestInit = { method };
  if (body) { init.body = JSON.stringify(body); init.headers = { 'Content-Type': 'application/json' }; }
  return app.fetch(new Request(url, init));
}

vi.stubEnv('NODE_ENV', 'development');

const PID = '11111111-1111-1111-1111-111111111111';
const DID = '22222222-2222-2222-2222-222222222222';

function makeDecisionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DID, project_id: PID, title: 'Use JWT', description: 'Token auth',
    reasoning: 'Stateless', made_by: 'alice', source: 'manual', confidence: 'high',
    status: 'active', tags: '["auth"]', affects: '["builder"]', alternatives_considered: '[]',
    assumptions: '[]', open_questions: '[]', dependencies: '[]',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    metadata: '{}', ...overrides,
  };
}

let app: ReturnType<typeof createApp>;
beforeEach(() => {
  app = createApp();
  vi.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('Decision CRUD', () => {
  it('POST /api/projects/:id/decisions creates a decision', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeDecisionRow()], rowCount: 1 });
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const res = await request(app, 'POST', `/api/projects/${PID}/decisions`, {
      title: 'Use JWT', description: 'Token auth', reasoning: 'Stateless', made_by: 'alice',
    });

    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body.title).toBe('Use JWT');
  });

  it('GET /api/projects/:id/decisions lists decisions', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeDecisionRow()], rowCount: 1 });

    const res = await request(app, 'GET', `/api/projects/${PID}/decisions`);
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(Array.isArray(body)).toBe(true);
  });

  it('GET /api/decisions/:id returns single decision', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeDecisionRow()], rowCount: 1 });

    const res = await request(app, 'GET', `/api/decisions/${DID}`);
    expect(res.status).toBe(200);
  });

  it('GET /api/decisions/:id returns 404 for missing', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app, 'GET', `/api/decisions/${DID}`);
    expect(res.status).toBe(404);
  });

  it('PATCH /api/decisions/:id updates decision', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeDecisionRow()], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [{ ...makeDecisionRow(), title: 'Updated' }], rowCount: 1 });
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const res = await request(app, 'PATCH', `/api/decisions/${DID}`, { title: 'Updated' });
    expect(res.status).toBe(200);
  });

  it('rejects invalid UUID', async () => {
    const res = await request(app, 'GET', '/api/decisions/not-a-uuid');
    expect(res.status).toBe(400);
  });
});
