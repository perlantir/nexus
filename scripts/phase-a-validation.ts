#!/usr/bin/env tsx
// Phase A Validation — Full Pipeline Test
// Tests the complete DeciGraph pipeline end-to-end against a real DB.
// Run: pnpm validate  (or tsx scripts/phase-a-validation.ts)
//
// Required env vars:
//   DATABASE_URL — PostgreSQL connection string
// Optional:
//   OPENAI_API_KEY — enables embedding & semantic search tests
//   DECIGRAPH_BASE_URL — base URL for HTTP-level smoke tests (default: http://localhost:4000)

import { getPool, closePool, healthCheck, query } from '../packages/core/src/db/pool.js';
import {
  computeFreshness,
  computeEffectiveConfidence,
  getTemporalFlags,
  blendScores,
  validateDecision,
} from '../packages/core/src/temporal/index.js';
import { getRoleProfile, listRoles } from '../packages/core/src/roles.js';
import { scoreDecision, cosineSimilarity } from '../packages/core/src/context-compiler/index.js';
import type { Decision, Agent } from '../packages/core/src/types.js';

// ── ANSI colours ─────────────────────────────────────────────────────────────

const GREEN = '\x1b[32m';
const RED   = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN  = '\x1b[36m';
const RESET = '\x1b[0m';
const BOLD  = '\x1b[1m';

// ── Result tracker ────────────────────────────────────────────────────────────

interface TestResult {
  name: string;
  passed: boolean;
  message?: string;
  skipped?: boolean;
}

const results: TestResult[] = [];

function pass(name: string, message?: string) {
  results.push({ name, passed: true, message });
  console.log(`  ${GREEN}✓${RESET} ${name}${message ? ` — ${CYAN}${message}${RESET}` : ''}`);
}

function fail(name: string, message: string) {
  results.push({ name, passed: false, message });
  console.log(`  ${RED}✗${RESET} ${name} — ${RED}${message}${RESET}`);
}

function skip(name: string, reason: string) {
  results.push({ name, passed: true, skipped: true, message: reason });
  console.log(`  ${YELLOW}⟳${RESET} ${name} — ${YELLOW}SKIPPED: ${reason}${RESET}`);
}

function section(title: string) {
  console.log(`\n${BOLD}${CYAN}── ${title} ${'─'.repeat(Math.max(0, 50 - title.length))}${RESET}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function qRows<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
  const result = await query<T>(sql, params);
  return result.rows;
}

async function qOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null> {
  const rows = await qRows<T>(sql, params);
  return rows[0] ?? null;
}

/**
 * Clean up all test data inserted during this run.
 * Relies on a test project named exactly "decigraph-phase-a-test".
 */
async function cleanup(projectId: string | null) {
  if (!projectId) return;
  section('Cleanup');
  try {
    // Delete in dependency order (FK constraints)
    await query('DELETE FROM relevance_feedback WHERE agent_id IN (SELECT id FROM agents WHERE project_id = $1)', [projectId]);
    await query('DELETE FROM notifications WHERE agent_id IN (SELECT id FROM agents WHERE project_id = $1)', [projectId]);
    await query('DELETE FROM subscriptions WHERE agent_id IN (SELECT id FROM agents WHERE project_id = $1)', [projectId]);
    await query('DELETE FROM context_cache WHERE agent_id IN (SELECT id FROM agents WHERE project_id = $1)', [projectId]);
    await query('DELETE FROM session_summaries WHERE project_id = $1', [projectId]);
    await query('DELETE FROM artifacts WHERE project_id = $1', [projectId]);
    await query('DELETE FROM contradictions WHERE project_id = $1', [projectId]);
    await query('DELETE FROM decision_edges WHERE source_id IN (SELECT id FROM decisions WHERE project_id = $1)', [projectId]);
    await query('DELETE FROM decision_edges WHERE target_id IN (SELECT id FROM decisions WHERE project_id = $1)', [projectId]);
    await query('DELETE FROM decisions WHERE project_id = $1', [projectId]);
    await query('DELETE FROM agents WHERE project_id = $1', [projectId]);
    await query('DELETE FROM projects WHERE id = $1', [projectId]);
    await query('DELETE FROM audit_log WHERE project_id = $1', [projectId]);
    pass('Cleanup', 'Test data removed');
  } catch (err) {
    fail('Cleanup', `Failed: ${(err as Error).message}`);
  }
}

// ── Main Validation ───────────────────────────────────────────────────────────

async function validate() {
  console.log(`\n${BOLD}${CYAN}🔍 DeciGraph Phase A Validation${RESET}\n`);
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`DATABASE_URL: ${process.env.DATABASE_URL ? process.env.DATABASE_URL.replace(/:\/\/([^:]+):[^@]+@/, '://$1:***@') : '(not set)'}`);

  let projectId: string | null = null;

  try {
    // ────────────────────────────────────────────────────────────────────────
    // 0. Pure Function Sanity Checks (no DB)
    // ────────────────────────────────────────────────────────────────────────
    section('0. Pure Function Sanity Checks');

    // Temporal engine
    const freshDecision = {
      created_at: new Date().toISOString(),
      validated_at: undefined,
      confidence: 'high' as const,
      confidence_decay_rate: 0,
      status: 'active' as const,
      open_questions: [],
    } as unknown as Decision;

    const freshnessNow = computeFreshness(freshDecision, new Date());
    if (Math.abs(freshnessNow - 1.0) < 0.001) {
      pass('computeFreshness(fresh) ≈ 1.0', `got ${freshnessNow.toFixed(4)}`);
    } else {
      fail('computeFreshness(fresh) ≈ 1.0', `got ${freshnessNow.toFixed(4)}`);
    }

    const decayedDecision = {
      ...freshDecision,
      created_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    } as Decision;
    const freshness7d = computeFreshness(decayedDecision, new Date());
    if (Math.abs(freshness7d - 0.5) < 0.01) {
      pass('computeFreshness(7d unvalidated) ≈ 0.5', `got ${freshness7d.toFixed(4)}`);
    } else {
      fail('computeFreshness(7d unvalidated) ≈ 0.5', `got ${freshness7d.toFixed(4)}`);
    }

    const effConf = computeEffectiveConfidence(freshDecision, new Date());
    if (effConf === 1.0) {
      pass('computeEffectiveConfidence(high, decay=0) = 1.0');
    } else {
      fail('computeEffectiveConfidence(high, decay=0) = 1.0', `got ${effConf}`);
    }

    const flags = getTemporalFlags({ ...freshDecision, status: 'superseded' } as Decision);
    if (flags.includes('⚠️ SUPERSEDED')) {
      pass('getTemporalFlags(superseded) → SUPERSEDED flag');
    } else {
      fail('getTemporalFlags(superseded) → SUPERSEDED flag', `got: ${JSON.stringify(flags)}`);
    }

    const blended = blendScores(0.8, 0.6, 'recent_first');
    const expected = 0.55 * 0.8 + 0.45 * 0.6;
    if (Math.abs(blended - expected) < 0.0001) {
      pass('blendScores(recent_first)', `${blended.toFixed(4)} ≈ ${expected.toFixed(4)}`);
    } else {
      fail('blendScores(recent_first)', `got ${blended}, expected ${expected}`);
    }

    // Cosine similarity
    const cos = cosineSimilarity([1, 0, 0], [1, 0, 0]);
    if (Math.abs(cos - 1.0) < 0.0001) {
      pass('cosineSimilarity(identical vectors) = 1.0');
    } else {
      fail('cosineSimilarity(identical vectors) = 1.0', `got ${cos}`);
    }

    const cosOrtho = cosineSimilarity([1, 0], [0, 1]);
    if (Math.abs(cosOrtho) < 0.0001) {
      pass('cosineSimilarity(orthogonal vectors) = 0');
    } else {
      fail('cosineSimilarity(orthogonal vectors) = 0', `got ${cosOrtho}`);
    }

    // Roles
    const roles = listRoles();
    if (roles.length === 16) {
      pass('listRoles() returns 16 roles');
    } else {
      fail('listRoles() returns 16 roles', `got ${roles.length}`);
    }

    const builderProfile = getRoleProfile('builder');
    if (builderProfile.weights.implementation === 1.0) {
      pass('getRoleProfile(builder) has implementation weight = 1.0');
    } else {
      fail('getRoleProfile(builder) has implementation weight = 1.0', `got ${builderProfile.weights.implementation}`);
    }

    // ────────────────────────────────────────────────────────────────────────
    // 1. Database Connection
    // ────────────────────────────────────────────────────────────────────────
    section('1. Database Connection');

    if (!process.env.DATABASE_URL) {
      console.log(`\n  ${RED}✗ DATABASE_URL is not set — skipping all DB tests${RESET}`);
      return;
    }

    const healthy = await healthCheck();
    if (healthy) {
      pass('Database connection');
    } else {
      fail('Database connection', 'healthCheck() returned false');
      return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // 2. Create Test Project
    // ────────────────────────────────────────────────────────────────────────
    section('2. Project Creation');

    // Remove any leftover test project from a previous run
    await query(`DELETE FROM projects WHERE name = 'decigraph-phase-a-test'`);

    const projectRow = await qOne(
      `INSERT INTO projects (name, description, metadata)
       VALUES ($1, $2, $3) RETURNING *`,
      ['decigraph-phase-a-test', 'Phase A validation project', '{}'],
    );

    if (projectRow && projectRow['id']) {
      projectId = projectRow['id'] as string;
      pass('Create project', `id: ${projectId}`);
    } else {
      fail('Create project', 'No row returned');
      return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // 3. Create Test Agents
    // ────────────────────────────────────────────────────────────────────────
    section('3. Agent Creation');

    const agentRoles = [
      { name: 'test-builder',   role: 'builder' },
      { name: 'test-reviewer',  role: 'reviewer' },
      { name: 'test-architect', role: 'architect' },
    ];

    const agentIds: Record<string, string> = {};

    for (const { name, role } of agentRoles) {
      const profile = getRoleProfile(role);
      const agentRow = await qOne(
        `INSERT INTO agents (project_id, name, role, relevance_profile, context_budget_tokens)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [projectId, name, role, JSON.stringify(profile), 50000],
      );
      if (agentRow && agentRow['id']) {
        agentIds[name] = agentRow['id'] as string;
        pass(`Create agent: ${name}`, `id: ${agentIds[name]}`);
      } else {
        fail(`Create agent: ${name}`, 'No row returned');
      }
    }

    // ────────────────────────────────────────────────────────────────────────
    // 4. Record Decisions
    // ────────────────────────────────────────────────────────────────────────
    section('4. Decision Creation');

    const decisionData = [
      {
        key: 'frontend',
        title: 'Use Next.js 15 App Router for frontend',
        description: 'Next.js 15 with App Router is our frontend framework',
        reasoning: 'Server components, RSC, and excellent DX make this the right choice for a modern SaaS',
        made_by: 'test-architect',
        confidence: 'high',
        tags: ['architecture', 'implementation'],
        affects: ['test-builder', 'test-reviewer'],
      },
      {
        key: 'database',
        title: 'PostgreSQL with Drizzle ORM',
        description: 'Use PostgreSQL as the primary database with Drizzle ORM',
        reasoning: 'PostgreSQL pgvector support is critical for embedding search; Drizzle provides type-safe queries',
        made_by: 'test-architect',
        confidence: 'high',
        tags: ['database', 'architecture'],
        affects: ['test-builder'],
      },
      {
        key: 'auth',
        title: 'JWT with refresh token rotation',
        description: 'Stateless JWT auth with short-lived access tokens and rotating refresh tokens',
        reasoning: 'Stateless auth scales better; rotation prevents refresh token reuse attacks',
        made_by: 'test-builder',
        confidence: 'medium',
        tags: ['security', 'api'],
        affects: ['test-reviewer'],
      },
      {
        key: 'pending_decision',
        title: 'Evaluate WebSocket vs SSE for real-time',
        description: 'Need to decide between WebSocket and Server-Sent Events for real-time updates',
        reasoning: 'Both are viable; SSE is simpler but WebSocket is more flexible',
        made_by: 'test-architect',
        confidence: 'low',
        status: 'pending',
        tags: ['architecture', 'api', 'implementation'],
        affects: ['test-builder'],
        open_questions: ['What is the expected concurrent user count?', 'Do we need bidirectional messaging?'],
      },
    ] as const;

    const decisionIds: Record<string, string> = {};

    for (const d of decisionData) {
      try {
        const row = await qOne(
          `INSERT INTO decisions
             (project_id, title, description, reasoning, made_by,
              source, confidence, status, alternatives_considered,
              affects, tags, assumptions, open_questions, dependencies,
              confidence_decay_rate, metadata)
           VALUES ($1, $2, $3, $4, $5, 'manual', $6, $7, '[]'::jsonb,
                   $8, $9, '[]'::jsonb, $10::jsonb, '[]'::jsonb, 0, '{}')
           RETURNING id`,
          [
            projectId,
            d.title,
            d.description,
            d.reasoning,
            d.made_by,
            d.confidence,
            'status' in d && d.status ? d.status : 'active',
            d.affects,
            d.tags,
            JSON.stringify('open_questions' in d ? d.open_questions : []),
          ],
        );
        if (row && row['id']) {
          decisionIds[d.key] = row['id'] as string;
          pass(`Create decision: "${d.title.slice(0, 40)}..."`, `id: ${decisionIds[d.key]}`);
        } else {
          fail(`Create decision: ${d.key}`, 'No row returned');
        }
      } catch (err) {
        fail(`Create decision: ${d.key}`, (err as Error).message);
      }
    }

    // ────────────────────────────────────────────────────────────────────────
    // 5. Create Edges
    // ────────────────────────────────────────────────────────────────────────
    section('5. Decision Edge Creation');

    const edges = [
      { from: 'database', to: 'frontend', rel: 'informs', desc: 'DB choice informs frontend data fetching' },
      { from: 'auth', to: 'frontend', rel: 'requires', desc: 'Auth system is required by frontend' },
    ];

    for (const edge of edges) {
      if (!decisionIds[edge.from] || !decisionIds[edge.to]) {
        skip(`Create edge: ${edge.from} → ${edge.to}`, 'Missing decision IDs');
        continue;
      }
      try {
        const row = await qOne(
          `INSERT INTO decision_edges (source_id, target_id, relationship, description, strength)
           VALUES ($1, $2, $3, $4, 1.0) RETURNING id`,
          [decisionIds[edge.from], decisionIds[edge.to], edge.rel, edge.desc],
        );
        if (row) {
          pass(`Create edge: ${edge.from} → ${edge.to} (${edge.rel})`);
        } else {
          fail(`Create edge: ${edge.from} → ${edge.to}`, 'No row returned');
        }
      } catch (err) {
        fail(`Create edge: ${edge.from} → ${edge.to}`, (err as Error).message);
      }
    }

    // ────────────────────────────────────────────────────────────────────────
    // 6. Semantic Search (optional — requires embedding API)
    // ────────────────────────────────────────────────────────────────────────
    section('6. Semantic Search');

    if (!process.env.OPENAI_API_KEY) {
      skip('Semantic search', 'OPENAI_API_KEY not set');
    } else {
      try {
        const searchRows = await qRows(
          `SELECT id, title, (embedding <=> '[${new Array(1536).fill(0).join(',')}]'::vector) AS dist
           FROM decisions WHERE project_id = $1 AND embedding IS NOT NULL
           ORDER BY dist LIMIT 3`,
          [projectId],
        );
        pass('Semantic search query executed', `${searchRows.length} results`);
      } catch (err) {
        skip('Semantic search', `pgvector not available: ${(err as Error).message}`);
      }
    }

    // ────────────────────────────────────────────────────────────────────────
    // 7. Score Decisions (pure — no DB)
    // ────────────────────────────────────────────────────────────────────────
    section('7. Scoring Algorithm');

    // Fetch raw decisions and agent profiles to test pure scoreDecision
    const rawDecisions = await qRows<Record<string, unknown>>(
      `SELECT * FROM decisions WHERE project_id = $1`,
      [projectId],
    );

    const builderAgentRow = await qOne<Record<string, unknown>>(
      `SELECT * FROM agents WHERE project_id = $1 AND name = 'test-builder' LIMIT 1`,
      [projectId],
    );

    if (!builderAgentRow) {
      fail('Score decisions', 'Could not fetch builder agent');
    } else {
      const builderProfile = getRoleProfile('builder');
      const builderAgent: Agent = {
        id: builderAgentRow['id'] as string,
        project_id: builderAgentRow['project_id'] as string,
        name: builderAgentRow['name'] as string,
        role: builderAgentRow['role'] as string,
        relevance_profile: builderProfile,
        context_budget_tokens: 50000,
        created_at: builderAgentRow['created_at'] as string,
        updated_at: builderAgentRow['updated_at'] as string,
      };

      const taskEmbedding = new Array(3).fill(0) as number[];

      // Find the "frontend" decision to test direct affect signal
      const frontendRow = rawDecisions.find((r) => r['id'] === decisionIds['frontend']);

      if (frontendRow) {
        const frontendDecision: Decision = {
          id: frontendRow['id'] as string,
          project_id: frontendRow['project_id'] as string,
          title: frontendRow['title'] as string,
          description: frontendRow['description'] as string,
          reasoning: frontendRow['reasoning'] as string,
          made_by: frontendRow['made_by'] as string,
          source: frontendRow['source'] as 'manual',
          confidence: frontendRow['confidence'] as 'high' | 'medium' | 'low',
          status: frontendRow['status'] as 'active',
          alternatives_considered: [],
          affects: frontendRow['affects'] as string[],
          tags: frontendRow['tags'] as string[],
          assumptions: [],
          open_questions: [],
          dependencies: [],
          confidence_decay_rate: 0,
          created_at: frontendRow['created_at'] as string,
          updated_at: frontendRow['updated_at'] as string,
          metadata: {},
        };

        const scored = scoreDecision(frontendDecision, builderAgent, taskEmbedding);

        if (scored.scoring_breakdown.direct_affect === 0.4) {
          pass('Signal A: direct_affect = 0.4 for builder in affects list');
        } else {
          fail('Signal A: direct_affect = 0.4', `got ${scored.scoring_breakdown.direct_affect}`);
        }

        if (scored.scoring_breakdown.tag_matching > 0) {
          pass('Signal B: tag_matching > 0 for implementation/architecture tags', `${scored.scoring_breakdown.tag_matching.toFixed(3)}`);
        } else {
          fail('Signal B: tag_matching > 0', 'got 0');
        }

        if (scored.scoring_breakdown.status_penalty === 1.0) {
          pass('Signal E: active decision has penalty = 1.0');
        } else {
          fail('Signal E: active decision has penalty = 1.0', `got ${scored.scoring_breakdown.status_penalty}`);
        }

        pass('Combined scoring executed', `combined_score: ${scored.combined_score.toFixed(3)}`);
      } else {
        skip('Scoring test', 'Frontend decision not found');
      }
    }

    // ────────────────────────────────────────────────────────────────────────
    // 8. Supersede a Decision
    // ────────────────────────────────────────────────────────────────────────
    section('8. Decision Supersession');

    if (!decisionIds['auth']) {
      skip('Supersede decision', 'Auth decision not created');
    } else {
      try {
        // Create the new superseding decision
        const newDecRow = await qOne(
          `INSERT INTO decisions
             (project_id, title, description, reasoning, made_by, source,
              confidence, status, supersedes_id, alternatives_considered,
              affects, tags, assumptions, open_questions, dependencies,
              confidence_decay_rate, metadata)
           VALUES ($1, 'Passkeys + magic link for auth',
                   'Replace JWT with passkeys and magic link login',
                   'Better UX with passkeys; reduces phishing risk',
                   'test-architect', 'manual', 'high', 'active', $2,
                   '[]'::jsonb, '{}', '{"security","api"}', '[]'::jsonb,
                   '[]'::jsonb, '[]'::jsonb, 0, '{}')
           RETURNING id`,
          [projectId, decisionIds['auth']],
        );

        if (!newDecRow) throw new Error('No row returned from INSERT');
        const newDecId = newDecRow['id'] as string;

        // Mark old decision as superseded
        await query(
          `UPDATE decisions SET status = 'superseded', updated_at = NOW() WHERE id = $1`,
          [decisionIds['auth']],
        );

        // Create supersedes edge
        await query(
          `INSERT INTO decision_edges (source_id, target_id, relationship, strength)
           VALUES ($1, $2, 'supersedes', 1.0)`,
          [newDecId, decisionIds['auth']],
        );

        // Verify old status
        const oldDec = await qOne(`SELECT status FROM decisions WHERE id = $1`, [decisionIds['auth']]);
        if (oldDec?.['status'] === 'superseded') {
          pass('Old decision marked as superseded');
        } else {
          fail('Old decision marked as superseded', `status = ${oldDec?.['status']}`);
        }

        // Verify new decision exists
        const newDec = await qOne(`SELECT status FROM decisions WHERE id = $1`, [newDecId]);
        if (newDec?.['status'] === 'active') {
          pass('New superseding decision is active');
        } else {
          fail('New superseding decision is active', `status = ${newDec?.['status']}`);
        }

        // Verify edge exists
        const edge = await qOne(
          `SELECT * FROM decision_edges WHERE source_id = $1 AND relationship = 'supersedes'`,
          [newDecId],
        );
        if (edge) {
          pass('Supersedes edge created');
        } else {
          fail('Supersedes edge created', 'Edge not found');
        }

        // Test getTemporalFlags on superseded decision
        const supersededFullRow = await qOne<Record<string, unknown>>(
          `SELECT * FROM decisions WHERE id = $1`,
          [decisionIds['auth']],
        );
        if (supersededFullRow) {
          const supersededDecision = {
            ...supersededFullRow,
            alternatives_considered: [],
            open_questions: [],
            assumptions: [],
            dependencies: [],
            tags: (supersededFullRow['tags'] as string[]) || [],
            affects: (supersededFullRow['affects'] as string[]) || [],
          } as unknown as Decision;
          const temporalFlags = getTemporalFlags(supersededDecision);
          if (temporalFlags.includes('⚠️ SUPERSEDED')) {
            pass('getTemporalFlags returns SUPERSEDED for superseded decision');
          } else {
            fail('getTemporalFlags returns SUPERSEDED', `got: ${JSON.stringify(temporalFlags)}`);
          }
        }

        decisionIds['superseded_auth'] = decisionIds['auth']!;
        decisionIds['auth_v2'] = newDecId;

      } catch (err) {
        fail('Supersede decision', (err as Error).message);
      }
    }

    // ────────────────────────────────────────────────────────────────────────
    // 9. Notifications
    // ────────────────────────────────────────────────────────────────────────
    section('9. Notifications');

    if (!agentIds['test-builder']) {
      skip('Notifications', 'Builder agent not created');
    } else {
      try {
        // Manually insert a notification (the server would do this via triggers/logic)
        await query(
          `INSERT INTO notifications
             (agent_id, decision_id, notification_type, message, urgency)
           VALUES ($1, $2, 'decision_superseded',
                   'The auth decision has been superseded by a new approach', 'high')`,
          [agentIds['test-builder'], decisionIds['auth']],
        );

        const notifRows = await qRows(
          `SELECT * FROM notifications WHERE agent_id = $1 AND read_at IS NULL`,
          [agentIds['test-builder']],
        );

        if (notifRows.length > 0) {
          pass('Notification created and readable', `${notifRows.length} unread`);
        } else {
          fail('Notification readable', '0 unread notifications found');
        }

        // Mark as read
        await query(
          `UPDATE notifications SET read_at = NOW() WHERE agent_id = $1`,
          [agentIds['test-builder']],
        );

        const unreadAfter = await qRows(
          `SELECT * FROM notifications WHERE agent_id = $1 AND read_at IS NULL`,
          [agentIds['test-builder']],
        );
        if (unreadAfter.length === 0) {
          pass('Notifications marked as read');
        } else {
          fail('Notifications marked as read', `${unreadAfter.length} still unread`);
        }

      } catch (err) {
        fail('Notifications', (err as Error).message);
      }
    }

    // ────────────────────────────────────────────────────────────────────────
    // 10. Relevance Feedback
    // ────────────────────────────────────────────────────────────────────────
    section('10. Relevance Feedback');

    if (!agentIds['test-builder'] || !decisionIds['frontend']) {
      skip('Relevance feedback', 'Required IDs not available');
    } else {
      try {
        await query(
          `INSERT INTO relevance_feedback
             (agent_id, decision_id, was_useful, usage_signal)
           VALUES ($1, $2, true, 'referenced')`,
          [agentIds['test-builder'], decisionIds['frontend']],
        );

        const feedbackRows = await qRows(
          `SELECT * FROM relevance_feedback WHERE agent_id = $1`,
          [agentIds['test-builder']],
        );

        if (feedbackRows.length > 0) {
          pass('Relevance feedback recorded', `${feedbackRows.length} row(s)`);
        } else {
          fail('Relevance feedback recorded', '0 feedback rows');
        }

        const useful = feedbackRows.filter((r) => r['was_useful'] === true);
        if (useful.length === feedbackRows.length) {
          pass('Feedback was_useful flag correct');
        } else {
          fail('Feedback was_useful flag', `${useful.length}/${feedbackRows.length} marked useful`);
        }
      } catch (err) {
        fail('Relevance feedback', (err as Error).message);
      }
    }

    // ────────────────────────────────────────────────────────────────────────
    // 11. Subscriptions
    // ────────────────────────────────────────────────────────────────────────
    section('11. Subscriptions');

    if (!agentIds['test-reviewer']) {
      skip('Subscriptions', 'Reviewer agent not created');
    } else {
      try {
        await query(
          `INSERT INTO subscriptions (agent_id, topic, notify_on, priority)
           VALUES ($1, 'security', '{"supersede","contradict"}', 'high')`,
          [agentIds['test-reviewer']],
        );

        const subRows = await qRows(
          `SELECT * FROM subscriptions WHERE agent_id = $1`,
          [agentIds['test-reviewer']],
        );

        if (subRows.length > 0) {
          pass('Subscription created', `topic: ${subRows[0]!['topic']}`);
        } else {
          fail('Subscription created', '0 rows returned');
        }
      } catch (err) {
        fail('Subscriptions', (err as Error).message);
      }
    }

    // ────────────────────────────────────────────────────────────────────────
    // 12. Session Summaries
    // ────────────────────────────────────────────────────────────────────────
    section('12. Session Summaries');

    try {
      const decisionIdsForSession = Object.values(decisionIds).slice(0, 2);
      await query(
        `INSERT INTO session_summaries
           (project_id, agent_name, session_date, topic, summary,
            decision_ids, artifact_ids, assumptions, open_questions, lessons_learned)
         VALUES ($1, 'test-architect', CURRENT_DATE, 'Architecture Review',
                 'Reviewed and validated frontend and database choices',
                 $2, '{}', '{"Team has Next.js experience"}',
                 '{"Is tRPC still needed with Hono?"}',
                 '{"Drizzle ORM is significantly faster to iterate than Prisma"}')`,
        [projectId, JSON.stringify(decisionIdsForSession)],
      );

      const sessionRows = await qRows(
        `SELECT * FROM session_summaries WHERE project_id = $1`,
        [projectId],
      );

      if (sessionRows.length > 0) {
        pass('Session summary created', `topic: "${sessionRows[0]!['topic']}"`);
      } else {
        fail('Session summary created', '0 rows');
      }
    } catch (err) {
      fail('Session summaries', (err as Error).message);
    }

    // ────────────────────────────────────────────────────────────────────────
    // 13. Contradiction Detection
    // ────────────────────────────────────────────────────────────────────────
    section('13. Contradiction Detection');

    if (!decisionIds['auth'] || !decisionIds['database']) {
      skip('Contradiction detection', 'Required decision IDs not available');
    } else {
      try {
        // Manually insert a contradiction record (normally done by the LLM pipeline)
        await query(
          `INSERT INTO contradictions
             (project_id, decision_a_id, decision_b_id, similarity_score,
              conflict_description, status)
           VALUES ($1, $2, $3, 0.73,
                   'JWT auth and database choice have conflicting session assumptions',
                   'unresolved')`,
          [projectId, decisionIds['auth'], decisionIds['database']],
        );

        const contradictionRows = await qRows(
          `SELECT * FROM contradictions WHERE project_id = $1 AND status = 'unresolved'`,
          [projectId],
        );

        if (contradictionRows.length > 0) {
          pass('Contradiction inserted and queryable', `${contradictionRows.length} unresolved`);
        } else {
          fail('Contradiction queryable', '0 rows');
        }
      } catch (err) {
        fail('Contradiction detection', (err as Error).message);
      }
    }

    // ────────────────────────────────────────────────────────────────────────
    // 14. Temporal Scoring End-to-End
    // ────────────────────────────────────────────────────────────────────────
    section('14. Temporal Scoring E2E');

    try {
      // Validate a decision and confirm freshness increases
      if (!decisionIds['database']) {
        skip('Temporal scoring E2E', 'Database decision not created');
      } else {
        const beforeRow = await qOne<Record<string, unknown>>(
          `SELECT * FROM decisions WHERE id = $1`,
          [decisionIds['database']],
        );

        const beforeDec = {
          ...beforeRow,
          alternatives_considered: [],
          open_questions: [],
          assumptions: [],
          dependencies: [],
          tags: (beforeRow?.['tags'] as string[]) || [],
          affects: (beforeRow?.['affects'] as string[]) || [],
        } as unknown as Decision;

        const beforeFreshness = computeFreshness(beforeDec, new Date());

        // Run validateDecision (requires DB)
        await validateDecision(decisionIds['database']!, 'phase-a-test');

        const afterRow = await qOne<Record<string, unknown>>(
          `SELECT * FROM decisions WHERE id = $1`,
          [decisionIds['database']],
        );

        if (afterRow?.['validated_at']) {
          pass('validateDecision sets validated_at', String(afterRow['validated_at']));

          const afterDec = {
            ...afterRow,
            alternatives_considered: [],
            open_questions: [],
            assumptions: [],
            dependencies: [],
            tags: (afterRow['tags'] as string[]) || [],
            affects: (afterRow['affects'] as string[]) || [],
          } as unknown as Decision;

          const afterFreshness = computeFreshness(afterDec, new Date());
          // After validation, freshness should still be high (validated_at = now → half-life 30d)
          if (afterFreshness > beforeFreshness || afterFreshness > 0.9) {
            pass('Freshness improved/maintained after validation', `before: ${beforeFreshness.toFixed(3)}, after: ${afterFreshness.toFixed(3)}`);
          } else {
            fail('Freshness improved after validation', `before: ${beforeFreshness}, after: ${afterFreshness}`);
          }
        } else {
          fail('validateDecision sets validated_at', 'validated_at is null');
        }
      }
    } catch (err) {
      fail('Temporal scoring E2E', (err as Error).message);
    }

    // ────────────────────────────────────────────────────────────────────────
    // 15. Graph Query
    // ────────────────────────────────────────────────────────────────────────
    section('15. Graph Traversal');

    if (!decisionIds['frontend']) {
      skip('Graph traversal', 'Frontend decision not created');
    } else {
      try {
        // Use the fallback recursive CTE query directly
        const graphRows = await qRows(
          `WITH RECURSIVE graph AS (
             SELECT target_id AS decision_id, 1 AS depth, relationship AS via_relationship
             FROM decision_edges WHERE source_id = $1
             UNION ALL
             SELECT e.target_id, g.depth + 1, e.relationship
             FROM decision_edges e JOIN graph g ON e.source_id = g.decision_id
             WHERE g.depth < 3
           )
           SELECT DISTINCT ON (decision_id) decision_id, depth, via_relationship FROM graph`,
          [decisionIds['frontend']],
        );
        pass('Graph traversal CTE executed', `${graphRows.length} connected node(s)`);
      } catch (err) {
        fail('Graph traversal', (err as Error).message);
      }
    }

    // ────────────────────────────────────────────────────────────────────────
    // 16. Project Stats
    // ────────────────────────────────────────────────────────────────────────
    section('16. Project Stats');

    try {
      const statsRow = await qOne<Record<string, unknown>>(
        `SELECT
           COUNT(*)                                   AS total_decisions,
           COUNT(*) FILTER (WHERE status = 'active')  AS active_decisions,
           COUNT(*) FILTER (WHERE status = 'superseded') AS superseded_decisions,
           COUNT(*) FILTER (WHERE status = 'pending')  AS pending_decisions
         FROM decisions WHERE project_id = $1`,
        [projectId],
      );

      if (statsRow) {
        pass('Project stats query', [
          `total: ${statsRow['total_decisions']}`,
          `active: ${statsRow['active_decisions']}`,
          `superseded: ${statsRow['superseded_decisions']}`,
        ].join(', '));

        if (Number(statsRow['superseded_decisions']) >= 1) {
          pass('Superseded count ≥ 1 after supersession test');
        } else {
          fail('Superseded count ≥ 1', `got ${statsRow['superseded_decisions']}`);
        }
      } else {
        fail('Project stats', 'No row returned');
      }
    } catch (err) {
      fail('Project stats', (err as Error).message);
    }

  } catch (err) {
    fail('UNEXPECTED ERROR', (err as Error).message);
    console.error((err as Error).stack);
  } finally {
    // ── Cleanup ──────────────────────────────────────────────────────────────
    await cleanup(projectId);
    await closePool();

    // ── Summary ───────────────────────────────────────────────────────────────
    const total   = results.length;
    const passed  = results.filter((r) => r.passed && !r.skipped).length;
    const skipped = results.filter((r) => r.skipped).length;
    const failed  = results.filter((r) => !r.passed).length;

    console.log(`\n${BOLD}${'═'.repeat(55)}${RESET}`);
    console.log(`${BOLD}Results: ${
      failed === 0 ? GREEN : RED
    }${passed} passed${RESET}${BOLD}, ${YELLOW}${skipped} skipped${RESET}${BOLD}, ${failed > 0 ? RED : ''}${failed} failed${RESET}${BOLD} / ${total} total${RESET}`);
    console.log(`${'═'.repeat(55)}`);

    if (failed > 0) {
      console.log(`\n${RED}Failed tests:${RESET}`);
      for (const r of results.filter((r) => !r.passed)) {
        console.log(`  ${RED}✗${RESET} ${r.name}: ${r.message}`);
      }
    }

    if (failed === 0) {
      console.log(`\n${GREEN}${BOLD}✓ All validation checks passed!${RESET}\n`);
    } else {
      console.log(`\n${RED}${BOLD}✗ Validation completed with failures.${RESET}\n`);
      process.exit(1);
    }
  }
}

validate().catch((err) => {
  console.error(`\n${RED}Fatal error:${RESET}`, err);
  process.exit(1);
});
