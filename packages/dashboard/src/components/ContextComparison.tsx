import { useState } from 'react';
import { Columns2, Loader2, ArrowRight, Eye, EyeOff, Search } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useProject } from '../App';
import type { ContextResult, Decision } from '../types';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function scoreColor(score: number): string {
  if (score >= 0.8) return 'text-status-active';
  if (score >= 0.5) return 'text-status-superseded';
  return 'text-[var(--text-secondary)]';
}

function ScoreBar({ score }: { score: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1 rounded-full bg-[var(--border-light)] overflow-hidden">
        <div
          className="h-full rounded-full bg-primary transition-all duration-500"
          style={{ width: `${score * 100}%` }}
        />
      </div>
      <span className={`text-xs font-medium tabular-nums ${scoreColor(score)}`}>
        {(score * 100).toFixed(0)}%
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function ContextComparison() {
  const { post } = useApi();
  const { projectId } = useProject();

  const [agentA, setAgentA] = useState('');
  const [agentB, setAgentB] = useState('');
  const [task, setTask] = useState('');

  const [resultA, setResultA] = useState<ContextResult | null>(null);
  const [resultB, setResultB] = useState<ContextResult | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showShared, setShowShared] = useState(true);

  async function handleCompare() {
    if (!agentA || !agentB || !task) return;
    setLoading(true);
    setError(null);
    setResultA(null);
    setResultB(null);

    try {
      const [resA, resB] = await Promise.all([
        post<ContextResult>('/api/compile', {
          agent: agentA,
          task,
        }),
        post<ContextResult>('/api/compile', {
          agent: agentB,
          task,
        }),
      ]);
      setResultA(resA);
      setResultB(resB);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch context');
    } finally {
      setLoading(false);
    }
  }

  /* ---- Compute shared / unique ----------------------------------- */

  const idsA = new Set(resultA?.decisions.map((d) => d.id) ?? []);
  const idsB = new Set(resultB?.decisions.map((d) => d.id) ?? []);

  const sharedIds = new Set([...idsA].filter((id) => idsB.has(id)));
  const uniqueA = resultA?.decisions.filter((d) => !idsB.has(d.id)) ?? [];
  const uniqueB = resultB?.decisions.filter((d) => !idsA.has(d.id)) ?? [];
  const shared = resultA?.decisions.filter((d) => sharedIds.has(d.id)) ?? [];

  /* ---- Decision row ---------------------------------------------- */

  function DecisionRow({
    decision,
    score,
    highlight,
  }: {
    decision: { title?: string; status?: string; [key: string]: unknown };
    score: number;
    highlight?: 'a' | 'b' | 'shared';
  }) {
    const borderColor =
      highlight === 'a'
        ? 'border-l-primary'
        : highlight === 'b'
          ? 'border-l-status-superseded'
          : 'border-l-transparent';

    return (
      <div className={`p-3 rounded-md border-l-2 ${borderColor} card text-sm`}>
        <div className="flex items-start justify-between gap-2 mb-1">
          <h4 className="font-medium leading-snug flex-1">{decision.title}</h4>
          <span className={`badge badge-${decision.status}`}>{decision.status}</span>
        </div>
        <ScoreBar score={score} />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-lg font-semibold mb-1">Context Comparison</h1>
          <p className="text-sm text-[var(--text-secondary)]">
            Compare what two agents would see for a given task
          </p>
        </div>

        {/* Inputs */}
        <div className="card p-5 mb-6">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
            <div>
              <label className="text-xs font-medium text-[var(--text-secondary)] mb-1.5 block">
                Agent A
              </label>
              <input
                type="text"
                value={agentA}
                onChange={(e) => setAgentA(e.target.value)}
                placeholder="e.g. architect"
                className="input"
              />
            </div>

            <div>
              <label className="text-xs font-medium text-[var(--text-secondary)] mb-1.5 block">
                Agent B
              </label>
              <input
                type="text"
                value={agentB}
                onChange={(e) => setAgentB(e.target.value)}
                placeholder="e.g. frontend-dev"
                className="input"
              />
            </div>

            <div>
              <label className="text-xs font-medium text-[var(--text-secondary)] mb-1.5 block">
                Task
              </label>
              <input
                type="text"
                value={task}
                onChange={(e) => setTask(e.target.value)}
                placeholder="Describe the task…"
                className="input"
              />
            </div>
          </div>

          <button
            onClick={handleCompare}
            disabled={!agentA || !agentB || !task || loading}
            className="btn-primary text-sm"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
            Compare
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="card p-4 mb-6 border-status-reverted/40">
            <p className="text-sm text-status-reverted">{error}</p>
          </div>
        )}

        {/* Results */}
        {resultA && resultB && (
          <div className="animate-fade-in">
            {/* Summary */}
            <div className="grid grid-cols-3 gap-4 mb-6">
              <div className="card p-4 text-center">
                <p className="text-2xl font-bold text-primary tabular-nums">{uniqueA.length}</p>
                <p className="text-xs text-[var(--text-secondary)] mt-1">
                  Unique to {agentA}
                </p>
              </div>
              <div className="card p-4 text-center">
                <p className="text-2xl font-bold tabular-nums">{shared.length}</p>
                <p className="text-xs text-[var(--text-secondary)] mt-1">
                  Shared
                </p>
              </div>
              <div className="card p-4 text-center">
                <p className="text-2xl font-bold text-status-superseded tabular-nums">
                  {uniqueB.length}
                </p>
                <p className="text-xs text-[var(--text-secondary)] mt-1">
                  Unique to {agentB}
                </p>
              </div>
            </div>

            {/* Toggle shared */}
            <button onClick={() => setShowShared(!showShared)} className="btn-ghost text-xs mb-4">
              {showShared ? <EyeOff size={14} /> : <Eye size={14} />}
              {showShared ? 'Hide' : 'Show'} shared decisions
            </button>

            {/* Side-by-side */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Agent A */}
              <div>
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-primary" />
                  {agentA}
                  <span className="text-xs text-[var(--text-secondary)] font-normal">
                    ({resultA.decisions.length} decisions)
                  </span>
                </h3>
                <div className="space-y-2">
                  {uniqueA.map((d) => (
                    <DecisionRow
                      key={d.id}
                      decision={d as any}
                      score={d.combined_score}
                      highlight="a"
                    />
                  ))}
                  {showShared &&
                    shared.map((d) => (
                      <DecisionRow
                        key={d.id}
                        decision={d as any}
                        score={d.combined_score}
                        highlight="shared"
                      />
                    ))}
                </div>
              </div>

              {/* Agent B */}
              <div>
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-status-superseded" />
                  {agentB}
                  <span className="text-xs text-[var(--text-secondary)] font-normal">
                    ({resultB.decisions.length} decisions)
                  </span>
                </h3>
                <div className="space-y-2">
                  {uniqueB.map((d) => (
                    <DecisionRow
                      key={d.id}
                      decision={d as any}
                      score={d.combined_score}
                      highlight="b"
                    />
                  ))}
                  {showShared &&
                    shared.map((d) => {
                      const bEntry = resultB.decisions.find(
                        (bd) => bd.id === d.id,
                      );
                      return (
                        <DecisionRow
                          key={d.id}
                          decision={d as any}
                          score={bEntry?.combined_score ?? d.combined_score}
                          highlight="shared"
                        />
                      );
                    })}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Empty state */}
        {!resultA && !resultB && !loading && !error && (
          <div className="text-center py-16">
            <Columns2
              size={32}
              className="mx-auto mb-3 text-[var(--text-tertiary)]"
            />
            <p className="text-sm text-[var(--text-secondary)]">
              Enter two agent names and a task to compare their contexts
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
