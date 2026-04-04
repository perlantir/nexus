/**
 * Compile Route Tests
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
  parseAgent: vi.fn((r: Record<string, unknown>) => ({ ...r, relevance_profile: { weights: {}, decision_depth: 2, freshness_preference: 'balanced', include_superseded: false }, role: r.role ?? 'builder' })),
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

vi.mock('@decigraph/core/context-compiler/index.js', () => ({
  compileContext: vi.fn().mockResolvedValue({
    agent: { name: 'builder', role: 'builder' },
    task: 'Build auth module',
    compiled_at: new Date().toISOString(),
    token_count: 3200,
    budget_used_pct: 6,
    decisions: [
      { id: 'dec-1', title: 'Use JWT', combined_score: 0.92, scoring_breakdown: { direct_affect: 0.3, tag_matching: 0.2, role_relevance: 0.15, semantic_similarity: 0.22, status_penalty: 0 } },
    ],
    artifacts: [],
    notifications: [],
    recent_sessions: [],
    formatted_markdown: '# Context\n',
    formatted_json: '{}',
    decisions_considered: 10,
    decisions_included: 1,
    relevance_threshold_used: 0,
    compilation_time_ms: 45,
  }),
  scoreDecision: vi.fn(),
}));

async function request(app: ReturnType<typeof createApp>, method: string, path: string, body?: unknown) {
  const url = `http://localhost${path}`;
  const init: RequestInit = { method };
  if (body) { init.body = JSON.stringify(body); init.headers = { 'Content-Type': 'application/json' }; }
  return app.fetch(new Request(url, init));
}

vi.stubEnv('NODE_ENV', 'development');

let app: ReturnType<typeof createApp>;
beforeEach(() => {
  app = createApp();
  vi.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('POST /api/compile', () => {
  it('returns 200 with compiled context', async () => {
    // Agent lookup for history recording
    mockQuery.mockResolvedValue({ rows: [{ id: 'agent-1' }], rowCount: 1 });

    const res = await request(app, 'POST', '/api/compile', {
      agent_name: 'builder',
      project_id: '11111111-1111-1111-1111-111111111111',
      task_description: 'Build auth module',
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.compile_request_id).toBeDefined();
    expect(body.decisions).toBeDefined();
    expect(body.context_hash).toBeDefined();
    expect(body.feedback_hint).toBeDefined();
  });

  it('returns decisions with combined_score and scoring_breakdown', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 'agent-1' }], rowCount: 1 });

    const res = await request(app, 'POST', '/api/compile', {
      agent_name: 'builder',
      project_id: '11111111-1111-1111-1111-111111111111',
      task_description: 'Build auth',
    });

    const body = await res.json() as { decisions: Array<{ combined_score: number; scoring_breakdown: Record<string, number> }> };
    expect(body.decisions.length).toBeGreaterThan(0);
    expect(body.decisions[0].combined_score).toBeDefined();
    expect(body.decisions[0].scoring_breakdown).toBeDefined();
  });

  it('rejects missing required fields', async () => {
    const res = await request(app, 'POST', '/api/compile', {});
    expect(res.status).toBe(400);
  });
});
