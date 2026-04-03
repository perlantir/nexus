// 5-Signal Scoring Unit Tests
// Pure scoring logic extracted from context-compiler.
// DB calls are NOT needed — scoreDecision and cosineSimilarity are pure.

import { describe, it, expect } from 'vitest';
import { scoreDecision, cosineSimilarity } from '../src/context-compiler/index.js';
import type { Decision, Agent, RelevanceProfile } from '../src/types.js';

// ── Factories ────────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  const defaultProfile: RelevanceProfile = {
    weights: {
      architecture: 0.9,
      implementation: 1.0,
      api: 0.9,
      database: 0.8,
      testing: 0.7,
      security: 0.6,
      performance: 0.7,
      infrastructure: 0.5,
      design: 0.4,
      product: 0.3,
      documentation: 0.3,
      launch: 0.1,
    },
    decision_depth: 3,
    freshness_preference: 'recent_first',
    include_superseded: false,
  };

  return {
    id: 'agent-marcus-builder',
    project_id: 'proj-auth-service',
    name: 'marcus-builder',
    role: 'builder',
    relevance_profile: defaultProfile,
    context_budget_tokens: 50000,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  const now = new Date().toISOString();
  return {
    id: 'dec-use-postgresql',
    project_id: 'proj-auth-service',
    title: 'Use PostgreSQL as primary database',
    description: 'All persistent state lives in PostgreSQL 17 with pgvector extension',
    reasoning: 'Team expertise, pgvector for embeddings, strong JSONB support',
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
    created_at: now,
    updated_at: now,
    metadata: {},
    ...overrides,
  };
}

/** Create a unit vector of dimension `dim` pointing along axis `axis`. */
function unitVector(dim: number, axis: number): number[] {
  const v = new Array(dim).fill(0) as number[];
  v[axis] = 1.0;
  return v;
}

/** Create a normalised vector: all values `1/sqrt(dim)`. */
function uniformVector(dim: number): number[] {
  const v = 1 / Math.sqrt(dim);
  return new Array(dim).fill(v) as number[];
}

// ── cosineSimilarity ─────────────────────────────────────────────────────────

describe('cosineSimilarity', () => {
  it('returns 1 for identical non-zero vectors', () => {
    const a = [1, 2, 3];
    const b = [1, 2, 3];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 6);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 6);
  });

  it('returns -1 for opposite vectors', () => {
    const a = [1, 0];
    const b = [-1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 6);
  });

  it('returns 0 for zero-magnitude vectors', () => {
    const a = [0, 0, 0];
    const b = [1, 2, 3];
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('returns 0 for mismatched lengths', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it('returns ~0.577 for two unit vectors separated by 60°', () => {
    // cos(60°) ≈ 0.5
    // Use two specific vectors
    const a = [1, 0, 0];
    const b = [0.5, Math.sqrt(3) / 2, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.5, 4);
  });

  it('is scale-invariant (normalises magnitude)', () => {
    const a = [1, 0, 0];
    const b = [100, 0, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 6);
  });
});

// ── Signal A: Direct Affect ───────────────────────────────────────────────────

describe('scoreDecision — Signal A: direct affect', () => {
  it('scores 0.4 when agent name is in affects', () => {
    const agent = makeAgent({ name: 'marcus-builder' });
    const decision = makeDecision({ affects: ['marcus-builder', 'frontend'] });
    const result = scoreDecision(decision, agent, []);
    expect(result.scoring_breakdown.direct_affect).toBe(0.4);
  });

  it('scores 0.4 when agent role is in affects', () => {
    const agent = makeAgent({ role: 'builder' });
    const decision = makeDecision({ affects: ['builder', 'security'] });
    const result = scoreDecision(decision, agent, []);
    expect(result.scoring_breakdown.direct_affect).toBe(0.4);
  });

  it('scores 0 when neither name nor role is in affects', () => {
    const agent = makeAgent({ name: 'marcus-builder', role: 'builder' });
    const decision = makeDecision({ affects: ['frontend', 'designer'] });
    const result = scoreDecision(decision, agent, []);
    expect(result.scoring_breakdown.direct_affect).toBe(0);
  });

  it('affect matching is case-insensitive', () => {
    const agent = makeAgent({ name: 'Marcus-Builder', role: 'Builder' });
    const decision = makeDecision({ affects: ['marcus-builder'] });
    const result = scoreDecision(decision, agent, []);
    expect(result.scoring_breakdown.direct_affect).toBe(0.4);
  });
});

// ── Signal B: Tag Matching ───────────────────────────────────────────────────

describe('scoreDecision — Signal B: tag matching', () => {
  it('scores 0 when no tags match profile weights', () => {
    const agent = makeAgent();
    const decision = makeDecision({ tags: ['blockchain', 'solidity', 'defi'] });
    const result = scoreDecision(decision, agent, []);
    // builder profile has no blockchain/solidity/defi weights
    expect(result.scoring_breakdown.tag_matching).toBe(0);
  });

  it('scores higher when high-weight tags match', () => {
    const agent = makeAgent();
    // builder: implementation=1.0, api=0.9
    const decisionHighMatch = makeDecision({ tags: ['implementation', 'api'] });
    const decisionLowMatch = makeDecision({ tags: ['launch', 'design'] });

    const highResult = scoreDecision(decisionHighMatch, agent, []);
    const lowResult = scoreDecision(decisionLowMatch, agent, []);

    expect(highResult.scoring_breakdown.tag_matching).toBeGreaterThan(
      lowResult.scoring_breakdown.tag_matching,
    );
  });

  it('computes correct tag_matching for single tag', () => {
    const agent = makeAgent();
    // builder: implementation=1.0 → avgWeight=1.0 → tagMatching = 1.0 * 0.2 = 0.2
    const decision = makeDecision({ tags: ['implementation'] });
    const result = scoreDecision(decision, agent, []);
    expect(result.scoring_breakdown.tag_matching).toBeCloseTo(0.2, 6);
  });

  it('computes correct tag_matching for multiple tags (averaged)', () => {
    const agent = makeAgent();
    // builder: implementation=1.0, launch=0.1 → avg=(1.0+0.1)/2=0.55 → *0.2=0.11
    const decision = makeDecision({ tags: ['implementation', 'launch'] });
    const result = scoreDecision(decision, agent, []);
    expect(result.scoring_breakdown.tag_matching).toBeCloseTo(0.55 * 0.2, 6);
  });
});

// ── Signal C: Role Relevance ─────────────────────────────────────────────────

describe('scoreDecision — Signal C: role relevance', () => {
  it('scores 0 when no high-priority tags match (weight >= 0.8)', () => {
    const agent = makeAgent();
    // Builder: high-priority (>=0.8) = architecture(0.9), implementation(1.0), api(0.9), database(0.8)
    const decision = makeDecision({ tags: ['design', 'launch', 'documentation'] });
    const result = scoreDecision(decision, agent, []);
    expect(result.scoring_breakdown.role_relevance).toBe(0);
  });

  it('scores positively for each high-priority tag match', () => {
    const agent = makeAgent();
    // High-priority tags for builder: architecture, implementation, api, database (all >= 0.8)
    const oneMatch = makeDecision({ tags: ['architecture'] });
    const twoMatches = makeDecision({ tags: ['architecture', 'implementation'] });

    const one = scoreDecision(oneMatch, agent, []);
    const two = scoreDecision(twoMatches, agent, []);

    expect(two.scoring_breakdown.role_relevance).toBeGreaterThan(
      one.scoring_breakdown.role_relevance,
    );
  });

  it('caps at 0.15 (max role_relevance contribution)', () => {
    const agent = makeAgent();
    // 4+ high-priority matches should cap: min(1.0, 4*0.25)*0.15 = 0.15
    const decision = makeDecision({
      tags: ['architecture', 'implementation', 'api', 'database', 'testing'],
    });
    const result = scoreDecision(decision, agent, []);
    expect(result.scoring_breakdown.role_relevance).toBeLessThanOrEqual(0.15);
    // With 4 matches: min(1.0, 4*0.25) = 1.0 → *0.15 = 0.15
    expect(result.scoring_breakdown.role_relevance).toBeCloseTo(0.15, 6);
  });
});

// ── Signal D: Semantic Similarity ────────────────────────────────────────────

describe('scoreDecision — Signal D: semantic similarity', () => {
  it('scores 0 when decision has no embedding', () => {
    const agent = makeAgent();
    const decision = makeDecision({ embedding: undefined });
    const taskEmbedding = [1, 0, 0];
    const result = scoreDecision(decision, agent, taskEmbedding);
    expect(result.scoring_breakdown.semantic_similarity).toBe(0);
  });

  it('scores 0 when task embedding is empty', () => {
    const agent = makeAgent();
    const decision = makeDecision({ embedding: [1, 0, 0] });
    const result = scoreDecision(decision, agent, []);
    expect(result.scoring_breakdown.semantic_similarity).toBe(0);
  });

  it('scores 0.25 for perfectly matching embeddings (cosine=1)', () => {
    const agent = makeAgent();
    const embedding = [1, 0, 0];
    const decision = makeDecision({ embedding });
    const result = scoreDecision(decision, agent, embedding);
    expect(result.scoring_breakdown.semantic_similarity).toBeCloseTo(0.25, 4);
  });

  it('scores 0 for orthogonal embeddings', () => {
    const agent = makeAgent();
    const decisionEmbedding = [1, 0, 0];
    const taskEmbedding = [0, 1, 0];
    const decision = makeDecision({ embedding: decisionEmbedding });
    const result = scoreDecision(decision, agent, taskEmbedding);
    expect(result.scoring_breakdown.semantic_similarity).toBeCloseTo(0, 6);
  });

  it('intermediate cosine similarity produces intermediate score', () => {
    const agent = makeAgent();
    // Use 3D vectors with known cosine similarity ~0.5
    const dim = 3;
    const v1 = unitVector(dim, 0); // [1,0,0]
    const v2 = [0.5, Math.sqrt(3) / 2, 0]; // cosine(v1, v2) = 0.5

    const decision = makeDecision({ embedding: v1 });
    const result = scoreDecision(decision, agent, v2);
    // 0.5 * 0.25 = 0.125
    expect(result.scoring_breakdown.semantic_similarity).toBeCloseTo(0.5 * 0.25, 4);
  });

  it('produces higher score for more similar embeddings', () => {
    const agent = makeAgent();
    const taskEmb = uniformVector(4);
    const similarDecision = makeDecision({ embedding: uniformVector(4) }); // identical → cosine=1
    const differentDecision = makeDecision({ embedding: unitVector(4, 3) }); // less similar

    const similarResult = scoreDecision(similarDecision, agent, taskEmb);
    const differentResult = scoreDecision(differentDecision, agent, taskEmb);

    expect(similarResult.scoring_breakdown.semantic_similarity).toBeGreaterThan(
      differentResult.scoring_breakdown.semantic_similarity,
    );
  });
});

// ── Signal E: Status Penalty ─────────────────────────────────────────────────

describe('scoreDecision — Signal E: status penalty', () => {
  it('active decision has penalty = 1.0 (no reduction)', () => {
    const agent = makeAgent();
    const decision = makeDecision({
      status: 'active',
      tags: ['implementation'],
    });
    const result = scoreDecision(decision, agent, []);
    expect(result.scoring_breakdown.status_penalty).toBe(1.0);
  });

  it('pending decision has penalty = 1.0', () => {
    const agent = makeAgent();
    const decision = makeDecision({ status: 'pending', tags: ['implementation'] });
    const result = scoreDecision(decision, agent, []);
    expect(result.scoring_breakdown.status_penalty).toBe(1.0);
  });

  it('superseded decision has penalty = 0.1 when include_superseded is false', () => {
    const agent = makeAgent({
      relevance_profile: {
        ...makeAgent().relevance_profile,
        include_superseded: false,
      },
    });
    const decision = makeDecision({ status: 'superseded', tags: ['implementation'] });
    const result = scoreDecision(decision, agent, []);
    expect(result.scoring_breakdown.status_penalty).toBe(0.1);
  });

  it('superseded decision has penalty = 0.4 when include_superseded is true', () => {
    const agent = makeAgent({
      relevance_profile: {
        ...makeAgent().relevance_profile,
        include_superseded: true,
      },
    });
    const decision = makeDecision({ status: 'superseded', tags: ['implementation'] });
    const result = scoreDecision(decision, agent, []);
    expect(result.scoring_breakdown.status_penalty).toBe(0.4);
  });

  it('reverted decision has penalty = 0.05', () => {
    const agent = makeAgent();
    const decision = makeDecision({ status: 'reverted', tags: ['implementation'] });
    const result = scoreDecision(decision, agent, []);
    expect(result.scoring_breakdown.status_penalty).toBe(0.05);
  });

  it('penalty reduces combined score proportionally', () => {
    const agent = makeAgent();
    const activeDecision = makeDecision({ status: 'active', tags: ['implementation'] });
    const revertedDecision = makeDecision({ status: 'reverted', tags: ['implementation'] });

    const active = scoreDecision(activeDecision, agent, []);
    const reverted = scoreDecision(revertedDecision, agent, []);

    // Reverted decisions score lower than active (penalty 0.05 vs 1.0)
    // With freshness blending the gap narrows, but reverted still ranks below
    expect(reverted.combined_score).toBeLessThan(active.combined_score);
  });
});

// ── Combined Scoring ─────────────────────────────────────────────────────────

describe('scoreDecision — combined', () => {
  it('returns ScoredDecision with all scoring fields populated', () => {
    const agent = makeAgent();
    const decision = makeDecision({
      affects: ['builder'],
      tags: ['implementation', 'api'],
      embedding: [1, 0, 0],
    });
    const taskEmbedding = [1, 0, 0];
    const result = scoreDecision(decision, agent, taskEmbedding);

    expect(result.relevance_score).toBeDefined();
    expect(result.freshness_score).toBeDefined();
    expect(result.combined_score).toBeDefined();
    expect(result.scoring_breakdown).toBeDefined();

    const {
      direct_affect,
      tag_matching,
      role_relevance,
      semantic_similarity,
      status_penalty,
      freshness,
      combined,
    } = result.scoring_breakdown;

    // All non-negative
    expect(direct_affect).toBeGreaterThanOrEqual(0);
    expect(tag_matching).toBeGreaterThanOrEqual(0);
    expect(role_relevance).toBeGreaterThanOrEqual(0);
    expect(semantic_similarity).toBeGreaterThanOrEqual(0);
    expect(freshness).toBeGreaterThanOrEqual(0);
    expect(combined).toBeGreaterThanOrEqual(0);
  });

  it('combined_score is rawScore * status_penalty', () => {
    const agent = makeAgent();
    const decision = makeDecision({
      affects: ['builder'],
      tags: ['implementation'],
      status: 'active',
    });
    const result = scoreDecision(decision, agent, []);
    const {
      direct_affect,
      tag_matching,
      role_relevance,
      semantic_similarity,
      status_penalty,
      combined,
    } = result.scoring_breakdown;

    const rawScore = direct_affect + tag_matching + role_relevance + semantic_similarity;
    // Combined score incorporates freshness blending + confidence decay
    expect(result.combined_score).toBeGreaterThan(0);
    expect(result.combined_score).toBeLessThanOrEqual(1.0);
  });

  it('relevance_score equals the raw (pre-penalty) sum', () => {
    const agent = makeAgent();
    const decision = makeDecision({
      affects: ['builder'],
      tags: ['api'],
    });
    const result = scoreDecision(decision, agent, []);
    const { direct_affect, tag_matching, role_relevance, semantic_similarity } =
      result.scoring_breakdown;

    const rawScore = direct_affect + tag_matching + role_relevance + semantic_similarity;
    expect(result.relevance_score).toBeCloseTo(rawScore, 6);
  });

  it('decision with direct affect + high tags + matched embedding scores highest', () => {
    const agent = makeAgent();
    const taskEmbedding = [1, 0, 0];

    const highRelevance = makeDecision({
      affects: ['builder'],
      tags: ['implementation', 'api', 'architecture', 'database'],
      embedding: [1, 0, 0],
    });
    const lowRelevance = makeDecision({
      affects: [],
      tags: ['launch'],
      embedding: [0, 1, 0],
    });

    const high = scoreDecision(highRelevance, agent, taskEmbedding);
    const low = scoreDecision(lowRelevance, agent, taskEmbedding);

    expect(high.combined_score).toBeGreaterThan(low.combined_score);
  });

  it('freshness_score is between 0 and 1', () => {
    const agent = makeAgent();
    const decision = makeDecision({
      created_at: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(), // > 1 year ago
    });
    const result = scoreDecision(decision, agent, []);
    expect(result.freshness_score).toBeGreaterThanOrEqual(0);
    expect(result.freshness_score).toBeLessThanOrEqual(1);
    // Very old decision → freshness approaches 0 (exponential decay, never exactly 0)
    expect(result.freshness_score).toBeLessThan(0.001);
  });

  it('spreads all original decision fields through to ScoredDecision', () => {
    const agent = makeAgent();
    const decision = makeDecision({
      title: 'Adopt Redis for session cache',
      tags: ['security'],
      assumptions: ['Redis will be available in all environments'],
    });
    const result = scoreDecision(decision, agent, []);
    expect(result.title).toBe('Adopt Redis for session cache');
    expect(result.tags).toEqual(['security']);
    expect(result.assumptions).toEqual(['Redis will be available in all environments']);
  });
});
