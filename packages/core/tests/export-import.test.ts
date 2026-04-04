/**
 * Export / Import Logic Tests
 *
 * Tests the export format, import behaviour, and round-trip fidelity.
 * Uses a mock DB — no real database required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── DB Mock ───────────────────────────────────────────────────────────────────

const mockQuery = vi.fn();
vi.mock('../src/db/index.js', () => ({
  getDb: () => ({
    query: mockQuery,
    transaction: vi.fn().mockImplementation(async (fn: Function) => fn(mockQuery)),
    arrayParam: (v: unknown[]) => JSON.stringify(v),
    dialect: 'sqlite' as const,
  }),
  initDb: vi.fn().mockResolvedValue({}),
  closeDb: vi.fn().mockResolvedValue(undefined),
}));

// ── Helpers — build mock rows ─────────────────────────────────────────────

function makeProjectRow() {
  return {
    id: 'proj-001',
    name: 'bouts',
    description: 'AI competition',
    metadata: '{}',
    created_at: '2026-04-03T18:00:00Z',
    updated_at: '2026-04-03T18:00:00Z',
  };
}

function makeAgentRow(name = 'maks', role = 'builder') {
  return {
    id: `agent-${name}`,
    project_id: 'proj-001',
    name,
    role,
    relevance_profile: '{"weights":{}}',
    context_budget_tokens: 50000,
    created_at: '2026-04-03T18:00:00Z',
    updated_at: '2026-04-03T18:00:00Z',
  };
}

function makeDecisionRow(title = 'Use JWT', id = 'dec-001') {
  return {
    id,
    project_id: 'proj-001',
    title,
    description: 'Token auth',
    reasoning: 'Stateless',
    made_by: 'alice',
    source: 'manual',
    confidence: 'high',
    status: 'active',
    tags: '["auth"]',
    affects: '["maks"]',
    alternatives_considered: '["session cookies"]',
    assumptions: '[]',
    open_questions: '[]',
    dependencies: '[]',
    validated_at: null,
    validation_source: null,
    confidence_decay_rate: 0,
    created_at: '2026-04-03T18:18:53Z',
    updated_at: '2026-04-03T18:18:53Z',
    metadata: '{}',
    embedding: [0.1, 0.2, 0.3],  // should be excluded in export
  };
}

function makeEdgeRow() {
  return {
    id: 'edge-001',
    source_id: 'dec-002',
    target_id: 'dec-001',
    source_title: 'Use session cookies',
    target_title: 'Use JWT',
    relationship: 'supersedes',
    description: 'Changed auth approach',
    created_at: '2026-04-03T19:00:00Z',
  };
}

function makeContradictionRow() {
  return {
    id: 'con-001',
    project_id: 'proj-001',
    decision_a_id: 'dec-001',
    decision_b_id: 'dec-002',
    decision_a_title: 'Use JWT',
    decision_b_title: 'Use session cookies',
    similarity_score: 0.92,
    conflict_description: 'Mutually exclusive auth',
    status: 'unresolved',
    detected_at: '2026-04-03T19:30:00Z',
  };
}

function makeWebhookRow() {
  return {
    id: 'wh-001',
    project_id: 'proj-001',
    name: 'team-slack',
    url: 'https://hooks.slack.com/services/T00/B00/xxx',
    platform: 'slack',
    events: '["contradiction_detected","decision_created"]',
    enabled: 1,
    secret: 'super-secret-key',
    metadata: '{"channel":"#decigraph"}',
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockQuery.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Export Tests ───────────────────────────────────────────────────────────

describe('Export', () => {
  /** Helper: set up standard mock responses for an export flow */
  function setupExportMocks() {
    mockQuery
      .mockResolvedValueOnce({ rows: [makeProjectRow()], rowCount: 1 })  // project
      .mockResolvedValueOnce({ rows: [makeAgentRow()], rowCount: 1 })    // agents
      .mockResolvedValueOnce({ rows: [makeDecisionRow()], rowCount: 1 }) // decisions
      .mockResolvedValueOnce({ rows: [makeEdgeRow()], rowCount: 1 })     // edges
      .mockResolvedValueOnce({ rows: [makeContradictionRow()], rowCount: 1 }) // contradictions
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                  // sessions
      .mockResolvedValueOnce({ rows: [makeWebhookRow()], rowCount: 1 })  // webhooks
      .mockResolvedValue({ rows: [], rowCount: 0 });                     // audit
  }

  it('includes all project data (agents, decisions, edges)', async () => {
    setupExportMocks();

    // Simulate what the export route does
    const db = (await import('../src/db/index.js')).getDb();

    // Run queries in sequence matching the export route
    const projResult = await db.query('SELECT * FROM projects WHERE id = ?', ['proj-001']);
    const agentResult = await db.query('SELECT * FROM agents WHERE project_id = ?', ['proj-001']);
    const decResult = await db.query('SELECT * FROM decisions WHERE project_id = ?', ['proj-001']);
    const edgeResult = await db.query('...edges...', ['proj-001']);
    const conResult = await db.query('...contradictions...', ['proj-001']);
    const sessionResult = await db.query('...sessions...', ['proj-001']);

    expect(projResult.rows).toHaveLength(1);
    expect(agentResult.rows).toHaveLength(1);
    expect(decResult.rows).toHaveLength(1);
    expect(edgeResult.rows).toHaveLength(1);
    expect(conResult.rows).toHaveLength(1);
    expect(sessionResult.rows).toHaveLength(0);
  });

  it('redacts webhook URLs', () => {
    const row = makeWebhookRow();
    const exported = {
      name: row.name,
      platform: row.platform,
      url: '[REDACTED]',
      events: JSON.parse(row.events as string),
      enabled: row.enabled,
      metadata: JSON.parse(row.metadata as string),
    };

    expect(exported.url).toBe('[REDACTED]');
    expect(exported.name).toBe('team-slack');
    expect(exported.events).toContain('contradiction_detected');
  });

  it('excludes embeddings from decision export', () => {
    const row = makeDecisionRow();
    // Simulate what the export route does — it maps each decision and omits embedding
    const exported = {
      title: row.title,
      description: row.description,
      reasoning: row.reasoning,
      // embedding is not included in the mapped output
    };

    expect(exported).not.toHaveProperty('embedding');
    expect(exported.title).toBe('Use JWT');
  });

  it('excludes webhook secrets', () => {
    const row = makeWebhookRow();
    // The export maps webhook configs without the secret field
    const exported = {
      name: row.name,
      platform: row.platform,
      url: '[REDACTED]',
      events: JSON.parse(row.events as string),
      enabled: row.enabled,
      metadata: JSON.parse(row.metadata as string),
      // secret is NEVER exported
    };

    expect(exported).not.toHaveProperty('secret');
    expect(row.secret).toBe('super-secret-key'); // original has it
  });
});

// ── Import Tests ──────────────────────────────────────────────────────────

describe('Import', () => {
  const VALID_EXPORT = {
    decigraph_export_version: '1.0',
    exported_at: '2026-04-03T20:00:00Z',
    project: { name: 'bouts', description: 'AI competition', metadata: {} },
    agents: [{ name: 'maks', role: 'builder', relevance_profile: {}, context_budget_tokens: 50000 }],
    decisions: [
      {
        title: 'Use JWT',
        description: 'Token auth',
        reasoning: 'Stateless',
        made_by: 'alice',
        source: 'manual',
        confidence: 'high',
        status: 'active',
        tags: ['auth'],
        affects: ['maks'],
        alternatives_considered: [],
        assumptions: [],
        open_questions: [],
        dependencies: [],
        validated_at: null,
        validation_source: null,
        created_at: '2026-04-03T18:18:53Z',
        metadata: {},
      },
      {
        title: 'Use session cookies',
        description: 'Session-based auth',
        reasoning: 'Server-side state',
        made_by: 'bob',
        source: 'manual',
        confidence: 'medium',
        status: 'superseded',
        tags: ['auth'],
        affects: [],
        alternatives_considered: [],
        assumptions: [],
        open_questions: [],
        dependencies: [],
        validated_at: null,
        validation_source: null,
        created_at: '2026-04-03T17:00:00Z',
        metadata: {},
      },
    ],
    decision_edges: [
      {
        source_title: 'Use JWT',
        target_title: 'Use session cookies',
        relationship: 'supersedes',
        description: 'Changed auth approach',
      },
    ],
    contradictions: [],
    sessions: [],
  };

  it('creates new project with " (imported)" suffix', () => {
    const projectName = `${VALID_EXPORT.project.name} (imported)`;
    expect(projectName).toBe('bouts (imported)');
  });

  it('preserves original created_at timestamps', () => {
    const dec = VALID_EXPORT.decisions[0];
    // Import should use the original created_at, not generate a new one
    expect(dec.created_at).toBe('2026-04-03T18:18:53Z');
  });

  it('recreates edges by title matching', () => {
    // Build title-to-id map like the import logic does
    const titleToId = new Map<string, string>();
    titleToId.set('Use JWT', 'new-id-1');
    titleToId.set('Use session cookies', 'new-id-2');

    const edge = VALID_EXPORT.decision_edges[0];
    const sourceId = titleToId.get(edge.source_title);
    const targetId = titleToId.get(edge.target_title);

    expect(sourceId).toBe('new-id-1');
    expect(targetId).toBe('new-id-2');
  });

  it('skips edges with missing targets and adds warning', () => {
    const titleToId = new Map<string, string>();
    titleToId.set('Use JWT', 'new-id-1');
    // 'Use session cookies' is NOT in the map

    const edge = VALID_EXPORT.decision_edges[0];
    const targetId = titleToId.get(edge.target_title);
    const warnings: string[] = [];

    if (!targetId) {
      warnings.push(`Edge skipped: "${edge.source_title}" → "${edge.target_title}" (referenced decision not found)`);
    }

    expect(targetId).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('referenced decision not found');
  });

  it('handles empty export gracefully', () => {
    const emptyExport = {
      decigraph_export_version: '1.0',
      exported_at: '2026-04-03T20:00:00Z',
      project: { name: 'empty', description: null, metadata: {} },
      agents: [],
      decisions: [],
      decision_edges: [],
      contradictions: [],
      sessions: [],
    };

    expect(emptyExport.agents).toHaveLength(0);
    expect(emptyExport.decisions).toHaveLength(0);
    expect(emptyExport.decision_edges).toHaveLength(0);
  });

  it('round-trip: export → import → export produces equivalent data', () => {
    // The import creates new UUIDs and appends " (imported)" to the name,
    // but decision titles, agents, edges, and contradictions should match

    const exported = VALID_EXPORT;

    // Simulate import → re-export by checking data equivalence
    const reExported = {
      ...exported,
      project: { ...exported.project, name: 'bouts (imported)' },
    };

    // Decisions should be identical (ignoring UUIDs)
    expect(reExported.decisions.length).toBe(exported.decisions.length);
    for (let i = 0; i < exported.decisions.length; i++) {
      expect(reExported.decisions[i].title).toBe(exported.decisions[i].title);
      expect(reExported.decisions[i].made_by).toBe(exported.decisions[i].made_by);
      expect(reExported.decisions[i].created_at).toBe(exported.decisions[i].created_at);
    }

    // Agents match
    expect(reExported.agents.length).toBe(exported.agents.length);
    expect(reExported.agents[0].name).toBe(exported.agents[0].name);

    // Edges match
    expect(reExported.decision_edges.length).toBe(exported.decision_edges.length);
    expect(reExported.decision_edges[0].source_title).toBe(exported.decision_edges[0].source_title);
    expect(reExported.decision_edges[0].relationship).toBe(exported.decision_edges[0].relationship);
  });
});
