import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';
import { createDeciGraphServer } from '../src/server.js';
import { AutoCapture } from '../src/auto-capture.js';
import { DeciGraphClient } from '../../sdk/src/index.js';
import type {
  Decision,
  DistilleryResult,
  ContextPackage,
  ImpactAnalysis,
  SessionSummary,
  Agent,
  Notification,
  Contradiction,
  GraphResult,
  ProjectStats,
  Project,
  RelevanceFeedback,
} from '../../sdk/src/index.js';

vi.mock('../../sdk/src/index.js', () => {
  const DeciGraphClient = vi.fn();
  DeciGraphClient.prototype.distill = vi.fn();
  DeciGraphClient.prototype.createDecision = vi.fn();
  DeciGraphClient.prototype.getDecision = vi.fn();
  DeciGraphClient.prototype.listDecisions = vi.fn();
  DeciGraphClient.prototype.searchDecisions = vi.fn();
  DeciGraphClient.prototype.supersedeDecision = vi.fn();
  DeciGraphClient.prototype.getImpact = vi.fn();
  DeciGraphClient.prototype.getContradictions = vi.fn();
  DeciGraphClient.prototype.compileContext = vi.fn();
  DeciGraphClient.prototype.createSession = vi.fn();
  DeciGraphClient.prototype.listSessions = vi.fn();
  DeciGraphClient.prototype.getNotifications = vi.fn();
  DeciGraphClient.prototype.listAgents = vi.fn();
  DeciGraphClient.prototype.getProjectStats = vi.fn();
  DeciGraphClient.prototype.getProject = vi.fn();
  DeciGraphClient.prototype.getGraph = vi.fn();
  DeciGraphClient.prototype.recordFeedback = vi.fn();
  DeciGraphClient.prototype.health = vi.fn();
  return { DeciGraphClient };
});

const BASE_CONFIG = {
  apiUrl: 'http://localhost:3100',
  apiKey: 'test-key',
  projectId: 'proj-abc123',
  agentId: 'agent-xyz789',
};

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: 'dec-001',
    project_id: 'proj-abc123',
    title: 'Use PostgreSQL as the primary database',
    description: 'We will use PostgreSQL for all relational data storage.',
    reasoning: 'Strong community support, JSONB columns, and mature ecosystem.',
    made_by: 'alice',
    source: 'manual',
    confidence: 'high',
    status: 'active',
    alternatives_considered: [],
    affects: ['api', 'infra'],
    tags: ['database', 'architecture'],
    assumptions: [],
    open_questions: [],
    dependencies: [],
    confidence_decay_rate: 0,
    created_at: '2026-01-10T10:00:00Z',
    updated_at: '2026-01-10T10:00:00Z',
    metadata: {},
    ...overrides,
  };
}

function makeDistillResult(overrides: Partial<DistilleryResult> = {}): DistilleryResult {
  return {
    decisions_extracted: 2,
    contradictions_found: 0,
    decisions: [makeDecision(), makeDecision({ id: 'dec-002', title: 'Use Redis for caching' })],
    ...overrides,
  };
}

function getToolHandler(server: ReturnType<typeof createDeciGraphServer>, toolName: string) {
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: Function }> })
    ._registeredTools;
  const entry = tools[toolName];
  if (!entry) throw new Error(`Tool not found: ${toolName}. Available: ${Object.keys(tools).join(', ')}`);
  return entry.handler;
}

function getClient(server: ReturnType<typeof createDeciGraphServer>): DeciGraphClient {
  return (DeciGraphClient as unknown as { mock: { instances: DeciGraphClient[] } }).mock.instances[0]!;
}

describe('createDeciGraphServer — tool registration', () => {
  it('registers all 12 tools', () => {
    const server = createDeciGraphServer(BASE_CONFIG);
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    expect(tools? Object.keys(tools).length : 0).toBe(12);
  });

  it('each tool has a valid name matching decigraph_ prefix', () => {
    const server = createDeciGraphServer(BASE_CONFIG);
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    for (const name of Object.keys(tools)) {
      expect(name).toMatch(/^decigraph_/);
    }
  });

  it('each tool has an input schema defined', () => {
    const server = createDeciGraphServer(BASE_CONFIG);
    const tools = (
      server as unknown as { _registeredTools: Record<string, { inputSchema?: unknown }> }
    )._registeredTools;
    for (const [name, tool] of Object.entries(tools)) {
      expect(tool.inputSchema, `${name} should have an inputSchema`).toBeDefined();
    }
  });
});

describe('createDeciGraphServer — resource registration', () => {
  it('registers all 7 resources', () => {
    const server = createDeciGraphServer(BASE_CONFIG);
    const resources = (server as unknown as { _registeredResources: Record<string, unknown> })
      ._registeredResources;
    const templates = (
      server as unknown as { _registeredResourceTemplates: Record<string, unknown> }
    )._registeredResourceTemplates;
    const resCount = resources ? Object.keys(resources).length : 0;
    const tmplCount = templates ? Object.keys(templates).length : 0;
    const total = resCount + tmplCount;
    expect(total).toBe(7);
  });

  it('each static resource has a valid decigraph:// URI', () => {
    const server = createDeciGraphServer(BASE_CONFIG);
    const resources = (server as unknown as { _registeredResources: Record<string, unknown> })
      ._registeredResources;
    for (const uri of Object.keys(resources)) {
      expect(uri).toMatch(/^decigraph:\/\//);
    }
  });
});

describe('decigraph_auto_capture tool', () => {
  let client: DeciGraphClient;
  let server: ReturnType<typeof createDeciGraphServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createDeciGraphServer(BASE_CONFIG);
    client = getClient(server);
  });

  it('sends conversation text to distill endpoint', async () => {
    const mockResult = makeDistillResult();
    (client.distill as MockedFunction<typeof client.distill>).mockResolvedValue(mockResult);

    const handler = getToolHandler(server, 'decigraph_auto_capture');
    await handler({
      conversation_text: 'We decided to use React for the frontend because of team familiarity.',
      agent_name: 'dev-agent',
    });

    expect(client.distill).toHaveBeenCalledWith('proj-abc123', {
      conversation_text: 'We decided to use React for the frontend because of team familiarity.',
      session_id: undefined,
      agent_name: 'dev-agent',
    });
  });

  it('returns extracted decision count in response', async () => {
    const mockResult = makeDistillResult({ decisions_extracted: 3, contradictions_found: 1 });
    (client.distill as MockedFunction<typeof client.distill>).mockResolvedValue(mockResult);

    const handler = getToolHandler(server, 'decigraph_auto_capture');
    const result = await handler({
      conversation_text: 'Long conversation with several decisions embedded in it.',
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.decisions_extracted).toBe(3);
    expect(parsed.contradictions_found).toBe(1);
    expect(parsed.details).toHaveLength(2);
  });

  it('calls distill even with empty text and returns result', async () => {
    const handler = getToolHandler(server, 'decigraph_auto_capture');
    const result = await handler({ conversation_text: '' });
    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
  });
});

describe('decigraph_compile_context tool', () => {
  let client: DeciGraphClient;
  let server: ReturnType<typeof createDeciGraphServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createDeciGraphServer(BASE_CONFIG);
    client = getClient(server);
  });

  it('sends agent_name and task_description to compileContext', async () => {
    const mockPackage: Partial<ContextPackage> = {
      formatted_markdown: '# Context\n\n## Decisions\n\n- Use PostgreSQL',
      token_count: 1500,
      budget_used_pct: 30,
      decisions_considered: 10,
      decisions_included: 4,
      compilation_time_ms: 45,
    };
    (client.compileContext as MockedFunction<typeof client.compileContext>).mockResolvedValue(
      mockPackage as ContextPackage,
    );

    const handler = getToolHandler(server, 'decigraph_compile_context');
    await handler({
      agent_name: 'backend-agent',
      task_description: 'Implement the user authentication module',
      max_tokens: 8000,
    });

    expect(client.compileContext).toHaveBeenCalledWith({
      agent_name: 'backend-agent',
      project_id: 'proj-abc123',
      task_description: 'Implement the user authentication module',
      max_tokens: 8000,
    });
  });

  it('returns formatted_markdown in response', async () => {
    const mockPackage: Partial<ContextPackage> = {
      formatted_markdown: '# Context Package\n\nRelevant decisions for your task.',
      token_count: 900,
      budget_used_pct: 18,
      decisions_considered: 5,
      decisions_included: 2,
      compilation_time_ms: 30,
    };
    (client.compileContext as MockedFunction<typeof client.compileContext>).mockResolvedValue(
      mockPackage as ContextPackage,
    );

    const handler = getToolHandler(server, 'decigraph_compile_context');
    const result = await handler({
      agent_name: 'frontend-agent',
      task_description: 'Build the dashboard UI',
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.formatted_markdown).toBe('# Context Package\n\nRelevant decisions for your task.');
    expect(parsed.stats.token_count).toBe(900);
    expect(parsed.stats.decisions_included).toBe(2);
  });

  it('propagates error when compileContext fails due to unknown agent', async () => {
    (client.compileContext as MockedFunction<typeof client.compileContext>).mockRejectedValue(
      new Error('Agent not found'),
    );

    const handler = getToolHandler(server, 'decigraph_compile_context');
    await expect(
      handler({ agent_name: 'nonexistent-agent', task_description: 'Some task' }),
    ).rejects.toThrow('Agent not found');
  });
});

describe('decigraph_record_decision tool', () => {
  let client: DeciGraphClient;
  let server: ReturnType<typeof createDeciGraphServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createDeciGraphServer(BASE_CONFIG);
    client = getClient(server);
  });

  it('sends all required fields to createDecision', async () => {
    const created = makeDecision({ id: 'dec-new', made_by: 'agent-xyz789' });
    (client.createDecision as MockedFunction<typeof client.createDecision>).mockResolvedValue(
      created,
    );
    (client.getImpact as MockedFunction<typeof client.getImpact>).mockResolvedValue({
      decision: created,
      downstream_decisions: [],
      affected_agents: [],
      cached_contexts_invalidated: 0,
      blocking_decisions: [],
      supersession_chain: [],
    } as ImpactAnalysis);

    const handler = getToolHandler(server, 'decigraph_record_decision');
    await handler({
      title: 'Use TypeScript across all packages',
      description: 'All server and client code will be written in TypeScript.',
      reasoning: 'Type safety reduces runtime errors and improves developer experience.',
      tags: ['architecture', 'tooling'],
      affects: ['api', 'frontend', 'sdk'],
      confidence: 'high',
    });

    expect(client.createDecision).toHaveBeenCalledWith(
      'proj-abc123',
      expect.objectContaining({
        title: 'Use TypeScript across all packages',
        description: 'All server and client code will be written in TypeScript.',
        reasoning: 'Type safety reduces runtime errors and improves developer experience.',
        made_by: 'agent-xyz789',
        tags: ['architecture', 'tooling'],
        affects: ['api', 'frontend', 'sdk'],
        confidence: 'high',
        source: 'manual',
      }),
    );
  });

  it('returns created decision id and status', async () => {
    const created = makeDecision({ id: 'dec-789', status: 'active' });
    (client.createDecision as MockedFunction<typeof client.createDecision>).mockResolvedValue(
      created,
    );
    (client.getImpact as MockedFunction<typeof client.getImpact>).mockResolvedValue({
      decision: created,
      downstream_decisions: [],
      affected_agents: [],
      cached_contexts_invalidated: 0,
      blocking_decisions: [],
      supersession_chain: [],
    } as ImpactAnalysis);

    const handler = getToolHandler(server, 'decigraph_record_decision');
    const result = await handler({
      title: 'Deploy to AWS ECS',
      description: 'Use AWS ECS for container orchestration.',
      reasoning: 'Already have AWS infrastructure in place.',
      tags: ['infrastructure'],
      affects: ['deployment'],
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.decision_id).toBe('dec-789');
    expect(parsed.status).toBe('active');
    expect(parsed.contradictions).toEqual([]);
  });
});

describe('decigraph_supersede_decision tool', () => {
  let client: DeciGraphClient;
  let server: ReturnType<typeof createDeciGraphServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createDeciGraphServer(BASE_CONFIG);
    client = getClient(server);
  });

  it('sends old_decision_id with new fields to supersedeDecision', async () => {
    const oldDecision = makeDecision({ id: 'dec-old', status: 'superseded' });
    const newDecision = makeDecision({ id: 'dec-new', status: 'active' });
    (client.supersedeDecision as MockedFunction<typeof client.supersedeDecision>).mockResolvedValue(
      { oldDecision, newDecision },
    );
    (client.getImpact as MockedFunction<typeof client.getImpact>).mockResolvedValue({
      decision: newDecision,
      downstream_decisions: [],
      affected_agents: [{ id: 'agent-1', name: 'reviewer', role: 'reviewer', project_id: 'proj-abc123' }],
      cached_contexts_invalidated: 2,
      blocking_decisions: [],
      supersession_chain: [],
    } as ImpactAnalysis);

    const handler = getToolHandler(server, 'decigraph_supersede_decision');
    await handler({
      old_decision_id: 'dec-old',
      title: 'Use Kubernetes instead of ECS',
      description: 'Switching to Kubernetes for better multi-cloud portability.',
      reasoning: 'Business requirement for vendor-agnostic infrastructure.',
      made_by: 'platform-team',
      tags: ['infrastructure'],
    });

    expect(client.supersedeDecision).toHaveBeenCalledWith(
      'dec-old',
      expect.objectContaining({
        title: 'Use Kubernetes instead of ECS',
        made_by: 'platform-team',
        tags: ['infrastructure'],
      }),
    );
  });

  it('returns new decision id and superseded id in response', async () => {
    const oldDecision = makeDecision({ id: 'dec-old', status: 'superseded' });
    const newDecision = makeDecision({ id: 'dec-new', status: 'active' });
    (client.supersedeDecision as MockedFunction<typeof client.supersedeDecision>).mockResolvedValue(
      { oldDecision, newDecision },
    );
    (client.getImpact as MockedFunction<typeof client.getImpact>).mockResolvedValue({
      decision: newDecision,
      downstream_decisions: [],
      affected_agents: [],
      cached_contexts_invalidated: 0,
      blocking_decisions: [],
      supersession_chain: [],
    } as ImpactAnalysis);

    const handler = getToolHandler(server, 'decigraph_supersede_decision');
    const result = await handler({
      old_decision_id: 'dec-old',
      title: 'Switch to Vite',
      description: 'Replace webpack with Vite for the build toolchain.',
      reasoning: 'Faster builds and simpler config.',
      made_by: 'frontend-lead',
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.new_decision_id).toBe('dec-new');
    expect(parsed.superseded_id).toBe('dec-old');
  });
});

describe('tool error handling', () => {
  let client: DeciGraphClient;
  let server: ReturnType<typeof createDeciGraphServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createDeciGraphServer(BASE_CONFIG);
    client = getClient(server);
  });

  it('propagates error on API 500 from distill', async () => {
    const serverError = Object.assign(new Error('Internal server error'), { statusCode: 500 });
    (client.distill as MockedFunction<typeof client.distill>).mockRejectedValue(serverError);

    const handler = getToolHandler(server, 'decigraph_auto_capture');
    await expect(
      handler({ conversation_text: 'We decided on a caching strategy using Redis.' }),
    ).rejects.toThrow('Internal server error');
  });

  it('propagates error on API 404 from getDecision', async () => {
    const notFoundError = Object.assign(new Error('Decision not found'), { statusCode: 404 });
    (client.listDecisions as MockedFunction<typeof client.listDecisions>).mockRejectedValue(
      notFoundError,
    );

    const handler = getToolHandler(server, 'decigraph_list_decisions');
    await expect(handler({ status: 'active' })).rejects.toThrow('Decision not found');
  });

  it('handles network failure gracefully by re-throwing', async () => {
    const networkError = new Error('ECONNREFUSED connect ECONNREFUSED 127.0.0.1:3100');
    (client.compileContext as MockedFunction<typeof client.compileContext>).mockRejectedValue(
      networkError,
    );

    const handler = getToolHandler(server, 'decigraph_compile_context');
    await expect(
      handler({ agent_name: 'dev', task_description: 'Fix the login bug' }),
    ).rejects.toThrow('ECONNREFUSED');
  });
});

describe('decigraph_get_notifications — no agent ID configured', () => {
  it('returns error message when agentId is not set', async () => {
    vi.clearAllMocks();
    const serverNoAgent = createDeciGraphServer({ ...BASE_CONFIG, agentId: undefined });
    const handler = getToolHandler(serverNoAgent, 'decigraph_get_notifications');
    const result = await handler({ unread_only: true });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toMatch(/No agent ID/);
  });
});

describe('decigraph_feedback — no agent ID configured', () => {
  it('returns error message when agentId is not set', async () => {
    vi.clearAllMocks();
    const serverNoAgent = createDeciGraphServer({ ...BASE_CONFIG, agentId: undefined });
    const handler = getToolHandler(serverNoAgent, 'decigraph_feedback');
    const result = await handler({
      decision_id: 'dec-001',
      was_useful: true,
      usage_signal: 'referenced',
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toMatch(/No agent ID/);
  });
});

describe('decigraph_search_decisions — client-side filtering', () => {
  let client: DeciGraphClient;
  let server: ReturnType<typeof createDeciGraphServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createDeciGraphServer(BASE_CONFIG);
    client = getClient(server);
  });

  it('filters decisions by status client-side after search', async () => {
    const decisions = [
      makeDecision({ id: 'dec-1', status: 'active', tags: ['api'] }),
      makeDecision({ id: 'dec-2', status: 'superseded', tags: ['api'] }),
      makeDecision({ id: 'dec-3', status: 'active', tags: ['database'] }),
    ];
    (client.searchDecisions as MockedFunction<typeof client.searchDecisions>).mockResolvedValue(
      decisions,
    );

    const handler = getToolHandler(server, 'decigraph_search_decisions');
    const result = await handler({ query: 'API design', status: 'active' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toHaveLength(2);
    expect(parsed.every((d: Decision) => d.status === 'active')).toBe(true);
  });

  it('filters decisions by tags client-side after search', async () => {
    const decisions = [
      makeDecision({ id: 'dec-1', tags: ['database', 'performance'] }),
      makeDecision({ id: 'dec-2', tags: ['api'] }),
      makeDecision({ id: 'dec-3', tags: ['database'] }),
    ];
    (client.searchDecisions as MockedFunction<typeof client.searchDecisions>).mockResolvedValue(
      decisions,
    );

    const handler = getToolHandler(server, 'decigraph_search_decisions');
    const result = await handler({ query: 'storage strategy', tags: ['database'] });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toHaveLength(2);
  });
});

describe('AutoCapture class', () => {
  let mockClient: DeciGraphClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = new DeciGraphClient({ baseUrl: 'http://localhost:3100' });
  });

  it('buffers messages and does not extract until threshold is met', async () => {
    const capture = new AutoCapture(mockClient, 'proj-abc123', 'test-agent');
    capture.setMinBufferSize(100);
    capture.setExtractionInterval(0); // no time gate

    // Add a short message below the 100-char threshold
    capture.addMessage('Short message');

    const result = await capture.extract();
    expect(result).toBeNull();
    expect(mockClient.distill).not.toHaveBeenCalled();
  });

  it('flushes on demand regardless of threshold', async () => {
    const mockResult = makeDistillResult({ decisions_extracted: 1 });
    (mockClient.distill as MockedFunction<typeof mockClient.distill>).mockResolvedValue(mockResult);

    const capture = new AutoCapture(mockClient, 'proj-abc123', 'test-agent');
    capture.setMinBufferSize(10000); // high threshold — would not auto-extract
    capture.setExtractionInterval(999999);

    capture.addMessage('We decided to use gRPC for internal service communication.');
    capture.addMessage('The reasoning is lower latency and strong typing via protobuf.');

    expect(capture.messageCount).toBe(2);

    const result = await capture.flush();
    expect(result).not.toBeNull();
    expect(result!.decisions_extracted).toBe(1);
    expect(mockClient.distill).toHaveBeenCalledOnce();
    expect(capture.messageCount).toBe(0); // buffer cleared
  });

  it('returns null from flush when buffer is empty', async () => {
    const capture = new AutoCapture(mockClient, 'proj-abc123', 'test-agent');
    const result = await capture.flush();
    expect(result).toBeNull();
    expect(mockClient.distill).not.toHaveBeenCalled();
  });

  it('restores buffer messages on distill failure', async () => {
    (mockClient.distill as MockedFunction<typeof mockClient.distill>).mockRejectedValue(
      new Error('API unreachable'),
    );

    const capture = new AutoCapture(mockClient, 'proj-abc123', 'test-agent');
    capture.setMinBufferSize(0);
    capture.setExtractionInterval(0);

    capture.addMessage('First decision message');
    capture.addMessage('Second decision message');

    await expect(capture.flush()).rejects.toThrow('API unreachable');
    // Buffer should be restored after failure
    expect(capture.messageCount).toBe(2);
  });

  it('extracts when both char and time thresholds are met', async () => {
    const mockResult = makeDistillResult({ decisions_extracted: 2 });
    (mockClient.distill as MockedFunction<typeof mockClient.distill>).mockResolvedValue(mockResult);

    const capture = new AutoCapture(mockClient, 'proj-abc123', 'test-agent');
    capture.setMinBufferSize(10);
    capture.setExtractionInterval(0); // zero ms interval — always ready

    capture.addMessage('We agreed that the API will be versioned using URL path segments like /v1/.');

    const result = await capture.extract();
    expect(result).not.toBeNull();
    expect(result!.decisions_extracted).toBe(2);
    expect(mockClient.distill).toHaveBeenCalledWith('proj-abc123', {
      conversation_text: 'We agreed that the API will be versioned using URL path segments like /v1/.',
      agent_name: 'test-agent',
    });
  });

  it('ignores blank messages when adding to buffer', () => {
    const capture = new AutoCapture(mockClient, 'proj-abc123', 'test-agent');
    capture.addMessage('   ');
    capture.addMessage('\n');
    capture.addMessage('');
    expect(capture.messageCount).toBe(0);
  });
});
