/**
 * OpenAPI Spec + Swagger UI Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp } from '../src/app.js';

// ── DB Mock (same pattern as app.test.ts) ─────────────────────────────────

const mockQuery = vi.fn();
vi.mock('@nexus/core/db/index.js', () => ({
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

vi.mock('@nexus/core/db/pool.js', () => ({
  query: mockQuery,
  getPool: vi.fn(),
  getClient: vi.fn(),
  closePool: vi.fn(),
  healthCheck: vi.fn().mockResolvedValue(true),
  transaction: vi.fn().mockImplementation(async (fn: Function) => fn({ query: mockQuery })),
}));

vi.mock('@nexus/core/db/parsers.js', () => ({
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

// ── Helpers ───────────────────────────────────────────────────────────────

async function request(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
): Promise<Response> {
  const url = `http://localhost${path}`;
  return app.fetch(new Request(url, { method }));
}

// ── Setup ─────────────────────────────────────────────────────────────────

// Set a real API key so auth is enforced for protected routes
vi.stubEnv('NEXUS_API_KEY', 'test-secret-key-12345');

let app: ReturnType<typeof createApp>;

beforeEach(() => {
  app = createApp();
  vi.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('GET /api/openapi.json', () => {
  it('returns valid JSON with status 200', async () => {
    const res = await request(app, 'GET', '/api/openapi.json');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeDefined();
    expect(typeof body).toBe('object');
  });

  it('has openapi field = "3.1.0"', async () => {
    const res = await request(app, 'GET', '/api/openapi.json');
    const body = (await res.json()) as { openapi: string };
    expect(body.openapi).toBe('3.1.0');
  });

  it('has paths object with at least 20 routes', async () => {
    const res = await request(app, 'GET', '/api/openapi.json');
    const body = (await res.json()) as { paths: Record<string, unknown> };
    expect(body.paths).toBeDefined();
    const routeCount = Object.keys(body.paths).length;
    expect(routeCount).toBeGreaterThanOrEqual(20);
  });

  it('does not require authentication', async () => {
    // Request without Bearer token — should still return 200
    const res = await request(app, 'GET', '/api/openapi.json');
    expect(res.status).toBe(200);
  });
});

describe('GET /api/docs', () => {
  it('returns HTML with status 200', async () => {
    const res = await request(app, 'GET', '/api/docs');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('<!DOCTYPE html>');
    expect(text).toContain('swagger-ui');
  });

  it('does not require authentication', async () => {
    const res = await request(app, 'GET', '/api/docs');
    expect(res.status).toBe(200);
  });
});
