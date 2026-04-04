import { useEffect, useState } from 'react';
import {
  History,
  Loader2,
  ChevronDown,
  ChevronUp,
  Clock,
  User,
  FileText,
  HelpCircle,
  Lightbulb,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useProject } from '../App';
import type { Session } from '../types';

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

function confidenceLabel(score: number): { label: string; color: string } {
  if (score >= 0.8) return { label: 'High', color: 'text-status-active' };
  if (score >= 0.5) return { label: 'Medium', color: 'text-status-superseded' };
  return { label: 'Low', color: 'text-status-reverted' };
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function SessionHistory() {
  const { get } = useApi();
  const { projectId } = useProject();

  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    get<Session[]>(`/api/projects/${projectId}/sessions`)
      .then((data) => {
        if (!cancelled) {
          setSessions(Array.isArray(data) ? data : []);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || 'Failed to load sessions');
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [get, projectId]);

  function toggleExpand(id: string) {
    setExpanded((prev) => {
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
          <span className="text-sm text-[var(--text-secondary)]">Loading sessions…</span>
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
          <h1 className="text-lg font-semibold mb-1">Sessions</h1>
          <p className="text-sm text-[var(--text-secondary)]">
            History of agent sessions and extracted decisions
          </p>
        </div>

        {/* Session list */}
        {sessions.length === 0 ? (
          <div className="text-center py-12">
            <History
              size={28}
              className="mx-auto mb-2 text-[var(--text-tertiary)]"
            />
            <p className="text-lg font-medium text-[var(--text-secondary)]">
              No sessions yet
            </p>
            <p className="text-sm text-[var(--text-tertiary)] mt-1">
              Sessions appear when agents report summaries via the distillery API
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {sessions
              .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
              .map((session) => {
                const isExpanded = expanded.has(session.id);
                const conf = session.extraction_confidence
                  ? confidenceLabel(session.extraction_confidence)
                  : null;

                return (
                  <div key={session.id} className="card overflow-hidden animate-slide-up">
                    {/* Summary row */}
                    <button
                      onClick={() => toggleExpand(session.id)}
                      className="w-full text-left p-4 hover:bg-white/[0.02] transition-colors"
                    >
                      <div className="flex items-start justify-between gap-3 mb-2">
                        <div className="flex-1 min-w-0">
                          <h3 className="text-sm font-semibold truncate">{session.topic}</h3>
                          <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--text-secondary)] mt-1">
                            <span className="flex items-center gap-1">
                              <User size={12} />
                              {session.agent_name}
                            </span>
                            <span className="flex items-center gap-1">
                              <Clock size={12} />
                              {formatDate(session.started_at)}
                            </span>
                            <span className="flex items-center gap-1">
                              <FileText size={12} />
                              {session.decisions_extracted} decision
                              {session.decisions_extracted !== 1 ? 's' : ''}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {conf && (
                            <span className={`text-xs font-medium ${conf.color}`}>
                              {conf.label}
                            </span>
                          )}
                          {isExpanded ? (
                            <ChevronUp
                              size={14}
                              className="text-[var(--text-secondary)]"
                            />
                          ) : (
                            <ChevronDown
                              size={14}
                              className="text-[var(--text-secondary)]"
                            />
                          )}
                        </div>
                      </div>

                      {/* Confidence indicator */}
                      {session.extraction_confidence !== undefined && (
                        <div className="mt-2">
                          <div className="w-full h-1 rounded-full bg-[var(--border-light)] overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all duration-500"
                              style={{
                                width: `${session.extraction_confidence * 100}%`,
                                backgroundColor:
                                  session.extraction_confidence >= 0.8
                                    ? '#01696F'
                                    : session.extraction_confidence >= 0.5
                                      ? '#D19900'
                                      : '#A13544',
                              }}
                            />
                          </div>
                          <span className="text-2xs text-[var(--text-tertiary)] mt-0.5 block">
                            Extraction confidence:{' '}
                            {(session.extraction_confidence * 100).toFixed(0)}%
                          </span>
                        </div>
                      )}
                    </button>

                    {/* Expanded detail */}
                    {isExpanded && (
                      <div className="px-4 pb-4 pt-2 border-t border-[var(--border-light)] animate-fade-in">
                        <div className="space-y-4 text-sm">
                          {/* Summary */}
                          {session.summary && (
                            <div>
                              <label className="text-xs font-medium text-[var(--text-secondary)] mb-1 block flex items-center gap-1.5">
                                <FileText size={12} />
                                Summary
                              </label>
                              <p className="leading-relaxed">{session.summary}</p>
                            </div>
                          )}

                          {/* Decision IDs */}
                          {session.decision_ids && session.decision_ids.length > 0 && (
                            <div>
                              <label className="text-xs font-medium text-[var(--text-secondary)] mb-1 block flex items-center gap-1.5">
                                <CheckCircle2 size={12} />
                                Extracted Decisions
                              </label>
                              <div className="flex flex-wrap gap-1.5">
                                {session.decision_ids.map((id) => (
                                  <span
                                    key={id}
                                    className="px-2 py-0.5 text-xs rounded bg-primary/10 text-primary font-mono"
                                  >
                                    {id.length > 12 ? id.slice(0, 10) + '…' : id}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Assumptions */}
                          {session.assumptions && session.assumptions.length > 0 && (
                            <div>
                              <label className="text-xs font-medium text-[var(--text-secondary)] mb-1 block flex items-center gap-1.5">
                                <AlertCircle size={12} />
                                Assumptions
                              </label>
                              <ul className="list-disc pl-4 space-y-1">
                                {session.assumptions.map((a, i) => (
                                  <li key={i}>{a}</li>
                                ))}
                              </ul>
                            </div>
                          )}

                          {/* Open questions */}
                          {session.open_questions && session.open_questions.length > 0 && (
                            <div>
                              <label className="text-xs font-medium text-[var(--text-secondary)] mb-1 block flex items-center gap-1.5">
                                <HelpCircle size={12} />
                                Open Questions
                              </label>
                              <ul className="list-disc pl-4 space-y-1">
                                {session.open_questions.map((q, i) => (
                                  <li key={i}>{q}</li>
                                ))}
                              </ul>
                            </div>
                          )}

                          {/* Lessons learned */}
                          {session.lessons_learned && session.lessons_learned.length > 0 && (
                            <div>
                              <label className="text-xs font-medium text-[var(--text-secondary)] mb-1 block flex items-center gap-1.5">
                                <Lightbulb size={12} />
                                Lessons Learned
                              </label>
                              <ul className="list-disc pl-4 space-y-1">
                                {session.lessons_learned.map((l, i) => (
                                  <li key={i}>{l}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        )}
      </div>
    </div>
  );
}
