import { useEffect, useState } from 'react';
import {
  Clock,
  User,
  Tag,
  ChevronDown,
  ChevronUp,
  ArrowRight,
  Loader2,
  Calendar,
} from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useProject } from '../App';
import type { Decision, DecisionStatus } from '../types';

/* ------------------------------------------------------------------ */
/*  Validation sub-component                                           */
/* ------------------------------------------------------------------ */

const VALIDATION_SOURCES = ['manual_review', 'test_passed', 'production_verified', 'peer_reviewed', 'external'] as const;

function ValidationControls({
  decision,
  onUpdate,
}: {
  decision: Decision;
  onUpdate: () => void;
}) {
  const { post } = useApi();
  const [showValidate, setShowValidate] = useState(false);
  const [showInvalidate, setShowInvalidate] = useState(false);
  const [source, setSource] = useState<string>('manual_review');
  const [reason, setReason] = useState('');

  const isValidated = !!decision.validated_at;

  const handleValidate = async () => {
    await post(`/api/decisions/${decision.id}/validate`, { validation_source: source });
    setShowValidate(false);
    onUpdate();
  };

  const handleInvalidate = async () => {
    await post(`/api/decisions/${decision.id}/invalidate`, { reason: reason || undefined });
    setShowInvalidate(false);
    setReason('');
    onUpdate();
  };

  return (
    <div className="mt-2 pt-2 border-t border-[var(--border-light)]">
      {/* Status display */}
      <div className="flex items-center gap-2 mb-2 text-xs">
        {isValidated ? (
          <span className="flex items-center gap-1 text-green-400">
            <span>\u2705</span>
            Validated via {decision.validation_source?.replace(/_/g, ' ')}
            {decision.validated_at && (
              <span className="text-[var(--text-secondary)] ml-1">
                on {new Date(decision.validated_at).toLocaleDateString()}
              </span>
            )}
          </span>
        ) : (
          <span className="flex items-center gap-1 text-[var(--text-secondary)]">
            <span>\u23F3</span> Not yet validated
          </span>
        )}
      </div>

      {/* Action buttons */}
      {decision.status === 'active' && (
        <div className="flex gap-2">
          {!showValidate && !showInvalidate && (
            <>
              <button
                onClick={() => setShowValidate(true)}
                className="px-2 py-1 rounded text-2xs bg-green-500/10 text-green-400 hover:bg-green-500/20"
              >
                Validate
              </button>
              {isValidated && (
                <button
                  onClick={() => setShowInvalidate(true)}
                  className="px-2 py-1 rounded text-2xs bg-red-500/10 text-red-400 hover:bg-red-500/20"
                >
                  Invalidate
                </button>
              )}
            </>
          )}

          {showValidate && (
            <div className="flex items-center gap-2">
              <select
                value={source}
                onChange={(e) => setSource(e.target.value)}
                className="px-2 py-1 rounded text-2xs bg-[var(--bg-secondary)] border border-[var(--border-light)]"
              >
                {VALIDATION_SOURCES.map((s) => (
                  <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
                ))}
              </select>
              <button onClick={handleValidate} className="px-2 py-1 rounded text-2xs bg-green-500/20 text-green-400">Confirm</button>
              <button onClick={() => setShowValidate(false)} className="px-2 py-1 rounded text-2xs bg-[var(--bg-hover)]">Cancel</button>
            </div>
          )}

          {showInvalidate && (
            <div className="flex items-center gap-2">
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Reason (optional)"
                className="px-2 py-1 rounded text-2xs bg-[var(--bg-secondary)] border border-[var(--border-light)] w-48"
              />
              <button onClick={handleInvalidate} className="px-2 py-1 rounded text-2xs bg-red-500/20 text-red-400">Confirm</button>
              <button onClick={() => setShowInvalidate(false)} className="px-2 py-1 rounded text-2xs bg-[var(--bg-hover)]">Cancel</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function statusBadgeClass(status: DecisionStatus) {
  return `badge badge-${status}`;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function Timeline() {
  const { get } = useApi();
  const { projectId } = useProject();

  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [filterAgent, setFilterAgent] = useState('');
  const [filterTag, setFilterTag] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // Expanded supersession chains
  const [expandedChains, setExpandedChains] = useState<Set<string>>(new Set());

  const refreshDecisions = () => {
    get<Decision[]>(`/api/projects/${projectId}/decisions`)
      .then((data) => setDecisions(Array.isArray(data) ? data : []))
      .catch(() => {});
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    get<Decision[]>(`/api/projects/${projectId}/decisions`)
      .then((data) => {
        if (!cancelled) {
          setDecisions(Array.isArray(data) ? data : []);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || 'Failed to load decisions');
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [get, projectId]);

  const agents = Array.from(new Set(decisions.map((d) => d.made_by)));
  const allTags = Array.from(new Set(decisions.flatMap((d) => d.tags)));

  /* ---- Filtering ------------------------------------------------- */
  const filtered = decisions
    .filter((d) => {
      if (filterAgent && d.made_by !== filterAgent) return false;
      if (filterTag && !d.tags.includes(filterTag)) return false;
      if (dateFrom && d.made_at < dateFrom) return false;
      if (dateTo && d.made_at > dateTo) return false;
      return true;
    })
    .sort((a, b) => new Date(b.made_at).getTime() - new Date(a.made_at).getTime());

  /* ---- Supersession chains --------------------------------------- */
  function getChain(decision: Decision): Decision[] {
    const chain: Decision[] = [];
    let current: Decision | undefined = decision;
    while (current?.supersedes) {
      const parent = decisions.find((d) => d.id === current!.supersedes);
      if (parent && !chain.find((c) => c.id === parent.id)) {
        chain.push(parent);
        current = parent;
      } else break;
    }
    return chain;
  }

  function hasContradiction(decision: Decision): boolean {
    return decision.relationships?.some((r) => r.type === 'conflicts_with') ?? false;
  }

  function toggleChain(id: string) {
    setExpandedChains((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /* ---- Loading / Error ------------------------------------------- */
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3">
          <Loader2 size={24} className="animate-spin text-primary" />
          <span className="text-sm text-[var(--text-secondary)]">Loading timeline…</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="card p-6 max-w-md text-center">
          <p className="text-sm text-status-reverted">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-lg font-semibold mb-1">Timeline</h1>
          <p className="text-sm text-[var(--text-secondary)]">
            Chronological view of all decisions
          </p>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3 mb-6">
          <select
            value={filterAgent}
            onChange={(e) => setFilterAgent(e.target.value)}
            className="input w-auto min-w-[140px] text-xs"
          >
            <option value="">All agents</option>
            {agents.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>

          <select
            value={filterTag}
            onChange={(e) => setFilterTag(e.target.value)}
            className="input w-auto min-w-[140px] text-xs"
          >
            <option value="">All tags</option>
            {allTags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>

          <div className="flex items-center gap-2 text-xs">
            <Calendar
              size={14}
              className="text-[var(--text-secondary)]"
            />
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="input w-auto text-xs"
              placeholder="From"
            />
            <span className="text-[var(--text-secondary)]">to</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="input w-auto text-xs"
              placeholder="To"
            />
          </div>
        </div>

        {/* Timeline */}
        {filtered.length === 0 ? (
          <div className="text-center py-12">
            <Clock
              size={28}
              className="mx-auto mb-2 text-[var(--text-tertiary)]"
            />
            <p className="text-sm text-[var(--text-secondary)]">
              No decisions match the current filters
            </p>
          </div>
        ) : (
          <div className="relative">
            {/* Vertical line */}
            <div className="absolute left-5 top-0 bottom-0 w-px bg-[var(--border-light)]" />

            <div className="space-y-4">
              {filtered.map((decision) => {
                const chain = getChain(decision);
                const isContradiction = hasContradiction(decision);
                const isExpanded = expandedChains.has(decision.id);

                return (
                  <div key={decision.id} className="relative pl-12">
                    {/* Dot on timeline */}
                    <div
                      className="absolute left-[14px] top-5 w-3 h-3 rounded-full border-2 border-[var(--border-light)]"
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

                    {/* Card */}
                    <div
                      className={`card p-4 transition-shadow hover:shadow-sm ${
                        isContradiction ? 'ring-1 ring-status-reverted/40' : ''
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3 mb-2">
                        <h3 className="text-sm font-semibold leading-snug flex-1">
                          {decision.title}
                        </h3>
                        {decision.validated_at && (
                          <span className="text-green-400 text-xs" title={`Validated: ${decision.validation_source}`}>\u2705</span>
                        )}
                        <span className={statusBadgeClass(decision.status)}>{decision.status}</span>
                      </div>

                      <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--text-secondary)] mb-2">
                        <span className="flex items-center gap-1">
                          <User size={12} />
                          {decision.made_by}
                        </span>
                        <span className="flex items-center gap-1">
                          <Clock size={12} />
                          {formatDate(decision.made_at)}
                        </span>
                      </div>

                      {/* Tags */}
                      {decision.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mb-2">
                          {decision.tags.map((tag) => (
                            <span
                              key={tag}
                              className="flex items-center gap-1 px-2 py-0.5 text-2xs rounded-full bg-primary/10 text-primary"
                            >
                              <Tag size={10} />
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Contradiction warning */}
                      {isContradiction && (
                        <p className="text-xs text-status-reverted mt-1">
                          ⚠ This decision has conflicts
                        </p>
                      )}

                      {/* Supersession chain */}
                      {chain.length > 0 && (
                        <div className="mt-3 pt-3 border-t border-[var(--border-light)]">
                          <button
                            onClick={() => toggleChain(decision.id)}
                            className="flex items-center gap-1.5 text-xs text-primary hover:text-primary-hover transition-colors"
                          >
                            <ArrowRight size={12} />
                            Supersedes {chain.length} decision{chain.length > 1 ? 's' : ''}
                            {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                          </button>

                          {isExpanded && (
                            <div className="mt-2 ml-4 space-y-2 animate-fade-in">
                              {chain.map((prev) => (
                                <div
                                  key={prev.id}
                                  className="p-3 rounded-md bg-[var(--bg-secondary)] text-xs"
                                >
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="font-medium">{prev.title}</span>
                                    <span className={statusBadgeClass(prev.status)}>
                                      {prev.status}
                                    </span>
                                  </div>
                                  <span className="text-[var(--text-secondary)] mt-1 block">
                                    {formatDate(prev.made_at)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Validation controls */}
                      <ValidationControls decision={decision} onUpdate={refreshDecisions} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
