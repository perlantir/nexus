/**
 * Agent Persona System — maps agent names to expertise topics
 * for persona-based scoring boosts in the context compiler.
 *
 * When computing personaMatchScore, the scoring engine checks
 * how many of the decision's tags overlap with the agent's
 * expertiseTopics. Score = (overlapping / total) * boostFactor.
 */

export interface AgentPersona {
  name: string;
  role: string;
  expertiseTopics: string[];
  boostFactor: number;
}

export const AGENT_PERSONAS: Record<string, AgentPersona> = {
  maks: {
    name: 'maks',
    role: 'builder',
    expertiseTopics: ['architecture', 'api', 'database', 'framework', 'hono', 'typescript', 'node', 'backend', 'server', 'infra', 'docker', 'deployment'],
    boostFactor: 0.20,
  },
  launch: {
    name: 'launch',
    role: 'marketing',
    expertiseTopics: ['marketing', 'content', 'tiktok', 'growth', 'launch', 'seo', 'social', 'brand', 'campaign', 'engagement'],
    boostFactor: 0.20,
  },
  pixel: {
    name: 'pixel',
    role: 'designer',
    expertiseTopics: ['design', 'ui', 'ux', 'palette', 'typography', 'layout', 'component', 'css', 'figma', 'responsive'],
    boostFactor: 0.20,
  },
  forge: {
    name: 'forge',
    role: 'reviewer',
    expertiseTopics: ['code-review', 'testing', 'ci-cd', 'security', 'quality', 'lint', 'coverage', 'audit', 'review'],
    boostFactor: 0.20,
  },
  counsel: {
    name: 'counsel',
    role: 'legal',
    expertiseTopics: ['legal', 'compliance', 'privacy', 'gdpr', 'ccpa', 'cftc', 'sec', 'tos', 'regulation', 'custody', 'gambling'],
    boostFactor: 0.22,
  },
  chain: {
    name: 'chain',
    role: 'blockchain',
    expertiseTopics: ['blockchain', 'solidity', 'on-chain', 'smart-contract', 'defi', 'web3', 'token', 'wallet', 'nft', 'ethereum'],
    boostFactor: 0.22,
  },
  governor: {
    name: 'governor',
    role: 'enforcement',
    expertiseTopics: ['enforcement', 'orchestration', 'safety', 'cost', 'monitoring', 'budget', 'priority', 'risk'],
    boostFactor: 0.18,
  },
  scout: {
    name: 'scout',
    role: 'researcher',
    expertiseTopics: ['research', 'analysis', 'competitor', 'market', 'trend', 'data', 'benchmark', 'survey'],
    boostFactor: 0.18,
  },
  gauntlet: {
    name: 'gauntlet',
    role: 'challenge-engine',
    expertiseTopics: ['challenge', 'scoring', 'judge', 'elo', 'leaderboard', 'mutation', 'matchmaking', 'bout', 'competition'],
    boostFactor: 0.22,
  },
  distillery: {
    name: 'distillery',
    role: 'extractor',
    expertiseTopics: ['extraction', 'decision', 'learning', 'retrospective', 'documentation', 'summary'],
    boostFactor: 0.15,
  },
};

/**
 * Look up persona by agent name (case-insensitive).
 * Returns undefined if no persona is configured for this agent.
 */
export function getPersona(agentName: string): AgentPersona | undefined {
  return AGENT_PERSONAS[agentName.toLowerCase()];
}

// Log on startup
console.warn(`[decigraph:personas] Loaded ${Object.keys(AGENT_PERSONAS).length} agent personas`);
