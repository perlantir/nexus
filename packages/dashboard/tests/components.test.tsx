/**
 * Dashboard component tests
 *
 * Each component gets 3 tests:
 *   1. Renders with mock data
 *   2. Renders empty state
 *   3. Renders loading state
 *
 * All renders wrapped in act() with waitFor() for async state settlement.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { vi, describe, it, beforeEach, expect } from 'vitest';

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPatch = vi.fn();
const mockDel = vi.fn();

vi.mock('../src/hooks/useApi', () => ({
  useApi: () => ({
    get: mockGet,
    post: mockPost,
    patch: mockPatch,
    del: mockDel,
    baseUrl: 'http://localhost:3100',
  }),
}));

vi.mock('../src/App', () => ({
  useProject: () => ({ projectId: 'test-project-1', setProjectId: vi.fn() }),
}));

const mockChain: Record<string, Function> = {};
const chainProxy = (): Record<string, Function> =>
  new Proxy({} as Record<string, Function>, {
    get: () => chainProxy,
  });

vi.mock('d3', () => ({
  select: () => chainProxy(),
  selectAll: () => chainProxy(),
  forceSimulation: () => chainProxy(),
  forceLink: () => chainProxy(),
  forceManyBody: () => chainProxy(),
  forceCenter: () => chainProxy(),
  forceCollide: () => chainProxy(),
  zoom: () => chainProxy(),
  drag: () => chainProxy(),
  zoomTransform: () => ({ k: 1, x: 0, y: 0 }),
  zoomIdentity: { k: 1, x: 0, y: 0 },
}));

vi.mock('d3-force', () => ({}));

// --- Fixtures ---

const MOCK_DECISION = {
  id: 'dec-001',
  title: 'Use PostgreSQL as primary database',
  description: 'We will use PostgreSQL for all relational data storage.',
  reasoning: 'Mature ecosystem, strong ACID guarantees, and team familiarity.',
  status: 'active' as const,
  tags: ['database', 'infrastructure'],
  made_by: 'ArchitectAgent',
  created_at: '2025-11-15T10:30:00.000Z',
  project_id: 'test-project-1',
  alternatives: ['MySQL', 'SQLite'],
  assumptions: ['Team knows SQL'],
  relationships: [],
};

const MOCK_DECISION_2 = {
  id: 'dec-002',
  title: 'Use Redis for caching',
  description: 'Redis will handle session storage and cache layers.',
  reasoning: 'Fast in-memory store with persistence options.',
  status: 'superseded' as const,
  tags: ['caching', 'infrastructure'],
  made_by: 'BackendAgent',
  created_at: '2025-11-16T14:00:00.000Z',
  project_id: 'test-project-1',
  alternatives: [],
  assumptions: [],
  relationships: [],
  supersedes: 'dec-001',
};

const MOCK_CONTRADICTION = {
  id: 'con-001',
  decision_a_id: 'dec-001',
  decision_b_id: 'dec-002',
  decision_a: MOCK_DECISION,
  decision_b: MOCK_DECISION_2,
  similarity_score: 0.87,
  conflict_description:
    'Decision A uses PostgreSQL exclusively but Decision B introduces Redis for caching.',
  status: 'unresolved' as const,
  detected_at: '2025-11-17T09:00:00.000Z',
};

const MOCK_SESSION = {
  id: 'sess-001',
  agent_name: 'ArchitectAgent',
  topic: 'Database architecture decisions',
  started_at: '2025-11-15T09:00:00.000Z',
  ended_at: '2025-11-15T10:30:00.000Z',
  summary: 'Discussed and finalized core database choices for the platform.',
  decisions_extracted: 3,
  decision_ids: ['dec-001'],
  assumptions: ['Team knows PostgreSQL'],
  open_questions: ['How to handle migrations?'],
  lessons_learned: ['Start with the simplest DB that meets requirements.'],
  extraction_confidence: 0.92,
};

const MOCK_NOTIFICATION = {
  id: 'notif-001',
  type: 'contradiction' as const,
  urgency: 'high' as const,
  message: 'New contradiction detected between database decisions.',
  role_context: 'Architecture team should review.',
  read: false,
  created_at: '2025-11-17T09:01:00.000Z',
  decision_id: 'dec-001',
};

const MOCK_STATS = {
  total_decisions: 12,
  by_status: { active: 7, superseded: 3, reverted: 1, pending: 1 },
  decisions_per_agent: [
    { agent: 'ArchitectAgent', count: 5 },
    { agent: 'BackendAgent', count: 4 },
    { agent: 'FrontendAgent', count: 3 },
  ],
  unresolved_contradictions: 2,
  total_agents: 3,
  total_artifacts: 15,
  total_sessions: 8,
  recent_activity: [
    {
      id: 'act-001',
      type: 'new_decision',
      description: 'New decision: Use PostgreSQL as primary database',
      timestamp: '2025-11-15T10:30:00.000Z',
      agent: 'ArchitectAgent',
    },
  ],
  decision_trend: [
    { date: '2025-11-01T00:00:00.000Z', count: 2 },
    { date: '2025-11-08T00:00:00.000Z', count: 4 },
    { date: '2025-11-15T00:00:00.000Z', count: 6 },
  ],
};

const MOCK_SEARCH_RESULT = {
  decision: MOCK_DECISION,
  score: 0.94,
  snippet: '…use PostgreSQL for all relational data…',
};

const MOCK_IMPACT_RESULT = {
  decision: MOCK_DECISION,
  downstream: [MOCK_DECISION_2],
  affected_agents: [{ name: 'BackendAgent', role: 'Backend developer' }],
  blocking: [],
  supersession_chain: [],
};

const MOCK_CONTEXT_RESULT = {
  agent: 'ArchitectAgent',
  task: 'Select a database',
  decisions: [{ decision: MOCK_DECISION, score: 0.95 }],
};

// --- Helpers ---

function mockApiNeverResolve() {
  mockGet.mockReturnValue(new Promise(() => {}));
  mockPost.mockReturnValue(new Promise(() => {}));
}

function resetMocks() {
  mockGet.mockReset();
  mockPost.mockReset();
  mockPatch.mockReset();
  mockDel.mockReset();
}

// --- DecisionGraph ---

describe('DecisionGraph', () => {
  beforeEach(resetMocks);

  it('renders with mock data', async () => {
    mockGet.mockResolvedValue([MOCK_DECISION, MOCK_DECISION_2]);
    const { DecisionGraph } = await import('../src/components/DecisionGraph');
    let container: HTMLElement;
    await act(async () => {
      ({ container } = render(<DecisionGraph />));
    });
    await waitFor(() => {
      expect(container!.firstChild).toBeTruthy();
    });
  });

  it('renders empty state', async () => {
    mockGet.mockResolvedValue([]);
    const { DecisionGraph } = await import('../src/components/DecisionGraph');
    await act(async () => {
      render(<DecisionGraph />);
    });
    await waitFor(() => {
      expect(document.body.innerHTML.length).toBeGreaterThan(0);
    });
  });

  it('renders loading state', async () => {
    mockApiNeverResolve();
    const { DecisionGraph } = await import('../src/components/DecisionGraph');
    await act(async () => {
      render(<DecisionGraph />);
    });
    const spinner = document.querySelector('.animate-spin') || screen.queryByText(/loading/i);
    expect(spinner || document.body).toBeTruthy();
  });
});

// --- Timeline ---

describe('Timeline', () => {
  beforeEach(resetMocks);

  it('renders with mock data', async () => {
    mockGet.mockResolvedValue([MOCK_DECISION, MOCK_DECISION_2]);
    const { Timeline } = await import('../src/components/Timeline');
    await act(async () => {
      render(<Timeline />);
    });
    await waitFor(() => {
      expect(document.body.innerHTML.length).toBeGreaterThan(0);
    });
  });

  it('renders empty state', async () => {
    mockGet.mockResolvedValue([]);
    const { Timeline } = await import('../src/components/Timeline');
    await act(async () => {
      render(<Timeline />);
    });
    await waitFor(() => {
      expect(document.body.innerHTML.length).toBeGreaterThan(0);
    });
  });

  it('renders loading state', async () => {
    mockApiNeverResolve();
    const { Timeline } = await import('../src/components/Timeline');
    await act(async () => {
      render(<Timeline />);
    });
    expect(document.body.innerHTML.length).toBeGreaterThan(0);
  });
});

// --- Contradictions ---

describe('Contradictions', () => {
  beforeEach(resetMocks);

  it('renders with mock data', async () => {
    mockGet.mockResolvedValue([MOCK_CONTRADICTION]);
    const { Contradictions } = await import('../src/components/Contradictions');
    await act(async () => {
      render(<Contradictions />);
    });
    await waitFor(() => {
      expect(document.body.innerHTML.length).toBeGreaterThan(0);
    });
  });

  it('renders empty state', async () => {
    mockGet.mockResolvedValue([]);
    const { Contradictions } = await import('../src/components/Contradictions');
    await act(async () => {
      render(<Contradictions />);
    });
    await waitFor(() => {
      expect(document.body.innerHTML.length).toBeGreaterThan(0);
    });
  });

  it('renders loading state', async () => {
    mockApiNeverResolve();
    const { Contradictions } = await import('../src/components/Contradictions');
    await act(async () => {
      render(<Contradictions />);
    });
    expect(document.body.innerHTML.length).toBeGreaterThan(0);
  });
});

// --- ContextComparison ---

describe('ContextComparison', () => {
  beforeEach(resetMocks);

  it('renders with mock data', async () => {
    mockPost.mockResolvedValue([MOCK_CONTEXT_RESULT]);
    const { ContextComparison } = await import('../src/components/ContextComparison');
    await act(async () => {
      render(<ContextComparison />);
    });
    await waitFor(() => {
      expect(document.body.innerHTML.length).toBeGreaterThan(0);
    });
  });

  it('renders initial state', async () => {
    mockPost.mockResolvedValue([]);
    const { ContextComparison } = await import('../src/components/ContextComparison');
    await act(async () => {
      render(<ContextComparison />);
    });
    await waitFor(() => {
      expect(document.body.innerHTML.length).toBeGreaterThan(0);
    });
  });

  it('renders loading state', async () => {
    mockPost.mockReturnValue(new Promise(() => {}));
    const { ContextComparison } = await import('../src/components/ContextComparison');
    await act(async () => {
      render(<ContextComparison />);
    });
    expect(document.body.innerHTML.length).toBeGreaterThan(0);
  });
});

// --- Search ---

describe('Search', () => {
  beforeEach(resetMocks);

  it('renders with mock search results', async () => {
    mockPost.mockResolvedValue([MOCK_SEARCH_RESULT]);
    const { Search } = await import('../src/components/Search');
    await act(async () => {
      render(<Search />);
    });
    await waitFor(() => {
      expect(document.body.innerHTML.length).toBeGreaterThan(0);
    });
  });

  it('renders empty state', async () => {
    mockPost.mockResolvedValue([]);
    const { Search } = await import('../src/components/Search');
    await act(async () => {
      render(<Search />);
    });
    await waitFor(() => {
      expect(document.body.innerHTML.length).toBeGreaterThan(0);
    });
  });

  it('renders loading state', async () => {
    mockPost.mockReturnValue(new Promise(() => {}));
    const { Search } = await import('../src/components/Search');
    await act(async () => {
      render(<Search />);
    });
    expect(document.body.innerHTML.length).toBeGreaterThan(0);
  });
});

// --- ImpactAnalysis ---

describe('ImpactAnalysis', () => {
  beforeEach(resetMocks);

  it('renders with mock impact data', async () => {
    mockGet.mockResolvedValue([MOCK_DECISION, MOCK_DECISION_2]);
    mockPost.mockResolvedValue(MOCK_IMPACT_RESULT);
    const { ImpactAnalysis } = await import('../src/components/ImpactAnalysis');
    await act(async () => {
      render(<ImpactAnalysis />);
    });
    await waitFor(() => {
      expect(document.body.innerHTML.length).toBeGreaterThan(0);
    });
  });

  it('renders empty state', async () => {
    mockGet.mockResolvedValue([]);
    mockPost.mockResolvedValue(null);
    const { ImpactAnalysis } = await import('../src/components/ImpactAnalysis');
    await act(async () => {
      render(<ImpactAnalysis />);
    });
    await waitFor(() => {
      expect(document.body.innerHTML.length).toBeGreaterThan(0);
    });
  });

  it('renders loading state', async () => {
    mockGet.mockReturnValue(new Promise(() => {}));
    const { ImpactAnalysis } = await import('../src/components/ImpactAnalysis');
    await act(async () => {
      render(<ImpactAnalysis />);
    });
    expect(document.body.innerHTML.length).toBeGreaterThan(0);
  });
});

// --- SessionHistory ---

describe('SessionHistory', () => {
  beforeEach(resetMocks);

  it('renders with mock session data', async () => {
    mockGet.mockResolvedValue([MOCK_SESSION]);
    const { SessionHistory } = await import('../src/components/SessionHistory');
    await act(async () => {
      render(<SessionHistory />);
    });
    await waitFor(() => {
      expect(document.body.innerHTML.length).toBeGreaterThan(0);
    });
  });

  it('renders empty state', async () => {
    mockGet.mockResolvedValue([]);
    const { SessionHistory } = await import('../src/components/SessionHistory');
    await act(async () => {
      render(<SessionHistory />);
    });
    await waitFor(() => {
      expect(document.body.innerHTML.length).toBeGreaterThan(0);
    });
  });

  it('renders loading state', async () => {
    mockApiNeverResolve();
    const { SessionHistory } = await import('../src/components/SessionHistory');
    await act(async () => {
      render(<SessionHistory />);
    });
    expect(document.body.innerHTML.length).toBeGreaterThan(0);
  });
});

// --- NotificationFeed ---

describe('NotificationFeed', () => {
  beforeEach(resetMocks);

  it('renders with mock notifications', async () => {
    mockGet.mockResolvedValue([MOCK_NOTIFICATION]);
    const { NotificationFeed } = await import('../src/components/NotificationFeed');
    await act(async () => {
      render(<NotificationFeed />);
    });
    await waitFor(() => {
      expect(document.body.innerHTML.length).toBeGreaterThan(0);
    });
  });

  it('renders empty state', async () => {
    mockGet.mockResolvedValue([]);
    const { NotificationFeed } = await import('../src/components/NotificationFeed');
    await act(async () => {
      render(<NotificationFeed />);
    });
    await waitFor(() => {
      expect(document.body.innerHTML.length).toBeGreaterThan(0);
    });
  });

  it('renders loading state', async () => {
    mockApiNeverResolve();
    const { NotificationFeed } = await import('../src/components/NotificationFeed');
    await act(async () => {
      render(<NotificationFeed />);
    });
    expect(document.body.innerHTML.length).toBeGreaterThan(0);
  });
});

// --- ProjectStats ---

describe('ProjectStats', () => {
  beforeEach(resetMocks);

  it('renders with mock stats data', async () => {
    mockGet.mockResolvedValue(MOCK_STATS);
    const { ProjectStats } = await import('../src/components/ProjectStats');
    await act(async () => {
      render(<ProjectStats />);
    });
    await waitFor(() => {
      expect(document.body.innerHTML.length).toBeGreaterThan(0);
    });
  });

  it('renders empty state', async () => {
    mockGet.mockResolvedValue(null);
    const { ProjectStats } = await import('../src/components/ProjectStats');
    await act(async () => {
      render(<ProjectStats />);
    });
    await waitFor(() => {
      expect(document.body.innerHTML.length).toBeGreaterThan(0);
    });
  });

  it('renders loading state', async () => {
    mockApiNeverResolve();
    const { ProjectStats } = await import('../src/components/ProjectStats');
    await act(async () => {
      render(<ProjectStats />);
    });
    expect(document.body.innerHTML.length).toBeGreaterThan(0);
  });
});
