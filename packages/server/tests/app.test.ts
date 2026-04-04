// Server Integration Tests (Hono test client — no real DB)
// The DB query function is mocked so no database is required.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp } from '../src/app.js';

// ── DB Mock ───────────────────────────────────────────────────────────────────
// We mock @decigraph/core/db/index.js before importing the app so that all
// database calls in app.ts resolve to controlled values.

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

// Keep backward compat mock for any code still importing pool.js
vi.mock('@decigraph/core/db/pool.js', () => ({
  query: mockQuery,
  getPool: vi.fn(),
  getClient: vi.fn(),
  closePool: vi.fn(),
  healthCheck: vi.fn().mockResolvedValue(true),
  transaction: vi.fn().mockImplementation(async (fn: Function) => fn({ query: mockQuery })),
}));

// Also stub parsers used in app.ts
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

// mockQuery is defined on line 11 and shared with the vi.mock factories above.

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Run a Hono app request and return the Response. */
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

  const req = new Request(url, init);
  return app.fetch(req);
}

function nowIso() {
  return new Date().toISOString();
}

// ── Test Setup ────────────────────────────────────────────────────────────────

// Set development mode so authMiddleware skips API key validation
vi.stubEnv('NODE_ENV', 'development');

let app: ReturnType<typeof createApp>;

beforeEach(() => {
  app = createApp();
  vi.clearAllMocks();
  // Audit log calls (auditMiddleware fire-and-forget) should not reject
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Health ─────────────────────────────────────────────────────────────────────

describe('GET /api/health', () => {
  it('returns 200 with status ok', async () => {
    const res = await request(app, 'GET', '/api/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; version: string; timestamp: string };
    expect(body.status).toBe('ok');
  });

  it('includes version and timestamp', async () => {
    const res = await request(app, 'GET', '/api/health');
    const body = (await res.json()) as { status: string; version: string; timestamp: string };
    expect(typeof body.version).toBe('string');
    expect(typeof body.timestamp).toBe('string');
    // Timestamp should be a valid ISO date
    expect(() => new Date(body.timestamp).toISOString()).not.toThrow();
  });

  it('does not require authentication', async () => {
    // Health check should work without any Authorization header
    const res = await request(app, 'GET', '/api/health');
    expect(res.status).toBe(200);
  });
});

// ── Projects ──────────────────────────────────────────────────────────────────

describe('POST /api/projects', () => {
  it('returns 201 with created project', async () => {
    const mockRow = {
      id: 'proj-abc',
      name: 'TaskFlow',
      description: 'Collaborative task management for distributed teams',
      created_at: nowIso(),
      updated_at: nowIso(),
      metadata: '{}',
    };

    // First call: project insert; subsequent calls: audit log
    mockQuery
      .mockResolvedValueOnce({
        rows: [mockRow],
        rowCount: 1,
        command: 'INSERT',
        oid: 0,
        fields: [],
      })
      .mockResolvedValue({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });

    const res = await request(app, 'POST', '/api/projects', {
      name: 'TaskFlow',
      description: 'Collaborative task management for distributed teams',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; name: string };
    expect(body.name).toBe('TaskFlow');
    expect(body.id).toBe('proj-abc');
  });

  it('returns 400 when name is missing', async () => {
    const res = await request(app, 'POST', '/api/projects', { description: 'No name provided' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('name');
  });

  it('returns 400 when name is empty string', async () => {
    const res = await request(app, 'POST', '/api/projects', { name: '   ' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when name is not a string', async () => {
    const res = await request(app, 'POST', '/api/projects', { name: 123 });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/projects/:id', () => {
  it('returns 200 with project when found', async () => {
    const mockRow = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      name: 'Auth Service',
      description: null,
      created_at: nowIso(),
      updated_at: nowIso(),
      metadata: '{}',
    };

    mockQuery
      .mockResolvedValueOnce({
        rows: [mockRow],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      })
      .mockResolvedValue({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });

    const res = await request(app, 'GET', '/api/projects/a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
  });

  it('returns 404 when project does not exist', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] })
      .mockResolvedValue({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });

    const res = await request(app, 'GET', '/api/projects/a7b8c9d0-e1f2-3456-0123-567890123456');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

// ── Error Handler ─────────────────────────────────────────────────────────────

describe('error handler', () => {
  it('returns 404 with error envelope for NOT_FOUND errors', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] })
      .mockResolvedValue({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });

    const res = await request(app, 'GET', '/api/projects/e5f6a7b8-c9d0-1234-ef12-345678901234');
    const body = (await res.json()) as { error: { code: string; message: string } };

    expect(res.status).toBe(404);
    expect(body).toHaveProperty('error');
    expect(body.error).toHaveProperty('code');
    expect(body.error).toHaveProperty('message');
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns 400 with proper envelope for VALIDATION_ERROR', async () => {
    const res = await request(app, 'POST', '/api/projects', {});
    const body = (await res.json()) as { error: { code: string; message: string } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(typeof body.error.message).toBe('string');
  });

  it('returns structured error envelope with code + message fields', async () => {
    const res = await request(app, 'POST', '/api/projects', { name: '' });
    const body = (await res.json()) as { error?: { code?: string; message?: string } };

    expect(body).toHaveProperty('error');
    expect(typeof body.error?.code).toBe('string');
    expect(typeof body.error?.message).toBe('string');
  });

  it('returns 500 for unexpected database errors', async () => {
    // Simulate a DB crash on the INSERT
    mockQuery.mockRejectedValueOnce(new Error('connection lost'));

    const res = await request(app, 'POST', '/api/projects', { name: 'Will Fail' });
    // Could be 500 from unhandled error
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});

// ── Agents ────────────────────────────────────────────────────────────────────

describe('POST /api/projects/:id/agents', () => {
  it('returns 201 with created agent', async () => {
    const projectRow = { id: 'b2c3d4e5-f6a7-8901-bcde-f12345678901' };
    const agentRow = {
      id: 'c3d4e5f6-a7b8-9012-cdef-123456789012',
      project_id: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
      name: 'sarah-architect',
      role: 'architect',
      relevance_profile: JSON.stringify({
        weights: { architecture: 1.0 },
        decision_depth: 3,
        freshness_preference: 'balanced',
        include_superseded: true,
      }),
      context_budget_tokens: 50000,
      created_at: nowIso(),
      updated_at: nowIso(),
    };

    mockQuery
      .mockResolvedValueOnce({
        rows: [projectRow],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      }) // project check
      .mockResolvedValueOnce({
        rows: [agentRow],
        rowCount: 1,
        command: 'INSERT',
        oid: 0,
        fields: [],
      }) // agent insert
      .mockResolvedValue({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] }); // audit

    const res = await request(
      app,
      'POST',
      '/api/projects/b2c3d4e5-f6a7-8901-bcde-f12345678901/agents',
      {
        name: 'sarah-architect',
        role: 'architect',
      },
    );

    expect(res.status).toBe(201);
  });

  it('returns 400 when name is missing', async () => {
    const res = await request(
      app,
      'POST',
      '/api/projects/b2c3d4e5-f6a7-8901-bcde-f12345678901/agents',
      { role: 'builder' },
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when role is missing', async () => {
    const res = await request(
      app,
      'POST',
      '/api/projects/b2c3d4e5-f6a7-8901-bcde-f12345678901/agents',
      { name: 'bob' },
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 when project does not exist', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] }) // project not found
      .mockResolvedValue({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });

    const res = await request(
      app,
      'POST',
      '/api/projects/f6a7b8c9-d0e1-2345-f123-456789012345/agents',
      {
        name: 'bot',
        role: 'builder',
      },
    );
    expect(res.status).toBe(404);
  });
});

describe('GET /api/projects/:id/agents', () => {
  it('returns 200 with list of agents', async () => {
    const agentRows = [
      {
        id: 'c3d4e5f6-a7b8-9012-cdef-123456789012',
        project_id: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
        name: 'marcus-builder',
        role: 'builder',
        relevance_profile: '{}',
        context_budget_tokens: 50000,
        created_at: nowIso(),
        updated_at: nowIso(),
      },
      {
        id: 'd4e5f6a7-b8c9-0123-def1-234567890123',
        project_id: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
        name: 'sarah-reviewer',
        role: 'reviewer',
        relevance_profile: '{}',
        context_budget_tokens: 50000,
        created_at: nowIso(),
        updated_at: nowIso(),
      },
    ];

    mockQuery
      .mockResolvedValueOnce({
        rows: agentRows,
        rowCount: 2,
        command: 'SELECT',
        oid: 0,
        fields: [],
      })
      .mockResolvedValue({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });

    const res = await request(
      app,
      'GET',
      '/api/projects/b2c3d4e5-f6a7-8901-bcde-f12345678901/agents',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
  });
});

// ── CORS / OPTIONS ────────────────────────────────────────────────────────────

describe('CORS middleware', () => {
  it('responds 204 to OPTIONS preflight requests', async () => {
    const res = await request(app, 'OPTIONS', '/api/health');
    expect(res.status).toBe(204);
  });

  it('includes CORS headers on GET responses', async () => {
    const res = await request(app, 'GET', '/api/health');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeTruthy();
    expect(res.headers.get('Access-Control-Allow-Methods')).toBeTruthy();
  });
});

// ── Response Timing ───────────────────────────────────────────────────────────

describe('request timing middleware', () => {
  it('includes X-Response-Time header', async () => {
    const res = await request(app, 'GET', '/api/health');
    const timing = res.headers.get('X-Response-Time');
    expect(timing).toBeTruthy();
    expect(timing).toMatch(/^\d+ms$/);
  });
});
