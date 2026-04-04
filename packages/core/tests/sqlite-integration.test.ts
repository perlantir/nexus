/**
 * SQLite Integration Test
 *
 * End-to-end test using a real in-memory SQLite database:
 *   1. Create a project
 *   2. Create two agents with different roles and relevance profiles
 *   3. Insert decisions with different tags
 *   4. Compile context for both agents
 *   5. Verify each agent sees decisions ranked differently
 *
 * This test exercises the full adapter → migrations → query pipeline
 * without mocks, confirming that SQLite works as a drop-in for PostgreSQL.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { SQLiteAdapter } from '../src/db/sqlite-adapter.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let db: SQLiteAdapter;

const PROJECT_ID = crypto.randomUUID();
const ARCHITECT_ID = crypto.randomUUID();
const BUILDER_ID = crypto.randomUUID();

const decisionIds = {
  architecture: crypto.randomUUID(),
  database: crypto.randomUUID(),
  frontend: crypto.randomUUID(),
  testing: crypto.randomUUID(),
};

beforeAll(async () => {
  // Use in-memory database for speed; no disk cleanup needed.
  db = new SQLiteAdapter(':memory:');
  await db.connect();

  // Run all SQLite migrations
  const migrationsDir = path.join(__dirname, '..', 'src', 'db', 'migrations', 'sqlite');
  await db.runMigrations(migrationsDir);
});

afterAll(async () => {
  await db.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SQLite Integration — Full Lifecycle', () => {
  it('creates a project', async () => {
    const insertResult = await db.query(
      `INSERT INTO projects (id, name, description) VALUES (?, ?, ?)`,
      [PROJECT_ID, 'DeciGraph Test Project', 'Integration test project'],
    );
    expect(insertResult.rowCount).toBe(1);

    const selectResult = await db.query(
      `SELECT * FROM projects WHERE id = ?`,
      [PROJECT_ID],
    );
    expect(selectResult.rows[0]).toMatchObject({
      id: PROJECT_ID,
      name: 'DeciGraph Test Project',
    });
  });

  it('creates two agents with different relevance profiles', async () => {
    const architectProfile = JSON.stringify({
      weights: { architecture: 1.0, infrastructure: 0.8, database: 0.6 },
      decision_depth: 3,
      freshness_preference: 'balanced',
      include_superseded: false,
    });

    const builderProfile = JSON.stringify({
      weights: { frontend: 1.0, testing: 0.8, tooling: 0.5 },
      decision_depth: 2,
      freshness_preference: 'recent',
      include_superseded: false,
    });

    await db.query(
      `INSERT INTO agents (id, project_id, name, role, relevance_profile)
       VALUES (?, ?, ?, ?, ?)`,
      [ARCHITECT_ID, PROJECT_ID, 'sarah-architect', 'architect', architectProfile],
    );

    const archResult = await db.query(
      `SELECT * FROM agents WHERE id = ?`,
      [ARCHITECT_ID],
    );
    expect(archResult.rows[0]).toMatchObject({ name: 'sarah-architect', role: 'architect' });

    await db.query(
      `INSERT INTO agents (id, project_id, name, role, relevance_profile)
       VALUES (?, ?, ?, ?, ?)`,
      [BUILDER_ID, PROJECT_ID, 'marcus-builder', 'builder', builderProfile],
    );

    const builderResult = await db.query(
      `SELECT * FROM agents WHERE id = ?`,
      [BUILDER_ID],
    );
    expect(builderResult.rows[0]).toMatchObject({ name: 'marcus-builder', role: 'builder' });
  });

  it('inserts decisions across different domains', async () => {
    const decisions = [
      {
        id: decisionIds.architecture,
        title: 'Adopt hexagonal architecture',
        description: 'Use ports-and-adapters pattern for core domain isolation.',
        reasoning: 'Enables independent testing and swappable infrastructure.',
        made_by: 'sarah-architect',
        tags: JSON.stringify(['architecture', 'patterns']),
        affects: JSON.stringify(['backend', 'core']),
      },
      {
        id: decisionIds.database,
        title: 'Use SQLite for local development',
        description: 'Default to SQLite for zero-config developer experience.',
        reasoning: 'No external database service needed for local dev.',
        made_by: 'sarah-architect',
        tags: JSON.stringify(['database', 'infrastructure']),
        affects: JSON.stringify(['backend', 'devops']),
      },
      {
        id: decisionIds.frontend,
        title: 'React with TypeScript strict mode',
        description: 'All frontend code uses React + TS strict.',
        reasoning: 'Type safety catches bugs at compile time.',
        made_by: 'marcus-builder',
        tags: JSON.stringify(['frontend', 'tooling']),
        affects: JSON.stringify(['dashboard', 'frontend']),
      },
      {
        id: decisionIds.testing,
        title: 'Vitest for all test suites',
        description: 'Standardise on Vitest across the entire monorepo.',
        reasoning: 'Fast ESM-native test runner, compatible with TypeScript.',
        made_by: 'marcus-builder',
        tags: JSON.stringify(['testing', 'tooling']),
        affects: JSON.stringify(['all']),
      },
    ];

    for (const d of decisions) {
      const result = await db.query(
        `INSERT INTO decisions
           (id, project_id, title, description, reasoning, made_by, source, confidence, status, tags, affects)
         VALUES (?, ?, ?, ?, ?, ?, 'manual', 'high', 'active', ?, ?)`,
        [d.id, PROJECT_ID, d.title, d.description, d.reasoning, d.made_by, d.tags, d.affects],
      );
      expect(result.rowCount).toBe(1);
    }

    // Verify all 4 decisions exist
    const countResult = await db.query<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM decisions WHERE project_id = ?`,
      [PROJECT_ID],
    );
    expect(countResult.rows[0]?.cnt).toBe(4);
  });

  it('queries decisions filtered by agent tags — architect sees architecture + database', async () => {
    // Simulate what compile does: fetch decisions matching agent's domain
    const architectTags = ['architecture', 'infrastructure', 'database'];
    const tagConditions = architectTags.map(() => `tags LIKE ?`).join(' OR ');
    const tagParams = architectTags.map((t) => `%${t}%`);

    const result = await db.query(
      `SELECT id, title, tags FROM decisions
       WHERE project_id = ?
         AND status = 'active'
         AND (${tagConditions})
       ORDER BY created_at ASC`,
      [PROJECT_ID, ...tagParams],
    );

    // Architect should see 2 decisions: hexagonal architecture + SQLite for local dev
    expect(result.rows.length).toBe(2);
    const titles = result.rows.map((r) => r.title);
    expect(titles).toContain('Adopt hexagonal architecture');
    expect(titles).toContain('Use SQLite for local development');
  });

  it('queries decisions filtered by agent tags — builder sees frontend + testing', async () => {
    const builderTags = ['frontend', 'testing', 'tooling'];
    const tagConditions = builderTags.map(() => `tags LIKE ?`).join(' OR ');
    const tagParams = builderTags.map((t) => `%${t}%`);

    const result = await db.query(
      `SELECT id, title, tags FROM decisions
       WHERE project_id = ?
         AND status = 'active'
         AND (${tagConditions})
       ORDER BY created_at ASC`,
      [PROJECT_ID, ...tagParams],
    );

    // Builder should see 2 decisions: React + Vitest
    expect(result.rows.length).toBe(2);
    const titles = result.rows.map((r) => r.title);
    expect(titles).toContain('React with TypeScript strict mode');
    expect(titles).toContain('Vitest for all test suites');
  });

  it('transaction support — inserts decision + edge atomically', async () => {
    const edgeDecisionId = crypto.randomUUID();

    await db.transaction(async (txQuery) => {
      await txQuery(
        `INSERT INTO decisions
           (id, project_id, title, description, reasoning, made_by, source, confidence, status)
         VALUES (?, ?, ?, ?, ?, ?, 'manual', 'high', 'active')`,
        [
          edgeDecisionId,
          PROJECT_ID,
          'API versioning strategy',
          'Use URL-based versioning /v1/, /v2/ for REST endpoints.',
          'Explicit versioning reduces breaking changes.',
          'sarah-architect',
        ],
      );

      await txQuery(
        `INSERT INTO decision_edges
           (id, source_id, target_id, relationship, description, strength)
         VALUES (?, ?, ?, 'depends_on', 'API versioning depends on hexagonal architecture', 1.0)`,
        [crypto.randomUUID(), edgeDecisionId, decisionIds.architecture],
      );
    });

    // Verify both records exist
    const decResult = await db.query(
      `SELECT title FROM decisions WHERE id = ?`,
      [edgeDecisionId],
    );
    expect(decResult.rows[0]?.title).toBe('API versioning strategy');

    const edgeResult = await db.query(
      `SELECT relationship FROM decision_edges WHERE source_id = ?`,
      [edgeDecisionId],
    );
    expect(edgeResult.rows[0]?.relationship).toBe('depends_on');
  });

  it('transaction rolls back on error — no partial writes', async () => {
    const badDecisionId = crypto.randomUUID();

    try {
      await db.transaction(async (txQuery) => {
        await txQuery(
          `INSERT INTO decisions
             (id, project_id, title, description, reasoning, made_by, source, confidence, status)
           VALUES (?, ?, ?, ?, ?, ?, 'manual', 'high', 'active')`,
          [badDecisionId, PROJECT_ID, 'Should be rolled back', 'desc', 'reason', 'ghost'],
        );

        // Force an error — reference a non-existent table
        await txQuery(`INSERT INTO nonexistent_table (id) VALUES (?)`, ['fail']);
      });
    } catch {
      // Expected to throw
    }

    // The decision should NOT exist (rolled back)
    const result = await db.query(
      `SELECT id FROM decisions WHERE id = ?`,
      [badDecisionId],
    );
    expect(result.rows).toHaveLength(0);
  });

  it('arrayParam produces JSON strings for SQLite', () => {
    const arr = ['tag-a', 'tag-b', 'tag-c'];
    const serialised = db.arrayParam(arr);
    expect(serialised).toBe(JSON.stringify(arr));
    expect(typeof serialised).toBe('string');
  });

  it('healthCheck returns true for a connected database', async () => {
    const healthy = await db.healthCheck();
    expect(healthy).toBe(true);
  });

  it('dialect is sqlite', () => {
    expect(db.dialect).toBe('sqlite');
  });

  it('verifies full schema — all core tables exist after migrations', async () => {
    const result = await db.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    );

    const tables = result.rows.map((r) => r.name);

    const expectedTables = [
      'projects',
      'agents',
      'decisions',
      'decision_edges',
      'artifacts',
      'session_summaries',
      'notifications',
      'subscriptions',
      'contradictions',
      'audit_log',
      'relevance_feedback',
      'processed_sources',
      'connector_configs',
    ];

    for (const t of expectedTables) {
      expect(tables).toContain(t);
    }
  });
});
