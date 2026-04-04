/**
 * Scoring Engine Tests — validates the tuned 4-signal + multiplier scoring.
 *
 * Signals: directAffect (0.35), tagMatch (0.22), personaMatch (0.18), semanticSimilarity (0.25)
 * Multipliers: status, freshness, confidence
 * Bonuses: +0.25 direct affect, +0.15 made_by match
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the agentPersonas module
vi.mock('../src/config/agentPersonas.js', () => ({
  getPersona: (name: string) => {
    const personas: Record<string, { name: string; role: string; expertiseTopics: string[]; boostFactor: number }> = {
      builder: { name: 'builder', role: 'builder', expertiseTopics: ['architecture', 'api', 'database'], boostFactor: 0.20 },
      pixel: { name: 'pixel', role: 'designer', expertiseTopics: ['design', 'ui', 'ux'], boostFactor: 0.20 },
    };
    return personas[name.toLowerCase()];
  },
  AGENT_PERSONAS: {},
}));

import { scoreDecision, MIN_SCORE, MAX_RESULTS } from '../src/context-compiler/index.js';
import type { Decision, Agent, RelevanceProfile } from '../src/types.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: 'dec-1',
    project_id: 'proj-1',
    title: 'Use JWT for auth',
    description: 'Token-based auth',
    reasoning: 'Stateless, scalable',
    made_by: 'alice',
    source: 'manual',
    confidence: 'high',
    status: 'active',
    tags: ['auth', 'architecture'],
    affects: ['builder'],
    alternatives_considered: [],
    assumptions: [],
    open_questions: [],
    dependencies: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as Decision;
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  const profile: RelevanceProfile = {
    weights: { auth: 0.8, architecture: 1.0, api: 0.9 },
    decision_depth: 2,
    freshness_preference: 'balanced',
    include_superseded: false,
  };
  return {
    id: 'agent-1',
    project_id: 'proj-1',
    name: 'builder',
    role: 'builder',
    relevance_profile: profile,
    context_budget_tokens: 50000,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as Agent;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('scoreDecision — Signal A: direct affect', () => {
  it('scores 1.0 when agent name is in affects', () => {
    const d = makeDecision({ affects: ['builder'] });
    const result = scoreDecision(d, makeAgent(), []);
    expect(result.scoring_breakdown.direct_affect).toBe(1.0);
  });

  it('scores 0 when agent is not in affects', () => {
    const d = makeDecision({ affects: ['pixel'] });
    const result = scoreDecision(d, makeAgent(), []);
    expect(result.scoring_breakdown.direct_affect).toBe(0.0);
  });

  it('is case-insensitive', () => {
    const d = makeDecision({ affects: ['BUILDER'] });
    const result = scoreDecision(d, makeAgent(), []);
    expect(result.scoring_breakdown.direct_affect).toBe(1.0);
  });
});

describe('scoreDecision — Signal B: tag matching', () => {
  it('scores > 0 when tags overlap with profile weights', () => {
    const d = makeDecision({ tags: ['auth', 'architecture'] });
    const result = scoreDecision(d, makeAgent(), []);
    expect(result.scoring_breakdown.tag_matching).toBeGreaterThan(0);
  });

  it('scores 0 when no tags match profile', () => {
    const d = makeDecision({ tags: ['marketing', 'seo'] });
    const result = scoreDecision(d, makeAgent(), []);
    expect(result.scoring_breakdown.tag_matching).toBe(0);
  });
});

describe('scoreDecision — Signal C: persona match', () => {
  it('scores > 0 when decision tags overlap with persona expertise', () => {
    const d = makeDecision({ tags: ['architecture', 'api'] });
    const result = scoreDecision(d, makeAgent(), []);
    expect(result.scoring_breakdown.role_relevance).toBeGreaterThan(0);
  });

  it('scores 0 when no tag overlaps persona expertise', () => {
    const d = makeDecision({ tags: ['legal', 'compliance'] });
    const result = scoreDecision(d, makeAgent(), []);
    expect(result.scoring_breakdown.role_relevance).toBe(0);
  });
});

describe('scoreDecision — Signal D: semantic similarity', () => {
  it('scores 0 when no embeddings available', () => {
    const result = scoreDecision(makeDecision(), makeAgent(), []);
    expect(result.scoring_breakdown.semantic_similarity).toBe(0);
  });

  it('scores > 0 for matching embeddings', () => {
    const emb = [1, 0, 0, 0];
    const d = makeDecision({ embedding: emb } as any);
    const result = scoreDecision(d, makeAgent(), emb);
    expect(result.scoring_breakdown.semantic_similarity).toBeGreaterThan(0);
  });

  it('scores higher for more similar embeddings', () => {
    const taskEmb = [1, 0, 0, 0];
    const similar = makeDecision({ embedding: [0.9, 0.1, 0, 0] } as any);
    const dissimilar = makeDecision({ embedding: [0, 0, 1, 0] } as any);
    const scoreSimilar = scoreDecision(similar, makeAgent(), taskEmb);
    const scoreDissimilar = scoreDecision(dissimilar, makeAgent(), taskEmb);
    expect(scoreSimilar.scoring_breakdown.semantic_similarity)
      .toBeGreaterThan(scoreDissimilar.scoring_breakdown.semantic_similarity);
  });
});

describe('scoreDecision — multipliers', () => {
  it('superseded decisions score lower than active', () => {
    const active = scoreDecision(makeDecision({ status: 'active' }), makeAgent(), []);
    const superseded = scoreDecision(makeDecision({ status: 'superseded' }), makeAgent(), []);
    expect(superseded.combined_score).toBeLessThan(active.combined_score);
  });

  it('pending decisions score lower than active', () => {
    const active = scoreDecision(makeDecision({ status: 'active' }), makeAgent(), []);
    const pending = scoreDecision(makeDecision({ status: 'pending' }), makeAgent(), []);
    expect(pending.combined_score).toBeLessThan(active.combined_score);
  });

  it('high confidence gets 1.15x boost', () => {
    const high = scoreDecision(makeDecision({ confidence: 'high' }), makeAgent(), []);
    const medium = scoreDecision(makeDecision({ confidence: 'medium' }), makeAgent(), []);
    expect(high.combined_score).toBeGreaterThan(medium.combined_score);
  });

  it('low confidence gets 0.75x penalty', () => {
    const low = scoreDecision(makeDecision({ confidence: 'low' }), makeAgent(), []);
    const medium = scoreDecision(makeDecision({ confidence: 'medium' }), makeAgent(), []);
    expect(low.combined_score).toBeLessThan(medium.combined_score);
  });
});

describe('scoreDecision — agent match bonuses', () => {
  it('+0.25 bonus when agent is in affects', () => {
    const withAffect = scoreDecision(makeDecision({ affects: ['builder'] }), makeAgent(), []);
    const without = scoreDecision(makeDecision({ affects: ['pixel'] }), makeAgent(), []);
    // The gap should be at least 0.2 (0.25 bonus + directAffect signal difference)
    expect(withAffect.combined_score - without.combined_score).toBeGreaterThan(0.2);
  });

  it('+0.15 bonus when agent is the maker', () => {
    const maker = scoreDecision(makeDecision({ made_by: 'builder' }), makeAgent(), []);
    const notMaker = scoreDecision(makeDecision({ made_by: 'alice' }), makeAgent(), []);
    expect(maker.combined_score).toBeGreaterThan(notMaker.combined_score);
  });
});

describe('scoreDecision — combined output', () => {
  it('returns ScoredDecision with all fields', () => {
    const result = scoreDecision(makeDecision(), makeAgent(), []);
    expect(result.combined_score).toBeDefined();
    expect(result.relevance_score).toBeDefined();
    expect(result.freshness_score).toBeDefined();
    expect(result.scoring_breakdown).toBeDefined();
    expect(result.scoring_breakdown.direct_affect).toBeDefined();
    expect(result.scoring_breakdown.tag_matching).toBeDefined();
    expect(result.scoring_breakdown.role_relevance).toBeDefined();
    expect(result.scoring_breakdown.semantic_similarity).toBeDefined();
  });

  it('combined_score is clamped to [0, 1.5]', () => {
    const result = scoreDecision(makeDecision(), makeAgent(), []);
    expect(result.combined_score).toBeGreaterThanOrEqual(0);
    expect(result.combined_score).toBeLessThanOrEqual(1.5);
  });

  it('highly relevant decisions score > 0.5', () => {
    const d = makeDecision({ affects: ['builder'], tags: ['architecture', 'api'], confidence: 'high' });
    const result = scoreDecision(d, makeAgent(), []);
    expect(result.combined_score).toBeGreaterThan(0.5);
  });

  it('irrelevant decisions score < 0.3', () => {
    const d = makeDecision({ affects: ['nobody'], tags: ['marketing'], confidence: 'low', status: 'superseded' });
    const result = scoreDecision(d, makeAgent(), []);
    expect(result.combined_score).toBeLessThan(0.3);
  });

  it('preserves original decision fields', () => {
    const d = makeDecision({ title: 'Test Title', description: 'Test Desc' });
    const result = scoreDecision(d, makeAgent(), []);
    expect(result.title).toBe('Test Title');
    expect(result.description).toBe('Test Desc');
    expect(result.id).toBe('dec-1');
  });
});

describe('Scoring constants', () => {
  it('MIN_SCORE is 0.45', () => {
    expect(MIN_SCORE).toBe(0.45);
  });

  it('MAX_RESULTS is 25', () => {
    expect(MAX_RESULTS).toBe(25);
  });
});
