/**
 * Dependency Cascade Tests
 *
 * Tests the BFS traversal, cycle detection, depth limiting, and
 * notification logic. Uses a mock DB.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── DB Mock ───────────────────────────────────────────────────────────────

const mockQuery = vi.fn();
vi.mock('../src/db/index.js', () => ({
  getDb: () => ({
    dialect: 'sqlite',
    query: mockQuery,
    transaction: vi.fn().mockImplementation(async (fn: Function) => fn(mockQuery)),
    arrayParam: (v: unknown[]) => JSON.stringify(v),
  }),
}));

import { findCascadeImpact, notifyCascade } from '../src/dependency-cascade/index.js';
import type { CascadeResult } from '../src/dependency-cascade/index.js';

// ── Helpers ───────────────────────────────────────────────────────────────

const DEC_A = 'aaaa-aaaa-aaaa-aaaa'; // root (changed)
const DEC_B = 'bbbb-bbbb-bbbb-bbbb'; // direct dependent
const DEC_C = 'cccc-cccc-cccc-cccc'; // direct dependent
const DEC_D = 'dddd-dddd-dddd-dddd'; // transitive (depends on B)
const PROJECT = 'proj-111';

beforeEach(() => {
  mockQuery.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('findCascadeImpact', () => {
  it('finds direct dependents (depth 1)', async () => {
    // Query 1: Get changed decision title
    mockQuery.mockResolvedValueOnce({ rows: [{ title: 'Use JWT' }], rowCount: 1 });
    // Query 2: BFS depth 0 — find decisions requiring DEC_A
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: DEC_B, title: 'Store JWT secrets in Redis', affects: '["maks"]' },
        { id: DEC_C, title: 'Rate limit by JWT claims', affects: '["maks","forge"]' },
      ],
      rowCount: 2,
    });
    // Query 3: BFS depth 1 from DEC_B — no further dependents
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // Query 4: BFS depth 1 from DEC_C — no further dependents
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await findCascadeImpact(DEC_A, PROJECT);

    expect(result.total_affected).toBe(2);
    expect(result.impacts.length).toBe(2);
    expect(result.impacts[0].depth).toBe(1);
    expect(result.impacts[0].impact).toBe('direct');
    expect(result.impacts[1].depth).toBe(1);
  });

  it('finds transitive dependents (depth 2)', async () => {
    // Title lookup
    mockQuery.mockResolvedValueOnce({ rows: [{ title: 'Use JWT' }], rowCount: 1 });
    // Depth 0: B requires A
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: DEC_B, title: 'Store secrets in Redis', affects: '["maks"]' }],
      rowCount: 1,
    });
    // Depth 1: D requires B
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: DEC_D, title: 'Redis cluster sizing', affects: '["clawexpert"]' }],
      rowCount: 1,
    });
    // Depth 2: nothing requires D
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await findCascadeImpact(DEC_A, PROJECT);

    expect(result.total_affected).toBe(2);
    const direct = result.impacts.find((i) => i.depth === 1);
    const transitive = result.impacts.find((i) => i.depth === 2);
    expect(direct).toBeDefined();
    expect(direct!.impact).toBe('direct');
    expect(transitive).toBeDefined();
    expect(transitive!.impact).toBe('transitive');
    expect(transitive!.decision_title).toBe('Redis cluster sizing');
  });

  it('respects maxDepth limit', async () => {
    // Title lookup
    mockQuery.mockResolvedValueOnce({ rows: [{ title: 'Root' }], rowCount: 1 });
    // Depth 0: B requires A
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: DEC_B, title: 'Depth 1', affects: '[]' }],
      rowCount: 1,
    });
    // maxDepth=1 means we stop here — no further BFS
    // (depth 0 + 1 step = depth 1, and since maxDepth=1, we won't go deeper)

    const result = await findCascadeImpact(DEC_A, PROJECT, 1);

    expect(result.total_affected).toBe(1);
    expect(result.impacts[0].depth).toBe(1);
  });

  it('returns empty for no dependents', async () => {
    // Title lookup
    mockQuery.mockResolvedValueOnce({ rows: [{ title: 'Standalone' }], rowCount: 1 });
    // No dependents
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await findCascadeImpact(DEC_A, PROJECT);

    expect(result.total_affected).toBe(0);
    expect(result.impacts).toHaveLength(0);
  });

  it('handles cyclic graphs without infinite loop', async () => {
    // Title lookup
    mockQuery.mockResolvedValueOnce({ rows: [{ title: 'A' }], rowCount: 1 });
    // B requires A
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: DEC_B, title: 'B', affects: '[]' }],
      rowCount: 1,
    });
    // A requires B (cycle!) — but A is already visited, so should be skipped
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: DEC_A, title: 'A', affects: '[]' }], // already visited
      rowCount: 1,
    });

    const result = await findCascadeImpact(DEC_A, PROJECT);

    // Should only find B, not loop back to A
    expect(result.total_affected).toBe(1);
    expect(result.impacts[0].decision_id).toBe(DEC_B);
  });

  it('collects affected agents from impacts', async () => {
    // Title
    mockQuery.mockResolvedValueOnce({ rows: [{ title: 'Root' }], rowCount: 1 });
    // Direct dependent with multiple agents
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: DEC_B, title: 'Dep', affects: '["alice","bob","charlie"]' }],
      rowCount: 1,
    });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await findCascadeImpact(DEC_A, PROJECT);

    expect(result.impacts[0].affected_agents).toEqual(['alice', 'bob', 'charlie']);
  });
});

describe('notifyCascade', () => {
  it('creates notifications for affected agents', async () => {
    const cascade: CascadeResult = {
      changed_decision_id: DEC_A,
      changed_decision_title: 'Use JWT',
      impacts: [
        {
          decision_id: DEC_B,
          decision_title: 'Store secrets',
          depth: 1,
          path: ['Use JWT', 'Store secrets'],
          impact: 'direct',
          affected_agents: ['maks'],
        },
      ],
      total_affected: 1,
    };

    // Find agent by name
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'agent-maks' }], rowCount: 1 });
    // Insert notification
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // Find governors
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await notifyCascade(cascade, PROJECT, 'superseded');

    // Verify notification was inserted
    const insertCalls = mockQuery.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO notifications'),
    );
    expect(insertCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('notifies governors regardless of affects', async () => {
    const cascade: CascadeResult = {
      changed_decision_id: DEC_A,
      changed_decision_title: 'Use JWT',
      impacts: [
        {
          decision_id: DEC_B,
          decision_title: 'Store secrets',
          depth: 1,
          path: ['Use JWT', 'Store secrets'],
          impact: 'direct',
          affected_agents: [], // no specific agents affected
        },
      ],
      total_affected: 1,
    };

    // No agent lookups needed (empty affected_agents)
    // Find governors — returns one
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'gov-1', name: 'governor-bot' }], rowCount: 1 });
    // Insert governor notification
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await notifyCascade(cascade, PROJECT, 'superseded');

    const insertCalls = mockQuery.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO notifications'),
    );
    expect(insertCalls.length).toBe(1); // governor notification
  });
});
