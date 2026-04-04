// DeciGraphClient SDK Tests
// Mocks `fetch` globally so no real network calls are made.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DeciGraphClient } from '../src/client.js';
import { DeciGraphApiError } from '../src/types.js';

// ── Fetch mock helpers ────────────────────────────────────────────────────────

type MockResponseInit = {
  status?: number;
  body?: unknown;
  /** If true, the mock returns a rejected promise (network error). */
  networkError?: string;
};

/** Replace globalThis.fetch with a mock that returns the given response. */
function mockFetch(opts: MockResponseInit) {
  if (opts.networkError) {
    return vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error(opts.networkError));
  }

  const status = opts.status ?? 200;
  const body = opts.body !== undefined ? JSON.stringify(opts.body) : '';

  return vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    new Response(body, {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

// ── Setup ─────────────────────────────────────────────────────────────────────

let client: DeciGraphClient;

beforeEach(() => {
  client = new DeciGraphClient({ baseUrl: 'http://localhost:4000' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Constructor ───────────────────────────────────────────────────────────────

describe('DeciGraphClient constructor', () => {
  it('strips trailing slash from baseUrl', async () => {
    const clientWithSlash = new DeciGraphClient({ baseUrl: 'http://localhost:4000/' });
    const spy = mockFetch({
      body: { status: 'ok', version: '0.1.0', timestamp: new Date().toISOString() },
    });
    await clientWithSlash.health();
    const [url] = spy.mock.calls[0]!;
    expect(String(url)).toBe('http://localhost:4000/api/health');
  });

  it('constructs without apiKey', () => {
    expect(() => new DeciGraphClient({ baseUrl: 'http://localhost:4000' })).not.toThrow();
  });

  it('constructs with apiKey', () => {
    expect(
      () => new DeciGraphClient({ baseUrl: 'http://localhost:4000', apiKey: 'nx_live_abc123' }),
    ).not.toThrow();
  });
});

// ── Auth header ───────────────────────────────────────────────────────────────

describe('Authorization header', () => {
  it('does NOT include Authorization when no apiKey provided', async () => {
    const spy = mockFetch({
      body: { status: 'ok', version: '0.1.0', timestamp: new Date().toISOString() },
    });
    await client.health();
    const [, init] = spy.mock.calls[0]!;
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.['Authorization']).toBeUndefined();
  });

  it('includes Bearer Authorization header when apiKey is provided', async () => {
    const authedClient = new DeciGraphClient({
      baseUrl: 'http://localhost:4000',
      apiKey: 'nx_live_abc123',
    });
    const spy = mockFetch({
      body: { status: 'ok', version: '0.1.0', timestamp: new Date().toISOString() },
    });
    await authedClient.health();
    const [, init] = spy.mock.calls[0]!;
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.['Authorization']).toBe('Bearer nx_live_abc123');
  });

  it('includes Content-Type: application/json on POST', async () => {
    const spy = mockFetch({
      status: 201,
      body: {
        id: 'proj-1',
        name: 'TaskFlow',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        metadata: {},
      },
    });
    await client.createProject({ name: 'TaskFlow' });
    const [, init] = spy.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });
});

// ── Health ─────────────────────────────────────────────────────────────────────

describe('health()', () => {
  it('calls GET /api/health', async () => {
    const expected = { status: 'ok', version: '0.1.0', timestamp: '2026-01-01T00:00:00.000Z' };
    const spy = mockFetch({ body: expected });
    const result = await client.health();
    expect(result).toEqual(expected);
    const [url] = spy.mock.calls[0]!;
    expect(String(url)).toBe('http://localhost:4000/api/health');
  });
});

// ── Projects ──────────────────────────────────────────────────────────────────

describe('createProject()', () => {
  it('sends POST /api/projects with the input body', async () => {
    const mockProject = {
      id: 'proj-abc',
      name: 'TaskFlow',
      description: 'Task management platform',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      metadata: {},
    };

    const spy = mockFetch({ status: 201, body: mockProject });
    const result = await client.createProject({
      name: 'TaskFlow',
      description: 'Task management platform',
    });

    expect(result).toEqual(mockProject);

    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toBe('http://localhost:4000/api/projects');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      name: 'TaskFlow',
      description: 'Task management platform',
    });
  });
});

describe('getProject()', () => {
  it('sends GET /api/projects/:id and returns parsed response', async () => {
    const mockProject = {
      id: 'proj-xyz',
      name: 'DeciGraph Demo',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      metadata: {},
    };

    const spy = mockFetch({ body: mockProject });
    const result = await client.getProject('proj-xyz');

    expect(result).toEqual(mockProject);

    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toBe('http://localhost:4000/api/projects/proj-xyz');
    expect(init?.method).toBe('GET');
  });
});

// ── Decisions ─────────────────────────────────────────────────────────────────

describe('createDecision()', () => {
  it('sends POST /api/projects/:projectId/decisions with body', async () => {
    const mockDecision = {
      id: 'dec-1',
      project_id: 'proj-1',
      title: 'Use Next.js',
      description: 'Frontend framework decision',
      reasoning: 'Best DX',
      made_by: 'sarah-architect',
      source: 'manual',
      confidence: 'high',
      status: 'active',
      alternatives_considered: [],
      affects: [],
      tags: ['architecture', 'frontend'],
      assumptions: [],
      open_questions: [],
      dependencies: [],
      confidence_decay_rate: 0,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      metadata: {},
    };

    const spy = mockFetch({ status: 201, body: mockDecision });
    const input = {
      project_id: 'proj-1',
      title: 'Use Next.js',
      description: 'Frontend framework decision',
      reasoning: 'Best DX',
      made_by: 'sarah-architect',
      tags: ['architecture', 'frontend'],
    };

    const result = await client.createDecision('proj-1', input);
    expect(result).toEqual(mockDecision);

    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toBe('http://localhost:4000/api/projects/proj-1/decisions');
    expect(init?.method).toBe('POST');
  });
});

describe('listDecisions()', () => {
  it('sends GET with no query params when no filters provided', async () => {
    const spy = mockFetch({ body: [] });
    await client.listDecisions('proj-1');

    const [url] = spy.mock.calls[0]!;
    expect(String(url)).toBe('http://localhost:4000/api/projects/proj-1/decisions');
  });

  it('sends query params when filters provided', async () => {
    const spy = mockFetch({ body: [] });
    await client.listDecisions('proj-1', { status: 'active', limit: 10, offset: 0 });

    const [url] = spy.mock.calls[0]!;
    const urlStr = String(url);
    expect(urlStr).toContain('status=active');
    expect(urlStr).toContain('limit=10');
    expect(urlStr).toContain('offset=0');
  });

  it('serialises tags array to comma-separated string', async () => {
    const spy = mockFetch({ body: [] });
    await client.listDecisions('proj-1', { tags: ['security', 'api'] });

    const [url] = spy.mock.calls[0]!;
    expect(String(url)).toContain('tags=security%2Capi');
  });
});

describe('updateDecision()', () => {
  it('sends PATCH /api/decisions/:id with partial body', async () => {
    const mockUpdated = {
      id: 'dec-1',
      project_id: 'proj-1',
      title: 'Use JWT for API authentication',
      description: 'Stateless token-based auth for horizontal scaling',
      reasoning: 'Eliminates server-side session storage',
      made_by: 'alice-architect',
      source: 'manual',
      confidence: 'medium',
      status: 'active',
      alternatives_considered: [],
      affects: [],
      tags: [],
      assumptions: [],
      open_questions: [],
      dependencies: [],
      confidence_decay_rate: 0,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      metadata: {},
    };

    const spy = mockFetch({ body: mockUpdated });
    const result = await client.updateDecision('dec-1', {
      title: 'Use JWT for API authentication',
    });

    expect(result).toEqual(mockUpdated);
    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toBe('http://localhost:4000/api/decisions/dec-1');
    expect(init?.method).toBe('PATCH');
  });
});

// ── Error Handling ────────────────────────────────────────────────────────────

describe('error handling', () => {
  it('throws DeciGraphApiError with statusCode 404 for not-found responses', async () => {
    mockFetch({
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'Project not found: xyz' } },
    });

    await expect(client.getProject('xyz')).rejects.toThrow(DeciGraphApiError);

    // Also check the error properties
    try {
      mockFetch({
        status: 404,
        body: { error: { code: 'NOT_FOUND', message: 'Project not found: xyz' } },
      });
      await client.getProject('xyz');
    } catch (err) {
      expect(err).toBeInstanceOf(DeciGraphApiError);
      const apiErr = err as DeciGraphApiError;
      expect(apiErr.statusCode).toBe(404);
      expect(apiErr.code).toBe('NOT_FOUND');
      expect(apiErr.message).toBe('Project not found: xyz');
    }
  });

  it('throws DeciGraphApiError with statusCode 500 for server errors', async () => {
    mockFetch({
      status: 500,
      body: { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } },
    });

    await expect(client.health()).rejects.toThrow(DeciGraphApiError);

    try {
      mockFetch({
        status: 500,
        body: { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } },
      });
      await client.health();
    } catch (err) {
      const apiErr = err as DeciGraphApiError;
      expect(apiErr.statusCode).toBe(500);
      expect(apiErr.code).toBe('INTERNAL_ERROR');
    }
  });

  it('throws DeciGraphApiError with code NETWORK_ERROR for network failures', async () => {
    mockFetch({ networkError: 'ECONNREFUSED' });

    await expect(client.health()).rejects.toThrow(DeciGraphApiError);

    try {
      mockFetch({ networkError: 'ECONNREFUSED' });
      await client.health();
    } catch (err) {
      const apiErr = err as DeciGraphApiError;
      expect(apiErr.code).toBe('NETWORK_ERROR');
      expect(apiErr.statusCode).toBe(0);
      expect(apiErr.message).toContain('ECONNREFUSED');
    }
  });

  it('falls back to API_ERROR code when error body has no code', async () => {
    mockFetch({
      status: 422,
      body: { error: { message: 'Unprocessable' } }, // no code field
    });

    try {
      await client.createProject({ name: 'X' });
    } catch (err) {
      const apiErr = err as DeciGraphApiError;
      expect(apiErr.code).toBe('API_ERROR');
      expect(apiErr.statusCode).toBe(422);
    }
  });

  it('handles non-JSON error body gracefully', async () => {
    // Mock a response with a non-JSON body (e.g., plain text error)
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Internal Server Error', { status: 500 }),
    );

    await expect(client.health()).rejects.toThrow(DeciGraphApiError);
  });

  it('DeciGraphApiError is an instance of Error', async () => {
    mockFetch({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'Not found' } } });
    try {
      await client.getProject('missing');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(DeciGraphApiError);
    }
  });
});

// ── POST methods send correct method ─────────────────────────────────────────

describe('HTTP method correctness', () => {
  it('compileContext sends POST /api/compile', async () => {
    const spy = mockFetch({
      body: {
        token_count: 100,
        decisions: [],
        artifacts: [],
        notifications: [],
        recent_sessions: [],
        formatted_markdown: '',
        formatted_json: '{}',
        agent: { name: 'bot', role: 'builder' },
        task: 'test',
        compiled_at: '',
        budget_used_pct: 1,
        decisions_considered: 0,
        decisions_included: 0,
        relevance_threshold_used: 0,
        compilation_time_ms: 1,
      },
    });
    await client.compileContext({
      agent_name: 'bot',
      project_id: 'proj-1',
      task_description: 'Implement the login endpoint',
    });
    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toBe('http://localhost:4000/api/compile');
    expect(init?.method).toBe('POST');
  });

  it('deleteEdge sends DELETE /api/edges/:id', async () => {
    const spy = mockFetch({ body: { deleted: true, id: 'edge-1' } });
    await client.deleteEdge('edge-1');
    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toBe('http://localhost:4000/api/edges/edge-1');
    expect(init?.method).toBe('DELETE');
  });

  it('markNotificationRead sends PATCH /api/notifications/:id/read', async () => {
    const mockNotif = {
      id: 'notif-1',
      agent_id: 'agent-1',
      notification_type: 'decision_created',
      message: 'The authentication decision has been updated.',
      urgency: 'low',
      created_at: new Date().toISOString(),
      read_at: new Date().toISOString(),
    };
    const spy = mockFetch({ body: mockNotif });
    await client.markNotificationRead('notif-1');
    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toBe('http://localhost:4000/api/notifications/notif-1/read');
    expect(init?.method).toBe('PATCH');
  });

  it('supersedeDecision sends POST /api/decisions/:id/supersede', async () => {
    const mockResult = {
      newDecision: {
        id: 'dec-2',
        project_id: 'proj-1',
        title: 'Use CockroachDB for global distribution',
        description: 'Switch from PostgreSQL to CockroachDB',
        reasoning: 'Horizontal scaling requirements from load testing',
        made_by: 'alice-architect',
        source: 'manual',
        confidence: 'high',
        status: 'active',
        alternatives_considered: [],
        affects: [],
        tags: [],
        assumptions: [],
        open_questions: [],
        dependencies: [],
        confidence_decay_rate: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        metadata: {},
      },
      oldDecision: {
        id: 'dec-1',
        project_id: 'proj-1',
        title: 'Use PostgreSQL as primary database',
        description: 'PostgreSQL 17 with pgvector',
        reasoning: 'Team expertise and pgvector support',
        made_by: 'alice-architect',
        source: 'manual',
        confidence: 'high',
        status: 'superseded',
        alternatives_considered: [],
        affects: [],
        tags: [],
        assumptions: [],
        open_questions: [],
        dependencies: [],
        confidence_decay_rate: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        metadata: {},
      },
    };
    const spy = mockFetch({ body: mockResult });
    await client.supersedeDecision('dec-1', {
      title: 'Use CockroachDB for global distribution',
      description: 'Switch from PostgreSQL to CockroachDB',
      reasoning: 'Horizontal scaling requirements from load testing',
      made_by: 'alice-architect',
    });
    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toBe('http://localhost:4000/api/decisions/dec-1/supersede');
    expect(init?.method).toBe('POST');
  });
});

// ── Query parameter serialisation ─────────────────────────────────────────────

describe('query parameter serialisation', () => {
  it('getGraph appends depth param when provided', async () => {
    const spy = mockFetch({ body: { nodes: [], edges: [] } });
    await client.getGraph('dec-1', 3);
    const [url] = spy.mock.calls[0]!;
    expect(String(url)).toContain('depth=3');
  });

  it('getGraph omits depth param when undefined', async () => {
    const spy = mockFetch({ body: { nodes: [], edges: [] } });
    await client.getGraph('dec-1');
    const [url] = spy.mock.calls[0]!;
    expect(String(url)).not.toContain('depth');
  });

  it('getNotifications appends unread=true when requested', async () => {
    const spy = mockFetch({ body: [] });
    await client.getNotifications('agent-1', true);
    const [url] = spy.mock.calls[0]!;
    expect(String(url)).toContain('unread=true');
  });

  it('getNotifications omits unread param when false', async () => {
    const spy = mockFetch({ body: [] });
    await client.getNotifications('agent-1', false);
    const [url] = spy.mock.calls[0]!;
    expect(String(url)).not.toContain('unread');
  });
});
