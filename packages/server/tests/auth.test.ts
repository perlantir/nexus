/**
 * Auth Middleware Tests — tests auth-exempt paths
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

async function request(app: ReturnType<typeof createApp>, path: string) {
  return app.fetch(new Request(`http://localhost${path}`));
}

vi.stubEnv('NODE_ENV', 'development');

let app: ReturnType<typeof createApp>;
beforeEach(() => {
  app = createApp();
  vi.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('Auth Middleware', () => {
  it('/api/health is accessible without auth', async () => {
    const res = await request(app, '/api/health');
    expect(res.status).toBe(200);
  });

  it('/api/docs returns Swagger UI HTML', async () => {
    const res = await request(app, '/api/docs');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('swagger');
  });

  it('/api/openapi.json returns spec', async () => {
    const res = await request(app, '/api/openapi.json');
    expect(res.status).toBe(200);
    const body = await res.json() as { openapi: string };
    expect(body.openapi).toBe('3.1.0');
  });

  it('protected routes accessible in dev mode without token', async () => {
    const res = await request(app, '/api/projects');
    expect(res.status).toBe(200);
  });
});
