#!/usr/bin/env tsx
// DeciGraph Demo Seed Script — TaskFlow AI-Powered Task Management
// Seeds the database with realistic demo data for a hypothetical
// "TaskFlow" project management SaaS.
//
// Run: pnpm db:seed  (or tsx scripts/seed-demo.ts)
//
// Required env vars:
//   DATABASE_URL — PostgreSQL connection string

import { getPool, closePool, query } from '../packages/core/src/db/pool.js';
import { getRoleProfile } from '../packages/core/src/roles.js';

// ── ANSI colours ─────────────────────────────────────────────────────────────

const GREEN  = '\x1b[32m';
const CYAN   = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';

function log(msg: string) { console.log(msg); }
function ok(msg: string) { console.log(`  ${GREEN}✓${RESET} ${msg}`); }
function info(msg: string) { console.log(`  ${DIM}${msg}${RESET}`); }

// ── Helpers ───────────────────────────────────────────────────────────────────

async function qOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T> {
  const result = await query<T>(sql, params);
  const row = result.rows[0];
  if (!row) throw new Error(`No row returned for: ${sql.slice(0, 80)}`);
  return row;
}

async function qRows<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
  const result = await query<T>(sql, params);
  return result.rows;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface Row { id: string }

interface AlternativeInput {
  option: string;
  rejected_reason: string;
}

interface DecisionInput {
  title: string;
  description: string;
  reasoning: string;
  made_by: string;
  confidence: 'high' | 'medium' | 'low';
  status?: 'active' | 'pending' | 'superseded';
  supersedes_id?: string;
  alternatives_considered?: AlternativeInput[];
  affects: string[];
  tags: string[];
  assumptions?: string[];
  open_questions?: string[];
  dependencies?: string[];
}

// ── Seed Data ─────────────────────────────────────────────────────────────────

async function seed() {
  log(`\n${BOLD}${CYAN}🌱 DeciGraph Demo Seed — TaskFlow${RESET}\n`);

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Please set it and re-run.');
    process.exit(1);
  }

  // Verify DB connectivity
  await qOne('SELECT 1 AS ok');
  ok('Database connection established');

  // ────────────────────────────────────────────────────────────────────────
  // 0. Idempotency: Remove previous demo seed if exists
  // ────────────────────────────────────────────────────────────────────────
  const existing = await qRows(
    `SELECT id FROM projects WHERE name = 'TaskFlow — AI-Powered Task Management'`,
  );
  if (existing.length > 0) {
    const existingId = existing[0]!['id'] as string;
    log(`\n${YELLOW}⚠ Removing existing TaskFlow demo seed (id: ${existingId})...${RESET}`);
    await query('DELETE FROM relevance_feedback WHERE agent_id IN (SELECT id FROM agents WHERE project_id = $1)', [existingId]);
    await query('DELETE FROM notifications WHERE agent_id IN (SELECT id FROM agents WHERE project_id = $1)', [existingId]);
    await query('DELETE FROM subscriptions WHERE agent_id IN (SELECT id FROM agents WHERE project_id = $1)', [existingId]);
    await query('DELETE FROM context_cache WHERE agent_id IN (SELECT id FROM agents WHERE project_id = $1)', [existingId]);
    await query('DELETE FROM session_summaries WHERE project_id = $1', [existingId]);
    await query('DELETE FROM artifacts WHERE project_id = $1', [existingId]);
    await query('DELETE FROM contradictions WHERE project_id = $1', [existingId]);
    await query('DELETE FROM decision_edges WHERE source_id IN (SELECT id FROM decisions WHERE project_id = $1)', [existingId]);
    await query('DELETE FROM decision_edges WHERE target_id IN (SELECT id FROM decisions WHERE project_id = $1)', [existingId]);
    await query('DELETE FROM decisions WHERE project_id = $1', [existingId]);
    await query('DELETE FROM agents WHERE project_id = $1', [existingId]);
    await query('DELETE FROM audit_log WHERE project_id = $1', [existingId]);
    await query('DELETE FROM projects WHERE id = $1', [existingId]);
    ok('Previous seed removed');
  }

  // ────────────────────────────────────────────────────────────────────────
  // 1. Create Project
  // ────────────────────────────────────────────────────────────────────────
  log(`\n${BOLD}Creating project...${RESET}`);

  const project = await qOne<Row>(
    `INSERT INTO projects (name, description, metadata)
     VALUES ($1, $2, $3) RETURNING id`,
    [
      'TaskFlow — AI-Powered Task Management',
      'A next-generation project management tool with AI-driven prioritisation, real-time collaboration, and deep integrations for async teams.',
      JSON.stringify({
        stack: ['Next.js 15', 'Hono', 'PostgreSQL', 'Redis', 'Stripe'],
        stage: 'MVP',
        target_users: 'remote engineering teams',
        demo_seed: true,
        seeded_at: new Date().toISOString(),
      }),
    ],
  );

  const projectId = project.id;
  ok(`Project: "TaskFlow — AI-Powered Task Management" (${projectId})`);

  // ────────────────────────────────────────────────────────────────────────
  // 2. Create Agents
  // ────────────────────────────────────────────────────────────────────────
  log(`\n${BOLD}Creating agents...${RESET}`);

  const agentDefs = [
    {
      name: 'sarah-architect',
      role: 'architect',
      bio: 'Sarah leads system architecture and makes foundational technology decisions.',
    },
    {
      name: 'marcus-builder',
      role: 'builder',
      bio: 'Marcus implements features and translates architecture decisions into working code.',
    },
    {
      name: 'priya-reviewer',
      role: 'reviewer',
      bio: 'Priya reviews code and architectural decisions to ensure quality and consistency.',
    },
    {
      name: 'alex-product',
      role: 'product',
      bio: 'Alex defines product requirements and prioritises features.',
    },
    {
      name: 'jordan-security',
      role: 'security',
      bio: 'Jordan is responsible for security reviews, compliance, and threat modelling.',
    },
  ];

  const agentIds: Record<string, string> = {};

  for (const agent of agentDefs) {
    const profile = getRoleProfile(agent.role);
    const row = await qOne<Row>(
      `INSERT INTO agents (project_id, name, role, relevance_profile, context_budget_tokens)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [projectId, agent.name, agent.role, JSON.stringify(profile), 50000],
    );
    agentIds[agent.name] = row.id;
    ok(`Agent: ${agent.name} (${agent.role}) — ${row.id}`);
  }

  // ────────────────────────────────────────────────────────────────────────
  // 3. Create Decisions
  // ────────────────────────────────────────────────────────────────────────
  log(`\n${BOLD}Creating decisions...${RESET}`);

  async function createDecision(projectId: string, d: DecisionInput): Promise<string> {
    const row = await qOne<Row>(
      `INSERT INTO decisions
         (project_id, title, description, reasoning, made_by, source,
          confidence, status, supersedes_id, alternatives_considered,
          affects, tags, assumptions, open_questions, dependencies,
          confidence_decay_rate, metadata)
       VALUES ($1, $2, $3, $4, $5, 'manual', $6, $7, $8,
               $9::jsonb, $10, $11, $12::jsonb, $13::jsonb, $14::jsonb, 0, '{}')
       RETURNING id`,
      [
        projectId,
        d.title,
        d.description,
        d.reasoning,
        d.made_by,
        d.confidence,
        d.status ?? 'active',
        d.supersedes_id ?? null,
        JSON.stringify(d.alternatives_considered ?? []),
        d.affects,
        d.tags,
        JSON.stringify(d.assumptions ?? []),
        JSON.stringify(d.open_questions ?? []),
        JSON.stringify(d.dependencies ?? []),
      ],
    );
    return row.id;
  }

  const decisionIds: Record<string, string> = {};

  // ── Decision 1: Next.js 15 App Router
  decisionIds.frontend = await createDecision(projectId, {
    title: 'Use Next.js 15 App Router for frontend',
    description:
      'TaskFlow will use Next.js 15 with the App Router, React Server Components, and TypeScript as the primary frontend framework.',
    reasoning:
      'Next.js 15 offers the best developer experience for a full-stack TypeScript application: RSC reduces client-side bundle size, server actions simplify data mutations, and the App Router enables granular caching strategies critical for real-time task views.',
    made_by: 'sarah-architect',
    confidence: 'high',
    alternatives_considered: [
      {
        option: 'Remix',
        rejected_reason: 'Less mature ecosystem for our use case; server actions in Next.js 15 are more ergonomic.',
      },
      {
        option: 'SvelteKit',
        rejected_reason: 'Team has stronger React expertise; switching costs outweigh DX benefits at this stage.',
      },
    ],
    affects: ['marcus-builder', 'priya-reviewer', 'alex-product'],
    tags: ['architecture', 'implementation', 'design'],
    assumptions: [
      'Team has Next.js experience',
      'Vercel/Railway deployment is the target platform',
    ],
    open_questions: [],
  });
  ok(`Decision 1: Use Next.js 15 App Router (${decisionIds.frontend})`);

  // ── Decision 2: PostgreSQL + Drizzle ORM
  decisionIds.database = await createDecision(projectId, {
    title: 'PostgreSQL with Drizzle ORM for database',
    description:
      'TaskFlow will use PostgreSQL 16 as the primary database, with Drizzle ORM for type-safe queries and pgvector for AI-powered search.',
    reasoning:
      'PostgreSQL is the gold standard for relational data with excellent JSON support. pgvector enables similarity search for AI task prioritisation. Drizzle ORM provides a thin, type-safe query layer with zero magic — unlike Prisma, it does not hide SQL complexity and is faster in production.',
    made_by: 'sarah-architect',
    confidence: 'high',
    alternatives_considered: [
      {
        option: 'Prisma + PostgreSQL',
        rejected_reason: 'Prisma migrations are complex for vector columns; generated SQL is less optimised.',
      },
      {
        option: 'PlanetScale (MySQL)',
        rejected_reason: 'No pgvector support; foreign key constraints are cumbersome.',
      },
      {
        option: 'Supabase',
        rejected_reason: 'We want control over infrastructure for compliance; self-hosting adds operational overhead.',
      },
    ],
    affects: ['marcus-builder', 'jordan-security'],
    tags: ['database', 'architecture', 'performance'],
    assumptions: [
      'We will run PostgreSQL 16+ to access pgvector',
      'Connection pooling via PgBouncer on Railway',
    ],
    open_questions: ['Should we use read replicas from the start, or add them when traffic requires?'],
  });
  ok(`Decision 2: PostgreSQL + Drizzle ORM (${decisionIds.database})`);

  // ── Decision 3: JWT with refresh token rotation
  decisionIds.jwtAuth = await createDecision(projectId, {
    title: 'JWT with refresh token rotation for auth',
    description:
      'Use stateless JWT access tokens (15 min TTL) with rotating refresh tokens (30 day TTL) stored in HTTP-only cookies. Access tokens are signed with RS256.',
    reasoning:
      'Stateless JWTs scale horizontally without shared session state. Refresh token rotation (RFC 6819) prevents replay attacks. RS256 allows public-key verification at the edge without DB lookup.',
    made_by: 'jordan-security',
    confidence: 'high',
    alternatives_considered: [
      {
        option: 'Database-backed sessions',
        rejected_reason: 'Requires shared session store (Redis) adding infra complexity; harder to scale.',
      },
      {
        option: 'Magic link only (no passwords)',
        rejected_reason: 'Some enterprise users require SSO/password login; magic links alone are insufficient.',
      },
    ],
    affects: ['marcus-builder', 'priya-reviewer', 'alex-product'],
    tags: ['security', 'api', 'implementation'],
    assumptions: [
      'All traffic is served over HTTPS',
      'Refresh tokens stored in HTTP-only, SameSite=Strict cookies',
    ],
    open_questions: ['Do we need to support device trust / remember-this-device?'],
  });
  ok(`Decision 3: JWT auth (${decisionIds.jwtAuth})`);

  // ── Decision 4: RBAC
  decisionIds.rbac = await createDecision(projectId, {
    title: 'Implement role-based access control (RBAC)',
    description:
      'TaskFlow will implement three user roles: Owner, Admin, and Member, with resource-level permission checks enforced at the API layer.',
    reasoning:
      'RBAC provides the right level of granularity for a B2B SaaS. Attribute-based access control (ABAC) is overkill for MVP. Enforcement at the API layer (not just the UI) is mandatory for security.',
    made_by: 'jordan-security',
    confidence: 'high',
    alternatives_considered: [
      {
        option: 'ABAC (attribute-based)',
        rejected_reason: 'Over-engineered for MVP; deferred to future iteration.',
      },
    ],
    affects: ['marcus-builder', 'alex-product'],
    tags: ['security', 'api', 'product'],
    assumptions: ['Organisation-level permissions are sufficient for MVP (no per-project sub-roles)'],
    open_questions: ['Will enterprise customers need custom role definitions?'],
  });
  ok(`Decision 4: RBAC (${decisionIds.rbac})`);

  // ── Decision 5: tRPC for API (SUPERSEDED by #6)
  decisionIds.trpc = await createDecision(projectId, {
    title: 'Use tRPC for API layer',
    description:
      'Use tRPC to build a fully type-safe API, sharing types between Next.js frontend and the backend without code generation.',
    reasoning:
      'End-to-end type safety eliminates a class of runtime errors. tRPC integrates natively with Next.js, enabling server actions and RSC data fetching without a separate HTTP layer.',
    made_by: 'sarah-architect',
    confidence: 'medium',
    status: 'superseded', // Will be set via supersession
    alternatives_considered: [
      { option: 'REST + OpenAPI', rejected_reason: 'Code generation overhead; less ergonomic for rapid iteration.' },
      { option: 'GraphQL', rejected_reason: 'Over-engineered for our data shapes; caching is complex.' },
    ],
    affects: ['marcus-builder'],
    tags: ['api', 'architecture', 'implementation'],
    assumptions: ['Frontend and backend share a monorepo'],
    open_questions: [],
  });
  ok(`Decision 5: tRPC (to be superseded) (${decisionIds.trpc})`);

  // ── Decision 6: Switch to REST + Hono (supersedes tRPC)
  decisionIds.honoRest = await createDecision(projectId, {
    title: 'Switch to REST with Hono for API',
    description:
      'Replace tRPC with a REST API built on Hono — a lightweight, edge-compatible web framework. Hono runs natively on Cloudflare Workers, Railway, and Deno Deploy.',
    reasoning:
      'After prototyping, tRPC proved difficult to integrate with third-party clients (mobile app, Zapier webhooks). REST with Hono provides a standard interface consumable by any HTTP client, while Hono\'s middleware system offers better observability hooks. Performance benchmarks show Hono is 3x faster than Express for our use case.',
    made_by: 'sarah-architect',
    confidence: 'high',
    supersedes_id: decisionIds.trpc,
    alternatives_considered: [
      {
        option: 'Fastify',
        rejected_reason: 'Heavier runtime; plugin system is complex; no edge runtime support.',
      },
      {
        option: 'Express',
        rejected_reason: 'Outdated middleware model; no TypeScript-first design; slow.',
      },
    ],
    affects: ['marcus-builder', 'priya-reviewer'],
    tags: ['api', 'architecture', 'implementation', 'performance'],
    assumptions: ['OpenAPI spec will be generated from Hono route definitions via @hono/zod-openapi'],
    open_questions: ['Should we version the API (v1, v2) from the start or defer?'],
  });
  ok(`Decision 6: REST + Hono (supersedes tRPC) (${decisionIds.honoRest})`);

  // Mark Decision 5 as superseded now that Decision 6 exists
  await query(
    `UPDATE decisions SET status = 'superseded', updated_at = NOW() WHERE id = $1`,
    [decisionIds.trpc],
  );

  // ── Decision 7: Tailwind + shadcn/ui
  decisionIds.ui = await createDecision(projectId, {
    title: 'Tailwind CSS + shadcn/ui for component library',
    description:
      'Use Tailwind CSS as the styling system and shadcn/ui (Radix UI primitives + Tailwind) for the component library, with a custom design token layer.',
    reasoning:
      'Tailwind eliminates dead CSS by default. shadcn/ui provides accessible, headless primitives without the opinionated styles of a full design system. We own our components — they live in our repo, not a node_modules blackbox.',
    made_by: 'marcus-builder',
    confidence: 'high',
    alternatives_considered: [
      { option: 'Chakra UI', rejected_reason: 'Large bundle size; emotion dependency; harder to customise.' },
      { option: 'MUI (Material UI)', rejected_reason: 'Material Design aesthetic does not match TaskFlow brand.' },
    ],
    affects: ['alex-product', 'priya-reviewer'],
    tags: ['design', 'implementation', 'architecture'],
    assumptions: ['Designer will use Tailwind tokens in Figma via the Figma Tailwind plugin'],
    open_questions: [],
  });
  ok(`Decision 7: Tailwind + shadcn/ui (${decisionIds.ui})`);

  // ── Decision 8: WebSocket for real-time
  decisionIds.websocket = await createDecision(projectId, {
    title: 'WebSocket for real-time task updates',
    description:
      'Use native WebSocket (via Hono\'s WebSocket upgrade) for real-time task status updates, presence indicators, and collaborative editing.',
    reasoning:
      'WebSocket provides bidirectional communication required for collaborative editing. SSE is simpler but unidirectional. Railway supports persistent WebSocket connections natively.',
    made_by: 'marcus-builder',
    confidence: 'medium',
    alternatives_considered: [
      {
        option: 'Server-Sent Events (SSE)',
        rejected_reason: 'Unidirectional — cannot send client events without a separate HTTP call.',
      },
      {
        option: 'Polling',
        rejected_reason: 'Wasteful bandwidth; unacceptable latency for real-time collaboration.',
      },
    ],
    affects: ['marcus-builder', 'jordan-security'],
    tags: ['implementation', 'api', 'performance', 'architecture'],
    assumptions: [
      'Concurrent WebSocket connections will be < 10,000 in MVP',
      'Redis pub/sub used to fan out messages across server instances',
    ],
    open_questions: [
      'Should we use a managed service (Pusher/Ably) for WebSocket in MVP to reduce ops burden?',
    ],
  });
  ok(`Decision 8: WebSocket real-time (${decisionIds.websocket})`);

  // ── Decision 9: Task Dependency Graph
  decisionIds.taskGraph = await createDecision(projectId, {
    title: 'Implement task dependency graph',
    description:
      'TaskFlow tasks can declare dependencies on other tasks, forming a directed acyclic graph (DAG). The UI renders a Gantt-style view of the dependency chain.',
    reasoning:
      'Engineering teams need to visualise blockers and critical paths. A DAG model is more expressive than simple parent/child relationships. PostgreSQL\'s recursive CTE support makes traversal queries efficient.',
    made_by: 'alex-product',
    confidence: 'high',
    alternatives_considered: [
      {
        option: 'Simple parent/child hierarchy',
        rejected_reason: 'Cannot express cross-milestone dependencies; too limiting for engineering workflows.',
      },
    ],
    affects: ['marcus-builder', 'priya-reviewer'],
    tags: ['product', 'database', 'implementation'],
    assumptions: [
      'Cycles are detected and rejected at the API layer',
      'DAG depth is limited to 10 levels for performance',
    ],
    open_questions: ['Should we support task parallelism signals (AND/OR conditions)?'],
  });
  ok(`Decision 9: Task dependency graph (${decisionIds.taskGraph})`);

  // ── Decision 10: Redis for caching
  decisionIds.redis = await createDecision(projectId, {
    title: 'Use Redis for caching and rate limiting',
    description:
      'Redis (via Upstash on Railway) serves as the cache layer for hot-path API responses, session invalidation lists, and rate limiting counters.',
    reasoning:
      'Redis sub-millisecond reads are essential for rate limiting at scale. The invalidation list (for JWT revocation before refresh token expiry) requires fast O(1) lookups. Caching computed task views reduces PostgreSQL load.',
    made_by: 'sarah-architect',
    confidence: 'high',
    alternatives_considered: [
      { option: 'In-memory cache (per server)', rejected_reason: 'Does not work across multiple server instances.' },
      { option: 'Memcached', rejected_reason: 'No pub/sub for WebSocket fanout; weaker data structures.' },
    ],
    affects: ['marcus-builder', 'jordan-security'],
    tags: ['infrastructure', 'performance', 'security', 'database'],
    assumptions: [
      'Upstash Redis on Railway (managed, auto-scaling)',
      'Cache TTL for task views: 30s',
      'JWT invalidation list TTL: 1h (matches access token lifetime)',
    ],
    open_questions: [],
  });
  ok(`Decision 10: Redis caching (${decisionIds.redis})`);

  // ── Decision 11: Audit Logging
  decisionIds.auditLog = await createDecision(projectId, {
    title: 'Implement audit logging for compliance',
    description:
      'All state-changing API actions (task mutations, member role changes, billing events) are written to an immutable audit log table with actor, timestamp, and diff.',
    reasoning:
      'SOC 2 Type II compliance requires audit trails. Enterprise customers demand accountability logs. Immutable append-only log enables forensics and undo functionality in future iterations.',
    made_by: 'jordan-security',
    confidence: 'high',
    alternatives_considered: [
      {
        option: 'Application-level logging only (stdout/Datadog)',
        rejected_reason: 'Logs can be deleted or rotated; not sufficient for compliance.',
      },
    ],
    affects: ['marcus-builder', 'alex-product'],
    tags: ['security', 'database', 'product', 'documentation'],
    assumptions: [
      'Audit log is write-once (DELETE is forbidden in production by row-level security)',
      'Audit log is retained for 7 years',
    ],
    open_questions: [],
  });
  ok(`Decision 11: Audit logging (${decisionIds.auditLog})`);

  // ── Decision 12: Stripe Billing
  decisionIds.billing = await createDecision(projectId, {
    title: 'Use Stripe for billing integration',
    description:
      'TaskFlow uses Stripe Billing for subscription management (Free, Pro, Team, Enterprise tiers), usage-based add-ons, and invoicing.',
    reasoning:
      'Stripe is the industry standard for SaaS billing. Stripe Billing handles proration, trials, and coupon codes natively. Strong webhook support for real-time subscription events.',
    made_by: 'alex-product',
    confidence: 'high',
    alternatives_considered: [
      { option: 'Paddle', rejected_reason: 'Less flexible for usage-based pricing; fewer integrations.' },
      { option: 'LemonSqueezy', rejected_reason: 'Not suitable for B2B invoicing requirements.' },
    ],
    affects: ['marcus-builder', 'jordan-security', 'priya-reviewer'],
    tags: ['product', 'security', 'implementation'],
    assumptions: [
      'Free tier: 5 members, 100 tasks',
      'Pro tier: unlimited members, $12/user/month',
      'Webhook signature verification mandatory',
    ],
    open_questions: ['Do we support annual billing at launch or defer to post-launch?'],
  });
  ok(`Decision 12: Stripe billing (${decisionIds.billing})`);

  // ── Decision 13: Railway Deployment
  decisionIds.deployment = await createDecision(projectId, {
    title: 'Deploy on Railway with auto-scaling',
    description:
      'TaskFlow backend and worker processes deploy on Railway. Railway provides Git-based deployments, auto-scaling, built-in observability, and PostgreSQL + Redis add-ons.',
    reasoning:
      'Railway eliminates Kubernetes complexity for an early-stage team. Built-in horizontal scaling via replicas. Native PostgreSQL and Redis add-ons simplify infra. Significantly cheaper than AWS ECS at our scale.',
    made_by: 'sarah-architect',
    confidence: 'high',
    alternatives_considered: [
      { option: 'AWS ECS + RDS', rejected_reason: 'Operational overhead is too high for a 5-person team.' },
      { option: 'Fly.io', rejected_reason: 'Less mature managed Postgres; Railway has better DX.' },
      { option: 'Vercel (full-stack)', rejected_reason: 'No persistent WebSocket support; expensive at scale.' },
    ],
    affects: ['marcus-builder', 'jordan-security'],
    tags: ['infrastructure', 'performance', 'security'],
    assumptions: [
      'Railway accounts for < $500/month in infra at launch',
      'Auto-scaling triggers at 70% CPU utilisation',
    ],
    open_questions: ['Should we have a DR (disaster recovery) region from day one?'],
  });
  ok(`Decision 13: Railway deployment (${decisionIds.deployment})`);

  // ── Decision 14: AI Task Prioritisation
  decisionIds.aiPriority = await createDecision(projectId, {
    title: 'Add AI task prioritisation with GPT-4o-mini',
    description:
      'Use OpenAI GPT-4o-mini to analyse task descriptions, deadlines, and team workload to suggest priority scores. Priority suggestions are opt-in and never override manual settings.',
    reasoning:
      'AI-powered prioritisation is the core differentiator of TaskFlow. GPT-4o-mini is 10x cheaper than GPT-4o with 95% of the quality for classification tasks. Opt-in design avoids the "AI override anxiety" we saw in user research.',
    made_by: 'alex-product',
    confidence: 'medium',
    alternatives_considered: [
      {
        option: 'GPT-4o',
        rejected_reason: 'Cost-prohibitive at scale; overkill for structured task data.',
      },
      {
        option: 'Llama 3 self-hosted',
        rejected_reason: 'Significant GPU infra overhead; latency too high for real-time suggestions.',
      },
      {
        option: 'Rule-based scoring',
        rejected_reason: 'Too rigid; cannot adapt to team-specific patterns.',
      },
    ],
    affects: ['marcus-builder', 'priya-reviewer'],
    tags: ['product', 'implementation', 'performance'],
    assumptions: [
      'OpenAI API rate limits are sufficient for MVP load',
      'AI suggestions are clearly labelled to maintain user trust',
      'GDPR compliance requires EU data residency option — check OpenAI\'s data processing agreement',
    ],
    open_questions: [
      'How do we evaluate the quality of AI prioritisation over time?',
      'Should we allow fine-tuning on team-specific data in future?',
    ],
  });
  ok(`Decision 14: AI task prioritisation (${decisionIds.aiPriority})`);

  // ── Decision 15: E2E Tests with Playwright
  decisionIds.e2eTests = await createDecision(projectId, {
    title: 'Implement E2E tests with Playwright',
    description:
      'End-to-end tests for critical user journeys (sign up, task creation, billing, real-time updates) are written with Playwright and run in CI on every pull request.',
    reasoning:
      'Playwright provides cross-browser testing (Chromium, Firefox, WebKit) with a modern API. Native WebSocket tracing is essential for testing real-time features. CI integration with GitHub Actions is first-class.',
    made_by: 'priya-reviewer',
    confidence: 'high',
    alternatives_considered: [
      { option: 'Cypress', rejected_reason: 'No native WebSocket support; slower CI execution.' },
      { option: 'Selenium', rejected_reason: 'Outdated API; fragile selectors; poor TypeScript support.' },
    ],
    affects: ['marcus-builder'],
    tags: ['testing', 'implementation', 'infrastructure'],
    assumptions: [
      'E2E tests run against a staging environment with seeded data',
      'Flaky tests are quarantined, not deleted',
    ],
    open_questions: ['Should we include visual regression tests (screenshot diffs) from the start?'],
  });
  ok(`Decision 15: E2E tests with Playwright (${decisionIds.e2eTests})`);

  // ── Decision 16: Pending — AI embedding strategy
  decisionIds.embeddingStrategy = await createDecision(projectId, {
    title: 'Decide on embedding strategy for semantic task search',
    description:
      'We need to choose between OpenAI text-embedding-3-small, a local SBERT model, or a managed service for generating embeddings on task titles and descriptions.',
    reasoning:
      'Semantic search of tasks by natural language query is a differentiator feature. The right embedding strategy balances latency, cost, privacy, and vector quality.',
    made_by: 'sarah-architect',
    confidence: 'low',
    status: 'pending',
    alternatives_considered: [
      { option: 'OpenAI text-embedding-3-small', rejected_reason: 'Pending — latency and cost TBD in load test.' },
      { option: 'SBERT (all-MiniLM-L6-v2) self-hosted', rejected_reason: 'Pending — GDPR advantage, but infra overhead.' },
    ],
    affects: ['marcus-builder', 'alex-product'],
    tags: ['architecture', 'implementation', 'performance'],
    assumptions: ['Vector dimension ≤ 1536 for pgvector compatibility'],
    open_questions: [
      'What is our target p99 latency for semantic search?',
      'Do enterprise customers have data residency requirements that prevent OpenAI API calls?',
    ],
    dependencies: [decisionIds.database!],
  });
  ok(`Decision 16: Embedding strategy (pending) (${decisionIds.embeddingStrategy})`);

  // ────────────────────────────────────────────────────────────────────────
  // 4. Create Decision Edges
  // ────────────────────────────────────────────────────────────────────────
  log(`\n${BOLD}Creating decision edges...${RESET}`);

  const edgeDefs = [
    // Supersession edge (Decision 6 → Decision 5)
    { from: 'honoRest', to: 'trpc', rel: 'supersedes', desc: 'Hono REST replaces tRPC as the API layer', strength: 1.0 },

    // Architecture informs
    { from: 'frontend', to: 'ui', rel: 'requires', desc: 'Next.js App Router requires Tailwind for styling', strength: 0.9 },
    { from: 'database', to: 'taskGraph', rel: 'enables', desc: 'PostgreSQL recursive CTE enables the task dependency graph', strength: 0.9 },
    { from: 'honoRest', to: 'websocket', rel: 'enables', desc: 'Hono WebSocket upgrade enables real-time transport', strength: 0.8 },
    { from: 'jwtAuth', to: 'rbac', rel: 'requires', desc: 'RBAC enforcement requires authenticated identity from JWT', strength: 1.0 },
    { from: 'redis', to: 'jwtAuth', rel: 'enables', desc: 'Redis provides JWT invalidation list for auth', strength: 0.7 },
    { from: 'redis', to: 'websocket', rel: 'enables', desc: 'Redis pub/sub fans out WebSocket messages across instances', strength: 0.8 },
    { from: 'database', to: 'aiPriority', rel: 'enables', desc: 'pgvector in PostgreSQL enables embedding storage for AI prioritisation', strength: 0.7 },
    { from: 'aiPriority', to: 'embeddingStrategy', rel: 'depends_on', desc: 'AI prioritisation depends on the chosen embedding strategy', strength: 0.9 },
    { from: 'deployment', to: 'database', rel: 'informs', desc: 'Railway deployment determines PostgreSQL connection pooling config', strength: 0.6 },
    { from: 'deployment', to: 'redis', rel: 'informs', desc: 'Railway Redis add-on is the deployment target for caching layer', strength: 0.6 },
    { from: 'auditLog', to: 'rbac', rel: 'refines', desc: 'Audit log records who performed each RBAC-controlled action', strength: 0.7 },
    { from: 'billing', to: 'rbac', rel: 'informs', desc: 'Billing tier determines which RBAC permissions are available', strength: 0.6 },
    { from: 'e2eTests', to: 'websocket', rel: 'informs', desc: 'Playwright must be able to trace WebSocket messages in E2E tests', strength: 0.5 },
    { from: 'frontend', to: 'honoRest', rel: 'depends_on', desc: 'Next.js frontend calls the Hono REST API', strength: 0.9 },
    { from: 'jwtAuth', to: 'honoRest', rel: 'informs', desc: 'JWT validation middleware runs on every Hono API route', strength: 0.8 },

    // Contradiction: JWT approach vs hypothetical session-based
    // (represented as a contradicts edge — the contradiction table entry is created separately)
  ] as const;

  for (const edge of edgeDefs) {
    if (!decisionIds[edge.from] || !decisionIds[edge.to]) {
      info(`  Skip edge ${edge.from} → ${edge.to}: missing IDs`);
      continue;
    }
    await query(
      `INSERT INTO decision_edges (source_id, target_id, relationship, description, strength)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [decisionIds[edge.from], decisionIds[edge.to], edge.rel, edge.desc, edge.strength],
    );
  }
  ok(`Created ${edgeDefs.length} decision edges`);

  // ────────────────────────────────────────────────────────────────────────
  // 5. Create Contradiction
  // ────────────────────────────────────────────────────────────────────────
  log(`\n${BOLD}Creating contradiction...${RESET}`);

  // JWT auth contradicts hypothetical session-based approach
  // (Simulated by finding that jwtAuth and billing have mismatched session assumptions)
  await query(
    `INSERT INTO contradictions
       (project_id, decision_a_id, decision_b_id, similarity_score, conflict_description, status)
     VALUES ($1, $2, $3, 0.71,
             'JWT auth decision assumes stateless tokens, but audit log decision implies server-side session tracking for IP-based anomaly detection. These assumptions conflict.',
             'unresolved')`,
    [projectId, decisionIds.jwtAuth, decisionIds.auditLog],
  );
  ok('Contradiction: JWT auth ↔ audit log (session assumptions mismatch)');

  // ────────────────────────────────────────────────────────────────────────
  // 6. Create Subscriptions
  // ────────────────────────────────────────────────────────────────────────
  log(`\n${BOLD}Creating subscriptions...${RESET}`);

  const subscriptionDefs = [
    { agent: 'sarah-architect', topic: 'architecture', events: ['update', 'supersede', 'contradict'], priority: 'high' },
    { agent: 'marcus-builder', topic: 'implementation', events: ['update', 'supersede'], priority: 'high' },
    { agent: 'marcus-builder', topic: 'api', events: ['update', 'supersede', 'contradict'], priority: 'medium' },
    { agent: 'priya-reviewer', topic: 'testing', events: ['update', 'supersede'], priority: 'high' },
    { agent: 'priya-reviewer', topic: 'security', events: ['update', 'contradict'], priority: 'high' },
    { agent: 'alex-product', topic: 'product', events: ['update', 'supersede'], priority: 'medium' },
    { agent: 'jordan-security', topic: 'security', events: ['update', 'supersede', 'contradict'], priority: 'high' },
    { agent: 'jordan-security', topic: 'database', events: ['update', 'contradict'], priority: 'medium' },
  ] as const;

  for (const sub of subscriptionDefs) {
    if (!agentIds[sub.agent]) continue;
    await query(
      `INSERT INTO subscriptions (agent_id, topic, notify_on, priority)
       VALUES ($1, $2, $3, $4)`,
      [agentIds[sub.agent], sub.topic, sub.events, sub.priority],
    );
  }
  ok(`Created ${subscriptionDefs.length} agent subscriptions`);

  // ────────────────────────────────────────────────────────────────────────
  // 7. Create Session Summaries
  // ────────────────────────────────────────────────────────────────────────
  log(`\n${BOLD}Creating session summaries...${RESET}`);

  const daysAgo = (n: number) =>
    new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const sessions = [
    {
      agent: 'sarah-architect',
      daysAgo: 14,
      topic: 'API Layer Architecture Review',
      summary:
        'Evaluated tRPC vs REST vs GraphQL for the TaskFlow API layer. tRPC was initially adopted but integration testing with the planned mobile app revealed friction with non-React clients. Decision made to migrate to Hono REST with OpenAPI spec generation.',
      decisionKeys: ['trpc', 'honoRest'],
      lessons: [
        'Type safety can be achieved with REST + Zod without tRPC coupling',
        'Mobile client compatibility should be a first-class constraint in API decisions',
      ],
      openQuestions: ['Should we maintain tRPC as an internal server layer and only expose REST externally?'],
      assumptions: [],
    },
    {
      agent: 'jordan-security',
      daysAgo: 10,
      topic: 'Authentication Security Review',
      summary:
        'Completed threat model for the JWT + RBAC authentication system. Key findings: refresh token rotation is correctly implemented; rate limiting on /auth endpoints is missing and must be added before launch; the audit log correctly captures all auth events.',
      decisionKeys: ['jwtAuth', 'rbac', 'auditLog', 'redis'],
      lessons: [
        'HTTP-only cookie storage prevents XSS token theft — must be non-negotiable',
        'Redis invalidation list must be included in DR backup strategy',
      ],
      openQuestions: ['Is RS256 sufficient or should we use ES256 for smaller tokens?'],
      assumptions: ['Rate limiting will be implemented in the next sprint'],
    },
    {
      agent: 'alex-product',
      daysAgo: 7,
      topic: 'AI Features Scoping — MVP vs Post-MVP',
      summary:
        'Reviewed the AI task prioritisation and semantic search features with the team. GPT-4o-mini is approved for priority suggestions. The embedding strategy decision is blocked on a load test of the two main candidates. WebSocket real-time is confirmed as required for collaborative editing.',
      decisionKeys: ['aiPriority', 'embeddingStrategy', 'websocket', 'taskGraph'],
      lessons: [
        'AI suggestions should always be opt-in — never override manual user preferences',
        'Semantic search is a post-MVP feature; AI prioritisation is the MVP differentiator',
      ],
      openQuestions: [
        'How do we A/B test AI prioritisation quality?',
        'Should we allow users to see the AI\'s reasoning for a suggested priority?',
      ],
      assumptions: ['GPT-4o-mini stays within OpenAI\'s GDPR data processing agreement terms'],
    },
    {
      agent: 'priya-reviewer',
      daysAgo: 3,
      topic: 'Testing Strategy Review — E2E and Contract Testing',
      summary:
        'Reviewed E2E test strategy using Playwright. The first test suite covers: sign up flow, task creation, dependency linking, and Stripe checkout. WebSocket tracing confirmed working in Playwright v1.48. Contract tests for the Hono REST API are planned using Zod schema validation.',
      decisionKeys: ['e2eTests', 'billing', 'honoRest'],
      lessons: [
        'Playwright trace viewer significantly reduces E2E debugging time',
        'Run E2E tests in parallel shards — sequential is 4x slower',
      ],
      openQuestions: ['Should we gate merges on E2E tests or only run on staging?'],
      assumptions: ['Staging environment is always running a recent seed database'],
    },
  ];

  for (const s of sessions) {
    const sessionDecisionIds = s.decisionKeys
      .map((k) => decisionIds[k as keyof typeof decisionIds])
      .filter(Boolean);

    await query(
      `INSERT INTO session_summaries
         (project_id, agent_name, session_date, topic, summary,
          decision_ids, artifact_ids, assumptions, open_questions, lessons_learned)
       VALUES ($1, $2, $3::date, $4, $5, $6::jsonb, '[]'::jsonb, $7::jsonb, $8::jsonb, $9::jsonb)`,
      [
        projectId,
        s.agent,
        daysAgo(s.daysAgo),
        s.topic,
        s.summary,
        JSON.stringify(sessionDecisionIds),
        JSON.stringify(s.assumptions),
        JSON.stringify(s.openQuestions),
        JSON.stringify(s.lessons),
      ],
    );
    ok(`Session: "${s.topic.slice(0, 50)}" by ${s.agent}`);
  }

  // ────────────────────────────────────────────────────────────────────────
  // 8. Create Artifacts
  // ────────────────────────────────────────────────────────────────────────
  log(`\n${BOLD}Creating artifacts...${RESET}`);

  const artifacts = [
    {
      name: 'TaskFlow System Architecture Diagram',
      artifact_type: 'design',
      path: 'docs/architecture/system-diagram.excalidraw',
      description: 'High-level system architecture showing Next.js frontend, Hono API, PostgreSQL + Redis, Railway deployment topology, and WebSocket connections.',
      content_summary: 'Shows: Next.js 15 App Router → Hono REST API → PostgreSQL (Drizzle) + Redis. Real-time path: client ↔ Hono WebSocket ↔ Redis pub/sub ↔ API instances.',
      produced_by: 'sarah-architect',
      decisionKeys: ['frontend', 'honoRest', 'database', 'redis', 'deployment', 'websocket'],
    },
    {
      name: 'Authentication Flow Spec',
      artifact_type: 'spec',
      path: 'docs/specs/authentication-flow.md',
      description: 'Detailed specification for the JWT + RBAC authentication system, including token lifecycle, refresh rotation, and RBAC permission matrix.',
      content_summary: 'Covers: JWT issuance (RS256), access token TTL 15min, refresh token TTL 30d with rotation, HTTP-only cookie storage, RBAC permission matrix for Owner/Admin/Member roles.',
      produced_by: 'jordan-security',
      decisionKeys: ['jwtAuth', 'rbac', 'redis'],
    },
    {
      name: 'Hono API OpenAPI Spec (v0.1)',
      artifact_type: 'spec',
      path: 'packages/api/openapi.json',
      description: 'Auto-generated OpenAPI 3.1 specification for the TaskFlow REST API, generated from Hono route definitions using @hono/zod-openapi.',
      content_summary: 'Covers 47 endpoints across: /auth, /projects, /tasks, /teams, /billing, /webhooks. All request/response types are Zod-validated.',
      produced_by: 'marcus-builder',
      decisionKeys: ['honoRest', 'jwtAuth', 'billing'],
    },
    {
      name: 'Database Schema (Drizzle)',
      artifact_type: 'code',
      path: 'packages/db/src/schema.ts',
      description: 'TypeScript database schema defined in Drizzle ORM, including tables for projects, tasks, users, teams, billing_subscriptions, audit_log, and pgvector embeddings.',
      content_summary: 'Key tables: projects, tasks (with DAG edges), users, team_members, billing_subscriptions, audit_events. pgvector extension: tasks.embedding (1536 dims).',
      produced_by: 'marcus-builder',
      decisionKeys: ['database', 'taskGraph', 'auditLog', 'aiPriority'],
    },
    {
      name: 'E2E Test Suite — Critical Paths',
      artifact_type: 'test',
      path: 'tests/e2e/',
      description: 'Playwright E2E test suite covering the 8 critical user journeys: sign up, onboarding, task creation, dependency linking, real-time collaboration, billing checkout, RBAC, and AI prioritisation.',
      content_summary: '42 tests across 8 spec files. CI runs sharded across 4 workers. All tests pass on staging as of last run.',
      produced_by: 'priya-reviewer',
      decisionKeys: ['e2eTests', 'websocket', 'billing'],
    },
  ];

  for (const artifact of artifacts) {
    const relatedIds = artifact.decisionKeys
      .map((k) => decisionIds[k as keyof typeof decisionIds])
      .filter(Boolean) as string[];

    await query(
      `INSERT INTO artifacts
         (project_id, name, artifact_type, path, description, content_summary, produced_by, related_decision_ids, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{}')`,
      [
        projectId,
        artifact.name,
        artifact.artifact_type,
        artifact.path,
        artifact.description,
        artifact.content_summary,
        artifact.produced_by,
        relatedIds,
      ],
    );
    ok(`Artifact: "${artifact.name.slice(0, 50)}" (${artifact.artifact_type})`);
  }

  // ────────────────────────────────────────────────────────────────────────
  // 9. Create Notifications
  // ────────────────────────────────────────────────────────────────────────
  log(`\n${BOLD}Creating notifications...${RESET}`);

  const notifications = [
    {
      agent: 'marcus-builder',
      decisionKey: 'honoRest',
      type: 'decision_created',
      message: 'The API layer has been switched from tRPC to REST with Hono. Update your implementation to use the new API client.',
      urgency: 'high',
    },
    {
      agent: 'marcus-builder',
      decisionKey: 'jwtAuth',
      type: 'decision_updated',
      message: 'Auth decision updated: rate limiting on /auth endpoints is now a required security control.',
      urgency: 'high',
    },
    {
      agent: 'priya-reviewer',
      decisionKey: 'honoRest',
      type: 'decision_superseded',
      message: 'The tRPC decision has been superseded by Hono REST. Update your code review checklist.',
      urgency: 'medium',
    },
    {
      agent: 'sarah-architect',
      decisionKey: 'jwtAuth',
      type: 'contradiction_detected',
      message: 'A contradiction was detected between the JWT auth and audit log decisions regarding session tracking assumptions.',
      urgency: 'critical',
    },
    {
      agent: 'jordan-security',
      decisionKey: 'embeddingStrategy',
      type: 'decision_created',
      message: 'The AI embedding strategy decision is now pending. Review OpenAI data processing agreement terms.',
      urgency: 'medium',
    },
  ] as const;

  for (const n of notifications) {
    if (!agentIds[n.agent] || !decisionIds[n.decisionKey]) continue;
    await query(
      `INSERT INTO notifications
         (agent_id, decision_id, notification_type, message, urgency)
       VALUES ($1, $2, $3, $4, $5)`,
      [agentIds[n.agent], decisionIds[n.decisionKey], n.type, n.message, n.urgency],
    );
  }
  ok(`Created ${notifications.length} agent notifications`);

  // ────────────────────────────────────────────────────────────────────────
  // 10. Summary
  // ────────────────────────────────────────────────────────────────────────
  log(`\n${'═'.repeat(55)}`);
  log(`${BOLD}${GREEN}✓ Demo seed complete!${RESET}`);
  log(`${'═'.repeat(55)}\n`);

  // Count what was created
  const counts = await qOne<Record<string, string>>(
    `SELECT
       (SELECT COUNT(*) FROM agents WHERE project_id = $1)::text         AS agents,
       (SELECT COUNT(*) FROM decisions WHERE project_id = $1)::text       AS decisions,
       (SELECT COUNT(*) FROM decision_edges
         WHERE source_id IN (SELECT id FROM decisions WHERE project_id = $1))::text AS edges,
       (SELECT COUNT(*) FROM session_summaries WHERE project_id = $1)::text AS sessions,
       (SELECT COUNT(*) FROM artifacts WHERE project_id = $1)::text        AS artifacts,
       (SELECT COUNT(*) FROM subscriptions
         WHERE agent_id IN (SELECT id FROM agents WHERE project_id = $1))::text AS subscriptions,
       (SELECT COUNT(*) FROM notifications
         WHERE agent_id IN (SELECT id FROM agents WHERE project_id = $1))::text AS notifications,
       (SELECT COUNT(*) FROM contradictions WHERE project_id = $1)::text   AS contradictions`,
    [projectId],
  );

  log(`${BOLD}Project:${RESET} TaskFlow — AI-Powered Task Management`);
  log(`${BOLD}Project ID:${RESET} ${CYAN}${projectId}${RESET}`);
  log('');
  log(`${BOLD}Seeded data:${RESET}`);
  log(`  Agents:         ${CYAN}${counts['agents']}${RESET}  (sarah-architect, marcus-builder, priya-reviewer, alex-product, jordan-security)`);
  log(`  Decisions:      ${CYAN}${counts['decisions']}${RESET}  (15 core + 1 pending embedding strategy)`);
  log(`  Edges:          ${CYAN}${counts['edges']}${RESET}  (includes supersession, requires, enables, depends_on, informs, refines)`);
  log(`  Sessions:       ${CYAN}${counts['sessions']}${RESET}`);
  log(`  Artifacts:      ${CYAN}${counts['artifacts']}${RESET}`);
  log(`  Subscriptions:  ${CYAN}${counts['subscriptions']}${RESET}`);
  log(`  Notifications:  ${CYAN}${counts['notifications']}${RESET}`);
  log(`  Contradictions: ${CYAN}${counts['contradictions']}${RESET}`);
  log('');
  log(`${DIM}To explore the data, try:${RESET}`);
  log(`  ${DIM}SELECT title, status, confidence FROM decisions WHERE project_id = '${projectId}' ORDER BY created_at;${RESET}`);
  log('');
}

seed()
  .catch((err) => {
    console.error('\n\x1b[31mSeed failed:\x1b[0m', err);
    process.exit(1);
  })
  .finally(() => closePool());
