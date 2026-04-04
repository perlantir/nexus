import { useState, useEffect } from 'react';
import {
  Zap,
  Loader2,
  ChevronRight,
  ChevronDown,
  Search,
  Users,
  Ban,
  GitBranch,
  AlertTriangle,
} from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useProject } from '../App';
import type { Decision, ImpactResult } from '../types';

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function ImpactAnalysis() {
  const { get, post } = useApi();
  const { projectId } = useProject();

  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [loadingDecisions, setLoadingDecisions] = useState(true);

  const [selectedId, setSelectedId] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);

  const [impact, setImpact] = useState<ImpactResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Tree expand state
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());

  /* ---- Load decisions list --------------------------------------- */
  useEffect(() => {
    let cancelled = false;
    get<Decision[]>(`/api/projects/${projectId}/decisions`)
      .then((data) => {
        if (!cancelled) {
          setDecisions(Array.isArray(data) ? data : []);
          setLoadingDecisions(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoadingDecisions(false);
      });
    return () => {
      cancelled = true;
    };
  }, [get, projectId]);

  /* ---- Filtered for dropdown ------------------------------------- */
  const filteredDecisions = searchTerm
    ? decisions.filter(
        (d) =>
          d.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
          d.id.toLowerCase().includes(searchTerm.toLowerCase()),
      )
    : decisions;

  /* ---- Fetch impact ---------------------------------------------- */
  async function fetchImpact(decisionId: string) {
    setLoading(true);
    setError(null);
    setImpact(null);

    try {
      const data = await get<ImpactResult>(
        `/api/projects/${projectId}/decisions/${decisionId}/impact`,
      );
      setImpact(data);
    } catch (err: any) {
      setError(err.message || 'Failed to load impact analysis');
    } finally {
      setLoading(false);
    }
  }

  function selectDecision(id: string) {
    const d = decisions.find((dec) => dec.id === id);
    setSelectedId(id);
    setSearchTerm(d?.title ?? id);
    setShowDropdown(false);
    fetchImpact(id);
  }

  function toggleNode(id: string) {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /* ---- Tree node component --------------------------------------- */
  function TreeNode({ decision, depth = 0 }: { decision: Decision; depth?: number }) {
    const hasChildren = decision.relationships?.some(
      (r) => r.type === 'depends_on' || r.type === 'blocks',
    );
    const isExpanded = expandedNodes.has(decision.id);

    return (
      <div style={{ paddingLeft: depth * 20 }}>
        <div
          className="flex items-center gap-2 py-1.5 px-2 rounded-md hover:bg-white/[0.03] transition-colors cursor-pointer text-sm"
          onClick={() => hasChildren && toggleNode(decision.id)}
        >
          {hasChildren ? (
            isExpanded ? (
              <ChevronDown
                size={14}
                className="text-[var(--text-secondary)] shrink-0"
              />
            ) : (
              <ChevronRight
                size={14}
                className="text-[var(--text-secondary)] shrink-0"
              />
            )
          ) : (
            <span className="w-3.5 shrink-0" />
          )}
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{
              backgroundColor:
                decision.status === 'active'
                  ? '#01696F'
                  : decision.status === 'superseded'
                    ? '#D19900'
                    : decision.status === 'reverted'
                      ? '#A13544'
                      : '#FFC553',
            }}
          />
          <span className="truncate">{decision.title}</span>
          <span className={`badge badge-${decision.status} text-2xs ml-auto shrink-0`}>
            {decision.status}
          </span>
        </div>

        {isExpanded && decision.relationships && (
          <div className="animate-fade-in">
            {decision.relationships
              .filter((r) => r.type === 'depends_on' || r.type === 'blocks')
              .map((rel) => {
                const child = decisions.find((d) => d.id === rel.target_id);
                if (!child) return null;
                return <TreeNode key={child.id} decision={child} depth={depth + 1} />;
              })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-lg font-semibold mb-1">Impact Analysis</h1>
          <p className="text-sm text-[var(--text-secondary)]">
            Understand the downstream effects of a decision
          </p>
        </div>

        {/* Decision picker */}
        <div className="card p-5 mb-6">
          <label className="text-xs font-medium text-[var(--text-secondary)] mb-1.5 block">
            Select a decision
          </label>
          <div className="relative">
            <Search
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-secondary)] pointer-events-none"
            />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                setShowDropdown(true);
              }}
              onFocus={() => setShowDropdown(true)}
              placeholder={loadingDecisions ? 'Loading decisions…' : 'Search decisions…'}
              className="input pl-9"
              disabled={loadingDecisions}
            />

            {showDropdown && filteredDecisions.length > 0 && (
              <div className="absolute z-20 top-full mt-1 left-0 right-0 max-h-60 overflow-y-auto card shadow-lg animate-fade-in">
                {filteredDecisions.slice(0, 20).map((d) => (
                  <button
                    key={d.id}
                    onClick={() => selectDecision(d.id)}
                    className={`w-full text-left px-3 py-2 text-sm hover:bg-white/[0.03] transition-colors flex items-center justify-between ${
                      selectedId === d.id ? 'bg-primary/10' : ''
                    }`}
                  >
                    <span className="truncate">{d.title}</span>
                    <span className={`badge badge-${d.status} text-2xs shrink-0 ml-2`}>
                      {d.status}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Loading */}
        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={24} className="animate-spin text-primary" />
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="card p-4 mb-6 text-center">
            <p className="text-sm text-status-reverted">{error}</p>
          </div>
        )}

        {/* Impact results */}
        {impact && !loading && (
          <div className="space-y-6 animate-fade-in">
            {/* Selected decision summary */}
            <div className="card p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <span className={`badge badge-${impact.decision.status} mb-1`}>
                    {impact.decision.status}
                  </span>
                  <h3 className="text-sm font-semibold">{impact.decision.title}</h3>
                  <p className="text-xs text-[var(--text-secondary)] mt-1">
                    by {impact.decision.made_by} ·{' '}
                    {new Date(impact.decision.created_at).toLocaleDateString()}
                  </p>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Downstream decisions (tree) */}
              <div className="card p-4">
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                  <GitBranch size={16} className="text-primary" />
                  Downstream Decisions
                  <span className="text-xs text-[var(--text-secondary)] font-normal">
                    ({impact.downstream.length})
                  </span>
                </h3>
                {impact.downstream.length === 0 ? (
                  <p className="text-xs text-[var(--text-secondary)]">
                    No downstream dependencies
                  </p>
                ) : (
                  <div className="space-y-0.5">
                    {impact.downstream.map((d) => (
                      <TreeNode key={d.id} decision={d} />
                    ))}
                  </div>
                )}
              </div>

              {/* Affected agents */}
              <div className="card p-4">
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                  <Users size={16} className="text-primary" />
                  Affected Agents
                  <span className="text-xs text-[var(--text-secondary)] font-normal">
                    ({impact.affected_agents.length})
                  </span>
                </h3>
                {impact.affected_agents.length === 0 ? (
                  <p className="text-xs text-[var(--text-secondary)]">
                    No agents affected
                  </p>
                ) : (
                  <div className="space-y-2">
                    {impact.affected_agents.map((agent, i) => (
                      <div key={i} className="flex items-center gap-2 text-sm">
                        <span className="w-7 h-7 rounded-full bg-primary/15 text-primary flex items-center justify-center text-xs font-medium">
                          {agent.name.charAt(0).toUpperCase()}
                        </span>
                        <span className="font-medium">{agent.name}</span>
                        <span className="badge text-2xs bg-[var(--border-light)]">
                          {agent.role}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Blocking relationships */}
              <div className="card p-4">
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                  <Ban size={16} className="text-status-reverted" />
                  Blocking Relationships
                  <span className="text-xs text-[var(--text-secondary)] font-normal">
                    ({impact.blocking.length})
                  </span>
                </h3>
                {impact.blocking.length === 0 ? (
                  <p className="text-xs text-[var(--text-secondary)]">
                    No blocking relationships
                  </p>
                ) : (
                  <div className="space-y-2">
                    {impact.blocking.map((d) => (
                      <div
                        key={d.id}
                        className="p-2.5 rounded-md bg-status-reverted/5 border border-status-reverted/20 text-sm"
                      >
                        <span className="font-medium">{d.title}</span>
                        <span className={`badge badge-${d.status} text-2xs ml-2`}>{d.status}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Supersession chain */}
              <div className="card p-4">
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                  <Zap size={16} className="text-status-superseded" />
                  Supersession Chain
                  <span className="text-xs text-[var(--text-secondary)] font-normal">
                    ({impact.supersession_chain.length})
                  </span>
                </h3>
                {impact.supersession_chain.length === 0 ? (
                  <p className="text-xs text-[var(--text-secondary)]">
                    No supersession chain
                  </p>
                ) : (
                  <div className="relative">
                    <div className="absolute left-3 top-0 bottom-0 w-px bg-status-superseded/30" />
                    <div className="space-y-3">
                      {impact.supersession_chain.map((d, i) => (
                        <div key={d.id} className="relative pl-8">
                          <div
                            className="absolute left-[7px] top-2 w-2.5 h-2.5 rounded-full border-2"
                            style={{
                              borderColor: '#D19900',
                              backgroundColor: i === 0 ? '#D19900' : 'transparent',
                            }}
                          />
                          <div className="text-sm">
                            <span className="font-medium">{d.title}</span>
                            <div className="text-xs text-[var(--text-secondary)] mt-0.5">
                              {new Date(d.created_at).toLocaleDateString()} ·{' '}
                              <span className={`badge-${d.status} capitalize`}>{d.status}</span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* What-if section */}
            <div className="card p-5">
              <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
                <AlertTriangle size={16} className="text-status-superseded" />
                What if I supersede this?
              </h3>
              <p className="text-xs text-[var(--text-secondary)] mb-3">
                Superseding "{impact.decision.title}" would affect:
              </p>
              <div className="grid grid-cols-3 gap-4">
                <div className="text-center p-3 rounded-md bg-[var(--bg-secondary)]">
                  <p className="text-xl font-bold tabular-nums">{impact.downstream.length}</p>
                  <p className="text-xs text-[var(--text-secondary)]">
                    Downstream decisions
                  </p>
                </div>
                <div className="text-center p-3 rounded-md bg-[var(--bg-secondary)]">
                  <p className="text-xl font-bold tabular-nums">{impact.affected_agents.length}</p>
                  <p className="text-xs text-[var(--text-secondary)]">
                    Agents affected
                  </p>
                </div>
                <div className="text-center p-3 rounded-md bg-[var(--bg-secondary)]">
                  <p className="text-xl font-bold tabular-nums">{impact.blocking.length}</p>
                  <p className="text-xs text-[var(--text-secondary)]">
                    Blocking items
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Initial state */}
        {!impact && !loading && !error && (
          <div className="text-center py-16">
            <Zap
              size={32}
              className="mx-auto mb-3 text-[var(--text-tertiary)]"
            />
            <p className="text-sm text-[var(--text-secondary)]">
              Select a decision to analyze its impact
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
