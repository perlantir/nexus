/**
 * New component tests — Wizard, Import, Connectors
 *
 * Uses the exact same mock setup as components.test.tsx:
 *   - useApi, useProject mocked
 *   - d3 chain proxy
 *   - All renders wrapped in act(async () => { ... })
 *   - waitFor for async assertions
 */

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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

// --- Helpers ---

function resetMocks() {
  mockGet.mockReset();
  mockPost.mockReset();
  mockPatch.mockReset();
  mockDel.mockReset();
}

// ── Wizard ────────────────────────────────────────────────────────────────────

describe('Wizard', () => {
  beforeEach(resetMocks);

  it('renders Welcome step on initial load', async () => {
    const { Wizard } = await import('../src/components/Wizard');
    await act(async () => {
      render(<Wizard onComplete={vi.fn()} />);
    });
    await waitFor(() => {
      expect(screen.getByText(/Welcome to DeciGraph/i)).toBeTruthy();
    });
  });

  it('advances through steps — clicking next changes step content', async () => {
    const { Wizard } = await import('../src/components/Wizard');
    await act(async () => {
      render(<Wizard onComplete={vi.fn()} />);
    });

    // Initially on Welcome step
    await waitFor(() => {
      expect(screen.getByText(/Welcome to DeciGraph/i)).toBeTruthy();
    });

    // Click the "Set up your first project" button to advance to step 1
    const nextBtn = screen.getByText(/Set up your first project/i);
    await act(async () => {
      fireEvent.click(nextBtn);
    });

    // Should now show the "Create your project" step
    await waitFor(() => {
      expect(screen.getByText(/Create your project/i)).toBeTruthy();
    });
  });

  it('creates project on step 2 submit — calls mockPost with project data', async () => {
    mockPost.mockResolvedValue({ id: 'new-project-uuid' });

    const { Wizard } = await import('../src/components/Wizard');
    await act(async () => {
      render(<Wizard onComplete={vi.fn()} />);
    });

    // Advance to step 1 (Create Project)
    await act(async () => {
      fireEvent.click(screen.getByText(/Set up your first project/i));
    });

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/e\.g\. Product v2 Architecture/i)).toBeTruthy();
    });

    // Fill in project name
    const nameInput = screen.getByPlaceholderText(/e\.g\. Product v2 Architecture/i);
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'My Test Project' } });
    });

    // Submit the form via the Create Project button
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Create Project/i }));
    });

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(
        '/api/projects',
        expect.objectContaining({ name: 'My Test Project' }),
      );
    });
  });

  it('registers agents on step 3 submit — calls mockPost for each agent', async () => {
    // Step 2: project creation succeeds
    mockPost.mockResolvedValueOnce({ id: 'proj-abc123' });
    // Step 3: agent registrations succeed
    mockPost.mockResolvedValue({ id: 'agent-id', name: 'alice', role: 'builder' });

    const { Wizard } = await import('../src/components/Wizard');
    await act(async () => {
      render(<Wizard onComplete={vi.fn()} />);
    });

    // Go to step 1 — Create Project
    await act(async () => {
      fireEvent.click(screen.getByText(/Set up your first project/i));
    });

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/e\.g\. Product v2 Architecture/i)).toBeTruthy();
    });

    // Fill project name and create it
    await act(async () => {
      fireEvent.change(
        screen.getByPlaceholderText(/e\.g\. Product v2 Architecture/i),
        { target: { value: 'Agent Test Project' } },
      );
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Create Project/i }));
    });

    // Wait for step 2 — Add Agents
    await waitFor(() => {
      expect(screen.getByText(/Add your agents/i)).toBeTruthy();
    });

    // Fill in names for the two default agent slots
    const agentInputs = screen.getAllByPlaceholderText(/Agent \d+ name/i);
    await act(async () => {
      fireEvent.change(agentInputs[0], { target: { value: 'alice' } });
      fireEvent.change(agentInputs[1], { target: { value: 'bob' } });
    });

    // Submit agents
    await act(async () => {
      fireEvent.click(screen.getByText(/Continue/i));
    });

    await waitFor(() => {
      const agentCalls = mockPost.mock.calls.filter((call) =>
        (call[0] as string).includes('/agents'),
      );
      expect(agentCalls.length).toBeGreaterThanOrEqual(2);
    });
  });
});

// ── Import ────────────────────────────────────────────────────────────────────

describe('Import', () => {
  beforeEach(resetMocks);

  it('renders drag-and-drop zone', async () => {
    const { Import } = await import('../src/components/Import');
    await act(async () => {
      render(<Import />);
    });
    await waitFor(() => {
      expect(
        screen.getByText(/Drop files here or click to browse/i),
      ).toBeTruthy();
    });
  });

  it('renders paste text area', async () => {
    const { Import } = await import('../src/components/Import');
    await act(async () => {
      render(<Import />);
    });
    await waitFor(() => {
      expect(
        screen.getByPlaceholderText(/Paste a conversation, meeting notes/i),
      ).toBeTruthy();
    });
  });

  it('shows progress during processing', async () => {
    // Return a promise that stays pending so the import stays in the "importing" state
    mockPost.mockReturnValue(new Promise(() => {}));

    const { Import } = await import('../src/components/Import');
    await act(async () => {
      render(<Import />);
    });

    // Type something in the paste textarea to enable the import button
    const textarea = screen.getByPlaceholderText(/Paste a conversation, meeting notes/i);
    await act(async () => {
      fireEvent.change(textarea, {
        target: { value: 'We decided to adopt microservices.' },
      });
    });

    // Click Import — the button text is "Import" when not importing
    const importBtn = screen.getByRole('button', { name: /^Import$/i });
    await act(async () => {
      fireEvent.click(importBtn);
    });

    // The "Processing…" text or spinner should appear
    await waitFor(() => {
      const processingText = screen.queryByText(/Processing…/i);
      const spinner = document.querySelector('.animate-spin');
      expect(processingText || spinner).toBeTruthy();
    });
  });

  it('shows results table after processing', async () => {
    const mockDecisions = [
      { id: 'dec-1', title: 'Use PostgreSQL', confidence: 0.92, tags: ['database'] },
      { id: 'dec-2', title: 'Use Redis for caching', confidence: 0.85, tags: ['cache'] },
    ];

    mockPost.mockResolvedValue({ decisions: mockDecisions });

    const { Import } = await import('../src/components/Import');
    await act(async () => {
      render(<Import />);
    });

    // Type text and trigger import
    const textarea = screen.getByPlaceholderText(/Paste a conversation, meeting notes/i);
    await act(async () => {
      fireEvent.change(textarea, {
        target: { value: 'Some conversation about infrastructure decisions.' },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Import$/i }));
    });

    // Results table should appear with decision count
    await waitFor(() => {
      expect(screen.getByText(/2 decisions extracted/i)).toBeTruthy();
    });

    // Individual decisions should be listed
    await waitFor(() => {
      expect(screen.getByText('Use PostgreSQL')).toBeTruthy();
      expect(screen.getByText('Use Redis for caching')).toBeTruthy();
    });
  });
});

// ── Connectors ────────────────────────────────────────────────────────────────

describe('Connectors', () => {
  beforeEach(resetMocks);

  it('renders connector list', async () => {
    const mockConnectors = [
      {
        id: 'conn-1',
        name: 'openclaw' as const,
        config: { path: '/projects/myapp' },
        enabled: true,
        sources_processed: 12,
        status: 'active' as const,
      },
      {
        id: 'conn-2',
        name: 'webhook' as const,
        config: { url: 'https://hooks.example.com/decigraph' },
        enabled: false,
        sources_processed: 0,
        status: 'idle' as const,
      },
    ];

    const mockDiscovery = {
      running: false,
      decisions_found: 8,
      sources_scanned: 12,
    };

    mockGet.mockImplementation((url: string) => {
      if (url.includes('/connectors')) return Promise.resolve(mockConnectors);
      if (url.includes('/discovery/status')) return Promise.resolve(mockDiscovery);
      return Promise.resolve([]);
    });

    const { Connectors } = await import('../src/components/Connectors');
    await act(async () => {
      render(<Connectors />);
    });

    await waitFor(() => {
      expect(document.body.innerHTML.toLowerCase()).toContain('openclaw');
    });
  });

  it('shows add connector form when Add connector button is clicked', async () => {
    mockGet
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ running: false, decisions_found: 0, sources_scanned: 0 });

    const { Connectors } = await import('../src/components/Connectors');
    await act(async () => {
      render(<Connectors />);
    });

    // Wait for loading to finish
    await waitFor(() => {
      expect(screen.queryByText(/Loading connectors…/i)).toBeFalsy();
    });

    // Click "Add connector" button (the one in the header)
    const addBtns = screen.getAllByRole('button', { name: /Add connector/i });
    await act(async () => {
      fireEvent.click(addBtns[0]);
    });

    // Form should appear
    await waitFor(() => {
      expect(screen.getByText(/New connector/i)).toBeTruthy();
    });
  });

  it('toggles enabled/disabled — calls mockPatch when toggle button clicked', async () => {
    const mockConnectors = [
      {
        id: 'conn-toggle',
        name: 'openclaw' as const,
        config: { path: '/projects/myapp' },
        enabled: true,
        sources_processed: 5,
        status: 'active' as const,
      },
    ];

    mockGet
      .mockResolvedValueOnce(mockConnectors)
      .mockResolvedValueOnce({ running: false, decisions_found: 5, sources_scanned: 5 });

    mockPatch.mockResolvedValue({});

    const { Connectors } = await import('../src/components/Connectors');
    await act(async () => {
      render(<Connectors />);
    });

    await waitFor(() => {
      expect(screen.queryByText(/openclaw/i) || document.body.innerHTML.includes('openclaw')).toBeTruthy();
    });

    // Find and click the toggle button (title "Disable connector" since it's currently enabled)
    const toggleBtn = screen.getByTitle(/Disable connector/i);
    await act(async () => {
      fireEvent.click(toggleBtn);
    });

    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalledWith(
        expect.stringContaining('/connectors/conn-toggle'),
        expect.objectContaining({ enabled: false }),
      );
    });
  });
});
