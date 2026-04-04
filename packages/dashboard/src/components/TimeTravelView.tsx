import { useState, useEffect, useCallback } from 'react';
import { useApi } from '../hooks/useApi';
import { useProject } from '../App';
import { Clock, ChevronRight, Diff, RotateCcw, Loader2 } from 'lucide-react';

interface CompileEntry {
  id: string;
  task_description: string;
  compiled_at: string;
  total_decisions: number;
  token_budget_used?: number;
  context_hash?: string;
  decision_scores?: Array<{ id: string; title: string; combined_score: number }>;
}

interface DiffResult {
  compiled_at_a: string;
  compiled_at_b: string;
  added_decisions: Array<{ title: string; score_b: number }>;
  removed_decisions: Array<{ title: string; score_a: number }>;
  reranked_decisions: Array<{ title: string; rank_a: number; rank_b: number; score_a: number; score_b: number }>;
  unchanged_count: number;
}

export function TimeTravelView() {
  const { get, post } = useApi();
  const { projectId } = useProject();

  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedAgent, setSelectedAgent] = useState('');
  const [history, setHistory] = useState<CompileEntry[]>([]);
  const [selectedEntry, setSelectedEntry] = useState<CompileEntry | null>(null);
  const [loading, setLoading] = useState(false);

  // Diff state
  const [diffA, setDiffA] = useState<string | null>(null);
  const [diffB, setDiffB] = useState<string | null>(null);
  const [diffResult, setDiffResult] = useState<DiffResult | null>(null);

  // Reconstruct state
  const [asOfDate, setAsOfDate] = useState('');
  const [reconstructResult, setReconstructResult] = useState<Record<string, unknown> | null>(null);

  // Fetch agents
  useEffect(() => {
    get<Array<{ id: string; name: string }>>(`/api/projects/${projectId}/agents`)
      .then((data) => setAgents(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, [get, projectId]);

  // Fetch compile history for selected agent
  const fetchHistory = useCallback(async () => {
    if (!selectedAgent) return;
    setLoading(true);
    try {
      const data = await get<CompileEntry[]>(`/api/agents/${selectedAgent}/compile-history?limit=50`);
      setHistory(Array.isArray(data) ? data : []);
    } catch { setHistory([]); }
    setLoading(false);
  }, [get, selectedAgent]);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);

  const handleViewEntry = async (id: string) => {
    try {
      const entry = await get<CompileEntry>(`/api/compile-history/${id}`);
      setSelectedEntry(entry);
    } catch { /* ignore */ }
  };

  const handleDiff = async () => {
    if (!diffA || !diffB) return;
    try {
      const result = await post<DiffResult>('/api/compile/diff', { compile_id_a: diffA, compile_id_b: diffB });
      setDiffResult(result);
    } catch { /* ignore */ }
  };

  const handleReconstruct = async () => {
    if (!asOfDate || !selectedAgent) return;
    const agentName = agents.find((a) => a.id === selectedAgent)?.name ?? '';
    try {
      const result = await post<Record<string, unknown>>('/api/compile/at', {
        agent_name: agentName,
        project_id: projectId,
        task_description: 'Time travel reconstruction',
        as_of: new Date(asOfDate).toISOString(),
      });
      setReconstructResult(result);
    } catch { /* ignore */ }
  };

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold mb-1">Time Travel</h1>
      <p className="text-sm text-[var(--text-secondary)] mb-6">
        Replay, reconstruct, and diff agent context at any point in time
      </p>

      {/* Agent selector */}
      <div className="mb-6">
        <label className="block text-xs font-medium mb-1 text-[var(--text-secondary)]">Select Agent</label>
        <select
          value={selectedAgent}
          onChange={(e) => { setSelectedAgent(e.target.value); setSelectedEntry(null); setDiffResult(null); }}
          className="px-3 py-2 rounded-md bg-[var(--bg-secondary)] border border-[var(--border-light)] text-sm w-64"
        >
          <option value="">Choose an agent...</option>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>

      {/* Reconstruct section */}
      <div className="mb-6 p-4 rounded-lg border border-[var(--border-light)] bg-[var(--bg-hover)]">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2"><RotateCcw size={14} /> Reconstruct Context</h2>
        <div className="flex items-end gap-3">
          <div>
            <label className="block text-xs text-[var(--text-secondary)] mb-1">As of date</label>
            <input
              type="datetime-local"
              value={asOfDate}
              onChange={(e) => setAsOfDate(e.target.value)}
              className="px-3 py-2 rounded-md bg-[var(--bg-secondary)] border border-[var(--border-light)] text-sm"
            />
          </div>
          <button
            onClick={handleReconstruct}
            disabled={!asOfDate || !selectedAgent}
            className="px-4 py-2 rounded-md bg-primary text-white text-sm font-medium disabled:opacity-30"
          >
            Reconstruct
          </button>
        </div>
        {reconstructResult && (
          <div className="mt-3 p-3 rounded bg-[var(--bg-secondary)] text-xs">
            <p className="font-medium mb-1">As of: {(reconstructResult as Record<string, unknown>).as_of as string}</p>
            <p>{(reconstructResult as Record<string, unknown>).decisions_available as number} decisions available at that time</p>
          </div>
        )}
      </div>

      {loading && <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]"><Loader2 size={14} className="animate-spin" /> Loading history...</div>}

      {/* Empty state */}
      {!loading && selectedAgent && history.length === 0 && (
        <div className="text-center py-12">
          <Clock size={28} className="mx-auto mb-2 opacity-30" style={{ color: 'var(--text-tertiary)' }} />
          <p className="text-lg font-medium" style={{ color: 'var(--text-secondary)' }}>No compile history yet</p>
          <p className="text-sm mt-1" style={{ color: 'var(--text-tertiary)' }}>Compilations will appear here after running POST /api/compile</p>
        </div>
      )}

      {/* Compilation timeline */}
      {history.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold mb-3 flex items-center gap-2"><Clock size={14} /> Compilation History</h2>
          <div className="space-y-2">
            {history.map((entry) => (
              <div
                key={entry.id}
                className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                  selectedEntry?.id === entry.id ? 'border-primary bg-primary/5' : 'border-[var(--border-light)] bg-[var(--bg-hover)] hover:bg-[var(--bg-active)]'
                }`}
                onClick={() => handleViewEntry(entry.id)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium">{entry.task_description?.slice(0, 60)}</span>
                    <ChevronRight size={12} className="text-[var(--text-secondary)]" />
                  </div>
                  <span className="text-2xs text-[var(--text-secondary)]">{formatDate(entry.compiled_at)}</span>
                </div>
                <div className="text-2xs text-[var(--text-secondary)] mt-1">
                  {entry.total_decisions} decisions | {entry.token_budget_used ?? 0} tokens
                </div>
                {/* Diff selection */}
                <div className="flex gap-2 mt-2" onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => setDiffA(entry.id)}
                    className={`px-2 py-0.5 rounded text-2xs ${diffA === entry.id ? 'bg-blue-500/20 text-blue-400' : 'bg-[var(--bg-hover)] hover:bg-[var(--bg-active)]'}`}
                  >A</button>
                  <button
                    onClick={() => setDiffB(entry.id)}
                    className={`px-2 py-0.5 rounded text-2xs ${diffB === entry.id ? 'bg-green-500/20 text-green-400' : 'bg-[var(--bg-hover)] hover:bg-[var(--bg-active)]'}`}
                  >B</button>
                </div>
              </div>
            ))}
          </div>

          {/* Diff button */}
          {diffA && diffB && diffA !== diffB && (
            <button
              onClick={handleDiff}
              className="mt-3 flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-white text-sm font-medium"
            >
              <Diff size={14} /> Compare A vs B
            </button>
          )}
        </div>
      )}

      {/* Selected entry detail */}
      {selectedEntry && (
        <div className="mb-6 p-4 rounded-lg border border-[var(--border-light)] bg-[var(--bg-hover)]">
          <h2 className="text-sm font-semibold mb-2">Compilation Detail</h2>
          <p className="text-xs text-[var(--text-secondary)] mb-2">{selectedEntry.task_description}</p>
          <p className="text-2xs text-[var(--text-secondary)]">{formatDate(selectedEntry.compiled_at)} | Hash: {selectedEntry.context_hash?.slice(0, 12)}...</p>
          {selectedEntry.decision_scores && (
            <div className="mt-3 space-y-1">
              {(selectedEntry.decision_scores as Array<{ title: string; combined_score: number }>).map((d, i) => (
                <div key={i} className="flex items-center justify-between text-xs p-2 rounded bg-[var(--bg-secondary)]">
                  <span>{d.title}</span>
                  <span className="text-[var(--text-secondary)]">score: {d.combined_score}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Diff result */}
      {diffResult && (
        <div className="p-4 rounded-lg border border-[var(--border-light)] bg-[var(--bg-hover)]">
          <h2 className="text-sm font-semibold mb-3 flex items-center gap-2"><Diff size={14} /> Diff Result</h2>
          <div className="text-2xs text-[var(--text-secondary)] mb-3">
            {formatDate(diffResult.compiled_at_a)} vs {formatDate(diffResult.compiled_at_b)}
          </div>
          {diffResult.added_decisions.length > 0 && (
            <div className="mb-3">
              <p className="text-xs font-medium text-green-400 mb-1">Added ({diffResult.added_decisions.length})</p>
              {diffResult.added_decisions.map((d, i) => (
                <div key={i} className="text-xs p-1.5 rounded bg-green-500/5 mb-1">+ {d.title}</div>
              ))}
            </div>
          )}
          {diffResult.removed_decisions.length > 0 && (
            <div className="mb-3">
              <p className="text-xs font-medium text-red-400 mb-1">Removed ({diffResult.removed_decisions.length})</p>
              {diffResult.removed_decisions.map((d, i) => (
                <div key={i} className="text-xs p-1.5 rounded bg-red-500/5 mb-1">- {d.title}</div>
              ))}
            </div>
          )}
          {diffResult.reranked_decisions.length > 0 && (
            <div className="mb-3">
              <p className="text-xs font-medium text-yellow-400 mb-1">Reranked ({diffResult.reranked_decisions.length})</p>
              {diffResult.reranked_decisions.map((d, i) => (
                <div key={i} className="text-xs p-1.5 rounded bg-yellow-500/5 mb-1">
                  ~ {d.title} (#{d.rank_a} → #{d.rank_b})
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-[var(--text-secondary)]">{diffResult.unchanged_count} unchanged</p>
        </div>
      )}
    </div>
  );
}
