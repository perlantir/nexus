import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  X,
  Loader2,
  ArrowRight,
  MessageSquare,
  ShieldAlert,
  Info,
} from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useProject } from '../App';
import type { Contradiction, Decision } from '../types';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type TabFilter = 'unresolved' | 'resolved' | 'dismissed';

type ResolveMode = 'win' | 'not_conflict';

/* ------------------------------------------------------------------ */
/*  Severity helpers                                                    */
/* ------------------------------------------------------------------ */

/** Derive severity from similarity score: ≥0.85 = critical, else warning */
function getSeverity(score: number): 'critical' | 'warning' {
  return score >= 0.85 ? 'critical' : 'warning';
}

function SeverityIcon({ score }: { score: number }) {
  const sev = getSeverity(score);
  if (sev === 'critical') {
    return (
      <span title="Critical contradiction" className="shrink-0">
        <AlertTriangle size={15} className="text-red-400" />
      </span>
    );
  }
  return (
    <span title="Warning contradiction" className="shrink-0">
      <AlertTriangle size={15} className="text-yellow-400" />
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function Contradictions() {
  const { get, post, patch } = useApi();
  const { projectId } = useProject();

  const [contradictions, setContradictions] = useState<Contradiction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabFilter>('unresolved');

  // Resolve modal state
  const [resolving, setResolving] = useState<Contradiction | null>(null);
  const [resolveMode, setResolveMode] = useState<ResolveMode>('win');
  const [keepDecision, setKeepDecision] = useState<'a' | 'b' | ''>('');
  const [resolution, setResolution] = useState('');
  const [resolutionNotes, setResolutionNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    get<Contradiction[]>(`/api/projects/${projectId}/contradictions`)
      .then((data) => {
        if (!cancelled) {
          setContradictions(Array.isArray(data) ? data : []);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err?.message ?? 'Failed to load contradictions');
          setError(msg);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [get, projectId]);

  const filtered = (contradictions ?? []).filter((c) => c.status === tab);

  const counts = {
    unresolved: (contradictions ?? []).filter((c) => c.status === 'unresolved').length,
    resolved: (contradictions ?? []).filter((c) => c.status === 'resolved').length,
    dismissed: (contradictions ?? []).filter((c) => c.status === 'dismissed').length,
  };

  /* ---- Actions --------------------------------------------------- */

  async function handleDismiss(id: string) {
    try {
      await patch(`/api/projects/${projectId}/contradictions/${id}`, {
        status: 'dismissed',
      });
      setContradictions((prev) =>
        prev.map((c) => (c.id === id ? { ...c, status: 'dismissed' as const } : c)),
      );
    } catch {
      // Silently fail — could add toast here
    }
  }

  function openResolveModal(contradiction: Contradiction) {
    setResolving(contradiction);
    setResolveMode('win');
    setKeepDecision('');
    setResolution('');
    setResolutionNotes('');
  }

  async function handleResolve() {
    if (!resolving) return;

    if (resolveMode === 'win' && (!keepDecision || !resolution)) return;
    if (resolveMode === 'not_conflict' && !resolutionNotes) return;

    setSubmitting(true);
    try {
      if (resolveMode === 'not_conflict') {
        await post(
          `/api/projects/${projectId}/contradictions/${resolving.id}/resolve`,
          {
            not_a_conflict: true,
            resolution: resolutionNotes,
          },
        );
        setContradictions((prev) =>
          prev.map((c) =>
            c.id === resolving.id
              ? { ...c, status: 'dismissed' as const, resolution: resolutionNotes }
              : c,
          ),
        );
      } else {
        await post(`/api/projects/${projectId}/contradictions/${resolving.id}/resolve`, {
          keep_decision: keepDecision === 'a' ? resolving.decision_a_id : resolving.decision_b_id,
          resolution,
          notes: resolutionNotes || undefined,
        });
        setContradictions((prev) =>
          prev.map((c) =>
            c.id === resolving.id ? { ...c, status: 'resolved' as const, resolution } : c,
          ),
        );
      }
      setResolving(null);
    } catch {
      // Silently fail
    } finally {
      setSubmitting(false);
    }
  }

  /* ---- Decision card helper -------------------------------------- */

  function DecisionCard({
    decision,
    label,
    selected,
    onSelect,
  }: {
    decision?: Decision;
    label: string;
    selected?: boolean;
    onSelect?: () => void;
  }) {
    if (!decision) {
      return (
        <div className="card p-4 flex-1">
          <p className="text-xs text-[var(--text-secondary)]">
            {label} — decision data unavailable
          </p>
        </div>
      );
    }
    return (
      <div
        onClick={onSelect}
        className={`card p-4 flex-1 transition-all ${
          onSelect ? 'cursor-pointer hover:shadow-sm' : ''
        } ${selected ? 'ring-2 ring-primary' : ''}`}
      >
        <div className="flex items-center justify-between mb-2">
          <span className="text-2xs font-medium uppercase tracking-wider text-[var(--text-secondary)]">
            {label}
          </span>
          <span className={`badge badge-${decision.status}`}>{decision.status}</span>
        </div>
        <h4 className="text-sm font-semibold mb-1">{decision.title}</h4>
        <p className="text-xs text-[var(--text-secondary)] leading-relaxed line-clamp-3">
          {decision.description}
        </p>
        <p className="text-2xs text-[var(--text-tertiary)] mt-2">
          by {decision.made_by} · {new Date(decision.created_at).toLocaleDateString()}
        </p>
      </div>
    );
  }

  /* ---- Loading / Error ------------------------------------------- */

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3">
          <Loader2 size={24} className="animate-spin text-primary" />
          <span className="text-sm text-[var(--text-secondary)]">Loading contradictions…</span>
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

  // Flag contradiction modal state
  const [showFlagModal, setShowFlagModal] = useState(false);
  const [flagDecisionA, setFlagDecisionA] = useState('');
  const [flagDecisionB, setFlagDecisionB] = useState('');
  const [flagDescription, setFlagDescription] = useState('');
  const [flagSubmitting, setFlagSubmitting] = useState(false);

  async function handleFlagContradiction() {
    if (!flagDecisionA || !flagDecisionB || !flagDescription) return;
    setFlagSubmitting(true);
    try {
      const created = await post<Contradiction>(`/api/projects/${projectId}/contradictions`, {
        decision_a_id: flagDecisionA,
        decision_b_id: flagDecisionB,
        conflict_description: flagDescription,
      });
      setContradictions((prev) => [...prev, created]);
      setShowFlagModal(false);
      setFlagDecisionA('');
      setFlagDecisionB('');
      setFlagDescription('');
    } catch {
      // silent
    } finally {
      setFlagSubmitting(false);
    }
  }

  const unresolvedCritical = (contradictions ?? []).filter(
    (c) => c.status === 'unresolved' && getSeverity(c.similarity_score) === 'critical',
  ).length;

  const unresolvedWarning = (contradictions ?? []).filter(
    (c) => c.status === 'unresolved' && getSeverity(c.similarity_score) === 'warning',
  ).length;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-lg font-semibold mb-1">Contradictions</h1>
            <p className="text-sm text-[var(--text-secondary)]">
              Conflicting decisions that need resolution
            </p>
          </div>
          <button
            onClick={() => setShowFlagModal(true)}
            className="btn-primary text-xs flex items-center gap-1.5"
          >
            <AlertTriangle size={14} />
            Flag Contradiction
          </button>
        </div>

        {/* ---- Alert banner: unresolved contradictions exist ------- */}
        {counts.unresolved > 0 && (
          <div
            className={`flex items-start gap-3 p-4 rounded-lg border mb-6 ${
              unresolvedCritical > 0
                ? 'bg-red-500/8 border-red-500/30'
                : 'bg-yellow-500/8 border-yellow-500/30'
            }`}
          >
            <ShieldAlert
              size={18}
              className={`shrink-0 mt-0.5 ${unresolvedCritical > 0 ? 'text-red-400' : 'text-yellow-400'}`}
            />
            <div>
              <p
                className={`text-sm font-semibold mb-0.5 ${
                  unresolvedCritical > 0 ? 'text-red-300' : 'text-yellow-300'
                }`}
              >
                {counts.unresolved} unresolved contradiction
                {counts.unresolved !== 1 ? 's' : ''} require attention
              </p>
              <p className="text-xs text-[var(--text-secondary)]">
                {unresolvedCritical > 0 && (
                  <span className="text-red-400 font-medium">
                    {unresolvedCritical} critical
                  </span>
                )}
                {unresolvedCritical > 0 && unresolvedWarning > 0 && ' · '}
                {unresolvedWarning > 0 && (
                  <span className="text-yellow-400 font-medium">
                    {unresolvedWarning} warning
                  </span>
                )}
                {' '}— unresolved conflicts may lead agents to receive inconsistent context.
              </p>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="flex items-center gap-1 mb-6 border-b border-[var(--border-light)]">
          {(['unresolved', 'resolved', 'dismissed'] as TabFilter[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors capitalize ${
                tab === t
                  ? 'border-primary text-primary'
                  : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              {t}
              <span className="ml-1.5 text-xs opacity-60">({counts[t]})</span>
            </button>
          ))}
        </div>

        {/* List */}
        {filtered.length === 0 ? (
          <div className="text-center py-12">
            <AlertTriangle
              size={28}
              className="mx-auto mb-2 text-[var(--text-tertiary)]"
            />
            <p className="text-lg font-medium text-[var(--text-secondary)]">
              {contradictions.length === 0 ? 'No contradictions detected' : `No ${tab} contradictions`}
            </p>
            {contradictions.length === 0 && (
              <p className="text-sm text-[var(--text-tertiary)] mt-1">
                Contradictions are flagged when two active decisions conflict.
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-6">
            {filtered.map((contradiction) => {
              const severity = getSeverity(contradiction.similarity_score);
              return (
                <div key={contradiction.id} className="card p-5 animate-slide-up">
                  {/* Severity label */}
                  <div className="flex items-center gap-2 mb-3">
                    <SeverityIcon score={contradiction.similarity_score} />
                    <span
                      className={`text-xs font-semibold uppercase tracking-wider ${
                        severity === 'critical' ? 'text-red-400' : 'text-yellow-400'
                      }`}
                    >
                      {severity}
                    </span>
                  </div>

                  {/* Side-by-side decisions */}
                  <div className="flex gap-4 mb-4">
                    <DecisionCard decision={contradiction.decision_a} label="Decision A" />
                    <div className="flex items-center shrink-0">
                      <ArrowRight
                        size={16}
                        className="text-[var(--text-tertiary)] rotate-90 sm:rotate-0"
                      />
                    </div>
                    <DecisionCard decision={contradiction.decision_b} label="Decision B" />
                  </div>

                  {/* Similarity score */}
                  <div className="mb-3">
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-[var(--text-secondary)]">
                        Similarity Score
                      </span>
                      <span className="font-medium">
                        {(contradiction.similarity_score * 100).toFixed(0)}%
                      </span>
                    </div>
                    <div className="w-full h-1.5 rounded-full bg-[var(--border-light)] overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${
                          severity === 'critical' ? 'bg-red-400' : 'bg-yellow-400'
                        }`}
                        style={{ width: `${contradiction.similarity_score * 100}%` }}
                      />
                    </div>
                  </div>

                  {/* Conflict description */}
                  <div className="flex items-start gap-2 mb-3">
                    <MessageSquare
                      size={14}
                      className="shrink-0 mt-0.5 text-[var(--text-secondary)]"
                    />
                    <p className="text-sm leading-relaxed">{contradiction.conflict_description}</p>
                  </div>

                  {/* LLM explanation / resolution suggestion */}
                  {(contradiction as unknown as {
                    explanation?: string;
                    resolution_suggestion?: string;
                  }).explanation && (
                    <div className="flex items-start gap-2 p-3 rounded-md bg-[var(--border-light)]/20 mb-3">
                      <Info
                        size={13}
                        className="shrink-0 mt-0.5 text-[var(--text-secondary)]"
                      />
                      <div>
                        <p className="text-xs font-medium text-[var(--text-secondary)] mb-0.5">
                          AI Analysis
                        </p>
                        <p className="text-xs leading-relaxed">
                          {(contradiction as unknown as { explanation: string }).explanation}
                        </p>
                      </div>
                    </div>
                  )}
                  {(contradiction as unknown as { resolution_suggestion?: string })
                    .resolution_suggestion && (
                    <div className="flex items-start gap-2 p-3 rounded-md bg-primary/8 border border-primary/15 mb-3">
                      <Info size={13} className="shrink-0 mt-0.5 text-primary" />
                      <div>
                        <p className="text-xs font-medium text-primary mb-0.5">
                          Suggested resolution
                        </p>
                        <p className="text-xs leading-relaxed">
                          {
                            (contradiction as unknown as { resolution_suggestion: string })
                              .resolution_suggestion
                          }
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Resolution (if resolved) */}
                  {contradiction.resolution && (
                    <div className="p-3 rounded-md bg-status-active/10 text-sm mb-4">
                      <span className="text-xs font-medium text-primary block mb-1">
                        Resolution
                      </span>
                      {contradiction.resolution}
                    </div>
                  )}

                  {/* Actions (unresolved only) */}
                  {contradiction.status === 'unresolved' && (
                    <div className="flex items-center gap-2 pt-2">
                      <button
                        onClick={() => openResolveModal(contradiction)}
                        className="btn-primary text-xs"
                      >
                        <Check size={14} />
                        Resolve
                      </button>
                      <button
                        onClick={() => handleDismiss(contradiction.id)}
                        className="btn-secondary text-xs"
                      >
                        <X size={14} />
                        Dismiss
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ---- Flag contradiction modal -------------------------------- */}
      {showFlagModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in p-4">
          <div className="card p-6 w-full max-w-lg animate-slide-up">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold">Flag Contradiction</h3>
              <button onClick={() => setShowFlagModal(false)} className="btn-ghost p-1">
                <X size={16} />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium mb-1.5 uppercase tracking-wider text-[var(--text-secondary)]">
                  Decision A ID <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={flagDecisionA}
                  onChange={(e) => setFlagDecisionA(e.target.value)}
                  placeholder="UUID of first decision"
                  className="input w-full"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1.5 uppercase tracking-wider text-[var(--text-secondary)]">
                  Decision B ID <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={flagDecisionB}
                  onChange={(e) => setFlagDecisionB(e.target.value)}
                  placeholder="UUID of second decision"
                  className="input w-full"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1.5 uppercase tracking-wider text-[var(--text-secondary)]">
                  Conflict Description <span className="text-red-400">*</span>
                </label>
                <textarea
                  value={flagDescription}
                  onChange={(e) => setFlagDescription(e.target.value)}
                  placeholder="Describe why these decisions conflict…"
                  className="input min-h-[80px] resize-y w-full"
                  rows={3}
                />
              </div>
            </div>
            <div className="flex items-center gap-2 justify-end mt-5">
              <button onClick={() => setShowFlagModal(false)} className="btn-secondary text-xs">
                Cancel
              </button>
              <button
                onClick={handleFlagContradiction}
                disabled={!flagDecisionA || !flagDecisionB || !flagDescription || flagSubmitting}
                className="btn-primary text-xs"
              >
                {flagSubmitting ? <Loader2 size={14} className="animate-spin" /> : <AlertTriangle size={14} />}
                Flag
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- Resolve modal ---------------------------------------- */}
      {resolving && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in p-4">
          <div className="card p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto animate-slide-up">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold">Resolve Contradiction</h3>
              <button onClick={() => setResolving(null)} className="btn-ghost p-1">
                <X size={16} />
              </button>
            </div>

            {/* Mode toggle */}
            <div className="flex gap-2 mb-5">
              <button
                onClick={() => setResolveMode('win')}
                className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-all border ${
                  resolveMode === 'win'
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-[var(--border-light)] text-[var(--text-secondary)] hover:border-primary/40'
                }`}
              >
                One decision wins
              </button>
              <button
                onClick={() => setResolveMode('not_conflict')}
                className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-all border ${
                  resolveMode === 'not_conflict'
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-[var(--border-light)] text-[var(--text-secondary)] hover:border-primary/40'
                }`}
              >
                Not a conflict
              </button>
            </div>

            {/* LLM suggestion if available */}
            {(resolving as unknown as { resolution_suggestion?: string }).resolution_suggestion && (
              <div className="flex items-start gap-2 p-3 rounded-md bg-primary/8 border border-primary/15 mb-4">
                <Info size={13} className="shrink-0 mt-0.5 text-primary" />
                <div>
                  <p className="text-xs font-medium text-primary mb-0.5">Suggested resolution</p>
                  <p className="text-xs leading-relaxed">
                    {(resolving as unknown as { resolution_suggestion: string }).resolution_suggestion}
                  </p>
                </div>
              </div>
            )}

            {resolveMode === 'win' ? (
              <>
                <p className="text-sm text-[var(--text-secondary)] mb-4">
                  Select which decision supersedes the other.
                </p>

                {/* Pick decision */}
                <div className="flex gap-3 mb-4">
                  <DecisionCard
                    decision={resolving.decision_a}
                    label="Decision A"
                    selected={keepDecision === 'a'}
                    onSelect={() => setKeepDecision('a')}
                  />
                  <DecisionCard
                    decision={resolving.decision_b}
                    label="Decision B"
                    selected={keepDecision === 'b'}
                    onSelect={() => setKeepDecision('b')}
                  />
                </div>

                {/* Resolution rationale */}
                <label className="block text-xs font-medium mb-1.5 uppercase tracking-wider text-[var(--text-secondary)]">
                  Resolution rationale <span className="text-red-400">*</span>
                </label>
                <textarea
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value)}
                  placeholder="Explain why this decision takes precedence…"
                  className="input min-h-[80px] resize-y mb-3"
                  rows={3}
                />

                {/* Optional notes */}
                <label className="block text-xs font-medium mb-1.5 uppercase tracking-wider text-[var(--text-secondary)]">
                  Additional notes <span className="opacity-50">(optional)</span>
                </label>
                <textarea
                  value={resolutionNotes}
                  onChange={(e) => setResolutionNotes(e.target.value)}
                  placeholder="Any additional context or caveats…"
                  className="input resize-y mb-4"
                  rows={2}
                />

                <div className="flex items-center gap-2 justify-end">
                  <button onClick={() => setResolving(null)} className="btn-secondary text-xs">
                    Cancel
                  </button>
                  <button
                    onClick={handleResolve}
                    disabled={!keepDecision || !resolution || submitting}
                    className="btn-primary text-xs"
                  >
                    {submitting ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Check size={14} />
                    )}
                    Confirm Resolution
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm text-[var(--text-secondary)] mb-4">
                  Explain why these decisions don't actually conflict.
                </p>

                <label className="block text-xs font-medium mb-1.5 uppercase tracking-wider text-[var(--text-secondary)]">
                  Explanation <span className="text-red-400">*</span>
                </label>
                <textarea
                  value={resolutionNotes}
                  onChange={(e) => setResolutionNotes(e.target.value)}
                  placeholder="Explain why this is not a real conflict…"
                  className="input min-h-[100px] resize-y mb-4"
                  rows={4}
                  autoFocus
                />

                <div className="flex items-center gap-2 justify-end">
                  <button onClick={() => setResolving(null)} className="btn-secondary text-xs">
                    Cancel
                  </button>
                  <button
                    onClick={handleResolve}
                    disabled={!resolutionNotes || submitting}
                    className="btn-primary text-xs"
                  >
                    {submitting ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Check size={14} />
                    )}
                    Mark as Not a Conflict
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
