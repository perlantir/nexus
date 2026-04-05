/**
 * Agent Persona System V4 — maps agent names to expertise topics,
 * exclude tags, and title/description keywords for scoring.
 */

export interface AgentPersona {
  name: string;
  role: string;
  description: string;
  primaryTags: string[];
  excludeTags: string[];
  keywords: string[];
  boostFactor: number;
}

export const AGENT_PERSONAS: Record<string, AgentPersona> = {
  maks: {
    name: 'maks',
    role: 'builder',
    description: 'Full-stack engineering — Hono APIs, database, TypeScript, builds everything',
    primaryTags: ['hono', 'api', 'database', 'typescript', 'postgresql', 'backend', 'server', 'sdk', 'middleware', 'endpoints', 'architecture', 'node', 'docker', 'deployment', 'framework'],
    excludeTags: ['legal', 'compliance', 'marketing', 'tiktok', 'content', 'gambling', 'cftc', 'sec', 'typography', 'figma'],
    keywords: ['build', 'implement', 'api', 'server', 'database', 'endpoint', 'hono', 'typescript', 'deploy', 'backend'],
    boostFactor: 0.25,
  },
  makspm: {
    name: 'makspm',
    role: 'product',
    description: 'Product management — specs, task delegation, QA coordination, roadmap',
    // Use REAL tags from the database, not PM jargon
    primaryTags: ['architecture', 'product', 'process', 'business', 'bouts', 'scoring', 'monitoring', 'testing', 'devops', 'openclaw', 'competition', 'challenge', 'leaderboard', 'auth', 'dashboard'],
    excludeTags: ['solidity', 'on-chain', 'defi', 'smart-contract', 'figma', 'typography'],
    // Keywords match PM language in decision TITLES and DESCRIPTIONS
    keywords: ['spec', 'sprint', 'roadmap', 'milestone', 'delegation', 'qa', 'coordinate', 'priority', 'acceptance', 'handoff', 'rollout', 'plan', 'schedule', 'requirement'],
    boostFactor: 0.25,
  },
  scout: {
    name: 'scout',
    role: 'analytics',
    description: 'Research, market analysis, competitive intelligence, data insights',
    primaryTags: ['research', 'metrics', 'analysis', 'competitive', 'market', 'data', 'benchmarks', 'trends', 'insights', 'reports', 'analytics', 'survey', 'intelligence', 'pricing'],
    excludeTags: ['blockchain', 'solidity', 'design', 'typography', 'legal', 'compliance', 'cftc', 'sec', 'gambling', 'on-chain', 'figma', 'openclaw'],
    keywords: ['research', 'analysis', 'competitive', 'benchmark', 'metric', 'trend', 'insight', 'report', 'data', 'market'],
    boostFactor: 0.22,
  },
  clawexpert: {
    name: 'clawexpert',
    role: 'ops',
    description: 'OpenClaw infrastructure, config management, workspace setup, agent orchestration',
    primaryTags: ['openclaw', 'config', 'workspace', 'heartbeat', 'docker', 'vps', 'deployment', 'agents', 'plugins', 'setup', 'devops', 'infrastructure', 'orchestration', 'mcp', 'automation'],
    excludeTags: ['legal', 'marketing', 'tiktok', 'design', 'blockchain', 'solidity', 'content', 'gambling', 'cftc', 'typography', 'figma'],
    keywords: ['openclaw', 'config', 'workspace', 'setup', 'infrastructure', 'agent', 'automation', 'mcp', 'deploy', 'heartbeat'],
    boostFactor: 0.25,
  },
  launch: {
    name: 'launch',
    role: 'launch',
    description: 'Go-to-market, marketing, content strategy, TikTok, partnerships',
    // Tightened: marketing/GTM only, not product features
    primaryTags: ['marketing', 'go-to-market', 'tiktok', 'content', 'partnerships', 'pricing', 'campaigns', 'branding', 'seo', 'growth', 'acquisition', 'retention', 'distribution', 'conversion', 'launch'],
    excludeTags: ['architecture', 'database', 'solidity', 'on-chain', 'ci-cd', 'server', 'api', 'security', 'devops', 'openclaw', 'config', 'typography', 'color'],
    keywords: ['launch', 'marketing', 'tiktok', 'content', 'growth', 'campaign', 'social', 'brand', 'partnership', 'go-to-market', 'acquisition', 'pricing', 'distribution'],
    boostFactor: 0.25,
  },
  forge: {
    name: 'forge',
    role: 'reviewer',
    description: 'Code review, CI/CD, testing, security review, quality gates',
    primaryTags: ['code-review', 'ci-cd', 'testing', 'security', 'linting', 'pull-requests', 'quality', 'vulnerabilities', 'coverage', 'github-actions', 'pipeline', 'review', 'audit'],
    excludeTags: ['marketing', 'tiktok', 'content', 'design', 'typography', 'legal', 'compliance', 'gambling', 'cftc', 'figma', 'uberkiwi'],
    keywords: ['review', 'test', 'ci', 'cd', 'pipeline', 'coverage', 'lint', 'security', 'quality', 'pull-request'],
    boostFactor: 0.22,
  },
  pixel: {
    name: 'pixel',
    role: 'design',
    description: 'UI/UX design, V0 components, color systems, typography, age-adaptive interfaces',
    primaryTags: ['ui', 'ux', 'design', 'figma', 'v0', 'typography', 'color', 'palette', 'responsive', 'accessibility', 'components', 'tailwind', 'css', 'layout', 'age-adaptive'],
    excludeTags: ['legal', 'compliance', 'blockchain', 'security', 'devops', 'cost', 'openclaw', 'solidity', 'cftc', 'sec', 'gambling', 'database'],
    keywords: ['design', 'ui', 'ux', 'color', 'typography', 'component', 'layout', 'palette', 'responsive', 'figma', 'v0'],
    boostFactor: 0.25,
  },
  chain: {
    name: 'chain',
    role: 'blockchain',
    description: 'Solidity, on-chain scoring, DeFi, smart contracts, token mechanics',
    primaryTags: ['solidity', 'on-chain', 'smart-contracts', 'defi', 'tokens', 'ethereum', 'non-custodial', 'web3', 'ipfs', 'staking', 'escrow', 'blockchain', 'scoring-contract', 'wallet'],
    excludeTags: ['tiktok', 'content', 'marketing', 'design', 'mathind', 'uberkiwi', 'typography', 'figma', 'compliance', 'legal', 'qa'],
    keywords: ['solidity', 'blockchain', 'on-chain', 'contract', 'token', 'defi', 'web3', 'wallet', 'escrow', 'staking'],
    boostFactor: 0.25,
  },
  counsel: {
    name: 'counsel',
    role: 'legal',
    description: 'CFTC/SEC compliance, gambling law, privacy, NDAs, licensing, Iowa law',
    // Sharpened: pure legal vocabulary
    primaryTags: ['legal', 'compliance', 'cftc', 'sec', 'privacy', 'gdpr', 'ccpa', 'nda', 'licensing', 'gambling', 'money-transmitter', 'iowa-law', 'terms', 'consent', 'regulatory', 'policy'],
    excludeTags: ['architecture', 'devops', 'frontend', 'design', 'content', 'tiktok', 'production', 'openclaw', 'ci-cd', 'testing', 'performance', 'database', 'api', 'server'],
    keywords: ['compliance', 'regulat', 'privacy', 'CFTC', 'SEC', 'legal', 'NDA', 'license', 'gambl', 'money transmit', 'consent', 'policy', 'terms'],
    boostFactor: 0.25,
  },
  gauntlet: {
    name: 'gauntlet',
    role: 'challenge',
    description: 'Challenge generation, difficulty profiling, CDI scoring, contamination detection',
    primaryTags: ['challenges', 'difficulty', 'cdi', 'contamination', 'mutation', 'weight-class', 'sprint', 'marathon', 'engines', 'judges', 'scoring', 'bout', 'competition', 'matchmaking', 'elo'],
    excludeTags: ['marketing', 'tiktok', 'content', 'design', 'typography', 'legal', 'uberkiwi', 'compliance', 'cftc', 'figma', 'nda'],
    keywords: ['challenge', 'scoring', 'judge', 'elo', 'leaderboard', 'bout', 'difficulty', 'mutation', 'matchmaking', 'cdi', 'contamination'],
    boostFactor: 0.25,
  },
};

/**
 * Look up persona by agent name (case-insensitive).
 */
export function getPersona(agentName: string): AgentPersona | undefined {
  return AGENT_PERSONAS[agentName.toLowerCase()];
}
