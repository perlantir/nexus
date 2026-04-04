// Discovery Route Integration Tests (Hono test client — no real DB)
// DB query function, distill, and scanProjectContradictions are all mocked.

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

// ── Discovery-specific mocks ──────────────────────────────────────────────────

vi.mock('@decigraph/core/distillery/index.js', () => ({
  distill: vi.fn(),
}));

vi.mock('@decigraph/core/contradiction-detector/index.js', () => ({
  scanProjectContradictions: vi.fn(),
}));

// Import mocked modules after vi.mock calls
// mockQuery is defined on line 9 and shared with the vi.mock factories above.

const { distill } = await import('@decigraph/core/distillery/index.js');
const mockDistill = vi.mocked(distill);

const { scanProjectContradictions } = await import('@decigraph/core/contradiction-detector/index.js');
const mockScan = vi.mocked(scanProjectContradictions);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Run a Hono app request and return the Response. */
async function request(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  const url = `http://localhost${path}`;
  const init: RequestInit = { method };

  const allHeaders: Record<string, string> = {};

  if (body !== undefined) {
    allHeaders['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  if (headers) {
    Object.assign(allHeaders, headers);
  }

  if (Object.keys(allHeaders).length > 0) {
    init.headers = allHeaders;
  }

  const req = new Request(url, init);
  return app.fetch(req);
}

// ── Test Setup ────────────────────────────────────────────────────────────────

// Set development mode so authMiddleware skips API key validation
vi.stubEnv('NODE_ENV', 'development');

const PROJECT_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

let app: ReturnType<typeof createApp>;

beforeEach(() => {
  app = createApp();
  vi.clearAllMocks();
  // Default: all DB calls resolve to empty; no audit failures
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });
  // Default: distill resolves normally
  mockDistill.mockResolvedValue({ decisions_extracted: 0 });
  // Default: scan resolves normally
  mockScan.mockResolvedValue({ pairs_checked: 0, contradictions_found: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── POST /api/projects/:id/import ─────────────────────────────────────────────

describe('POST /api/projects/:id/import', () => {
  it('validates conversations array — returns 400 if not array', async () => {
    const res = await request(app, 'POST', `/api/projects/${PROJECT_ID}/import`, {
      conversations: 'not-an-array',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('conversations must be an array');
  });

  it('returns correct count summary after successful import', async () => {
    mockDistill
      .mockResolvedValueOnce({ decisions_extracted: 3 })
      .mockResolvedValueOnce({ decisions_extracted: 5 });

    const res = await request(app, 'POST', `/api/projects/${PROJECT_ID}/import`, {
      conversations: [
        { text: 'We decided to use PostgreSQL.', source_id: 'conv-1', agent_name: 'arch' },
        { text: 'We decided to use Redis for caching.', source_id: 'conv-2', agent_name: 'backend' },
      ],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      processed: number;
      decisions_extracted: number;
      errors: number;
      results: Array<{ source_id: string; decisions_extracted: number }>;
    };
    expect(body.processed).toBe(2);
    expect(body.decisions_extracted).toBe(8);
    expect(body.errors).toBe(0);
    expect(body.results).toHaveLength(2);
    expect(body.results[0].source_id).toBe('conv-1');
    expect(body.results[0].decisions_extracted).toBe(3);
    expect(body.results[1].source_id).toBe('conv-2');
    expect(body.results[1].decisions_extracted).toBe(5);
  });

  it('handles invalid text gracefully — counts as error, continues remaining items', async () => {
    mockDistill.mockResolvedValueOnce({ decisions_extracted: 2 });

    const res = await request(app, 'POST', `/api/projects/${PROJECT_ID}/import`, {
      conversations: [
        { text: 42, source_id: 'bad-conv' }, // invalid: text is not a string
        { text: 'Valid conversation text here.', source_id: 'good-conv' },
      ],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      processed: number;
      errors: number;
      results: Array<{ source_id: string; error?: string; decisions_extracted: number }>;
    };
    expect(body.errors).toBe(1);
    expect(body.processed).toBe(1);
    expect(body.results[0].source_id).toBe('bad-conv');
    expect(body.results[0].error).toBeTruthy();
    expect(body.results[1].source_id).toBe('good-conv');
    expect(body.results[1].decisions_extracted).toBe(2);
  });
});

// ── POST /api/ingest/webhook ──────────────────────────────────────────────────

describe('POST /api/ingest/webhook', () => {
  const VALID_BODY = {
    text: 'We decided to adopt microservices architecture.',
    source_id: 'slack-channel-arch',
    project_id: PROJECT_ID,
    agent_name: 'arch-agent',
  };

  it('rejects missing Authorization header — returns 401', async () => {
    vi.stubEnv('DECIGRAPH_API_KEY', 'super-secret-key');
    const newApp = createApp();

    const res = await request(newApp, 'POST', '/api/ingest/webhook', VALID_BODY);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Unauthorized');

    vi.unstubAllEnvs();
    vi.stubEnv('NODE_ENV', 'development');
  });

  it('rejects invalid auth token — returns 401', async () => {
    vi.stubEnv('DECIGRAPH_API_KEY', 'super-secret-key');
    const newApp = createApp();

    const res = await request(newApp, 'POST', '/api/ingest/webhook', VALID_BODY, {
      Authorization: 'Bearer wrong-token',
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Unauthorized');

    vi.unstubAllEnvs();
    vi.stubEnv('NODE_ENV', 'development');
  });

  it('accepts valid request with correct Bearer token — returns queued', async () => {
    vi.stubEnv('DECIGRAPH_API_KEY', 'super-secret-key');
    const newApp = createApp();

    const res = await request(newApp, 'POST', '/api/ingest/webhook', VALID_BODY, {
      Authorization: 'Bearer super-secret-key',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { queued: boolean; source_id: string };
    expect(body.queued).toBe(true);
    expect(body.source_id).toBe('slack-channel-arch');

    vi.unstubAllEnvs();
    vi.stubEnv('NODE_ENV', 'development');
  });

  it('validates required fields (text, source_id, project_id) — returns 400 when missing', async () => {
    // No DECIGRAPH_API_KEY set → auth check skipped, goes straight to validation
    const resMissingText = await request(app, 'POST', '/api/ingest/webhook', {
      source_id: 'some-source',
      project_id: PROJECT_ID,
    });
    expect(resMissingText.status).toBe(400);

    const resMissingSource = await request(app, 'POST', '/api/ingest/webhook', {
      text: 'Some text',
      project_id: PROJECT_ID,
    });
    expect(resMissingSource.status).toBe(400);

    const resMissingProject = await request(app, 'POST', '/api/ingest/webhook', {
      text: 'Some text',
      source_id: 'some-source',
    });
    expect(resMissingProject.status).toBe(400);
  });
});

// ── GET /api/projects/:id/connectors ─────────────────────────────────────────

describe('GET /api/projects/:id/connectors', () => {
  it('returns connector list from DB', async () => {
    const mockRows = [
      {
        id: 'conn-1',
        project_id: PROJECT_ID,
        connector_name: 'openclaw',
        enabled: true,
        config: { path: '/projects/myapp' },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: 'conn-2',
        project_id: PROJECT_ID,
        connector_name: 'webhook',
        enabled: false,
        config: { url: 'https://hooks.example.com/decigraph' },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    mockQuery
      .mockResolvedValueOnce({
        rows: mockRows,
        rowCount: 2,
        command: 'SELECT',
        oid: 0,
        fields: [],
      })
      .mockResolvedValue({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });

    const res = await request(app, 'GET', `/api/projects/${PROJECT_ID}/connectors`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
  });
});

// ── POST /api/projects/:id/connectors ────────────────────────────────────────

describe('POST /api/projects/:id/connectors', () => {
  it('creates a new connector config — returns 201 with connector row', async () => {
    const mockRow = {
      id: 'conn-new',
      project_id: PROJECT_ID,
      connector_name: 'directory',
      enabled: true,
      config: { path: '/data/logs' },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    mockQuery
      .mockResolvedValueOnce({
        rows: [mockRow],
        rowCount: 1,
        command: 'INSERT',
        oid: 0,
        fields: [],
      })
      .mockResolvedValue({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });

    const res = await request(app, 'POST', `/api/projects/${PROJECT_ID}/connectors`, {
      connector_name: 'directory',
      enabled: true,
      config: { path: '/data/logs' },
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; connector_name: string };
    expect(body.id).toBe('conn-new');
    expect(body.connector_name).toBe('directory');
  });

  it('upserts existing connector — same row returned after conflict resolution', async () => {
    const mockRow = {
      id: 'conn-existing',
      project_id: PROJECT_ID,
      connector_name: 'openclaw',
      enabled: false,
      config: { path: '/new/path' },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    mockQuery
      .mockResolvedValueOnce({
        rows: [mockRow],
        rowCount: 1,
        command: 'INSERT',
        oid: 0,
        fields: [],
      })
      .mockResolvedValue({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });

    const res = await request(app, 'POST', `/api/projects/${PROJECT_ID}/connectors`, {
      connector_name: 'openclaw',
      enabled: false,
      config: { path: '/new/path' },
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { enabled: boolean; connector_name: string };
    expect(body.connector_name).toBe('openclaw');
    expect(body.enabled).toBe(false);
  });
});

// ── DELETE /api/projects/:id/connectors/:name ─────────────────────────────────

describe('DELETE /api/projects/:id/connectors/:name', () => {
  it('removes connector — returns deleted: true', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'conn-1' }],
        rowCount: 1,
        command: 'DELETE',
        oid: 0,
        fields: [],
      })
      .mockResolvedValue({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });

    const res = await request(
      app,
      'DELETE',
      `/api/projects/${PROJECT_ID}/connectors/openclaw`,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: boolean; connector_name: string };
    expect(body.deleted).toBe(true);
    expect(body.connector_name).toBe('openclaw');
  });

  it('returns 404 when connector does not exist', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
        command: 'DELETE',
        oid: 0,
        fields: [],
      })
      .mockResolvedValue({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });

    const res = await request(
      app,
      'DELETE',
      `/api/projects/${PROJECT_ID}/connectors/nonexistent-connector`,
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Connector not found');
  });
});

// ── GET /api/projects/:id/discovery/status ───────────────────────────────────

describe('GET /api/projects/:id/discovery/status', () => {
  it('returns stats structure with connectors, processed_count, and recent_sources', async () => {
    const connectorRows = [
      {
        connector_name: 'openclaw',
        enabled: true,
        last_poll_at: new Date().toISOString(),
      },
    ];
    const countRow = [{ count: '42' }];
    const recentRows = [
      { id: 'src-1', project_id: PROJECT_ID, processed_at: new Date().toISOString() },
    ];

    // Three parallel queries fired by the route
    mockQuery
      .mockResolvedValueOnce({ rows: connectorRows, rowCount: 1, command: 'SELECT', oid: 0, fields: [] })
      .mockResolvedValueOnce({ rows: countRow, rowCount: 1, command: 'SELECT', oid: 0, fields: [] })
      .mockResolvedValueOnce({ rows: recentRows, rowCount: 1, command: 'SELECT', oid: 0, fields: [] })
      .mockResolvedValue({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });

    const res = await request(app, 'GET', `/api/projects/${PROJECT_ID}/discovery/status`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      connectors: Array<{ name: string; enabled: boolean; last_poll_at: string | null }>;
      processed_count: number;
      recent_sources: unknown[];
    };

    expect(Array.isArray(body.connectors)).toBe(true);
    expect(body.connectors).toHaveLength(1);
    expect(body.connectors[0].name).toBe('openclaw');
    expect(body.connectors[0].enabled).toBe(true);
    expect(typeof body.processed_count).toBe('number');
    expect(body.processed_count).toBe(42);
    expect(Array.isArray(body.recent_sources)).toBe(true);
  });
});

// ── POST /api/projects/:id/scan-contradictions ───────────────────────────────

describe('POST /api/projects/:id/scan-contradictions', () => {
  it('returns scan summary with pairs_checked and contradictions_found', async () => {
    mockScan.mockResolvedValueOnce({ pairs_checked: 15, contradictions_found: 3 });

    const res = await request(app, 'POST', `/api/projects/${PROJECT_ID}/scan-contradictions`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      pairs_checked: number;
      contradictions_found: number;
    };
    expect(body.pairs_checked).toBe(15);
    expect(body.contradictions_found).toBe(3);
    expect(mockScan).toHaveBeenCalledWith(PROJECT_ID);
  });
});
