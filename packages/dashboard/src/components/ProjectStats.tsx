import { useEffect, useState } from 'react';
import {
  BarChart3,
  TrendingUp,
  AlertTriangle,
  Users,
  FileText,
  Clock,
  Loader2,
  Activity,
  Download,
} from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useProject } from '../App';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface AgentDecisionCount {
  agent: string;
  count: number;
}

interface ActivityItem {
  id: string;
  type: string;
  description: string;
  timestamp: string;
  agent?: string;
}

interface TrendPoint {
  date: string;
  count: number;
}

interface ProjectStatsData {
  total_decisions: number;
  by_status: {
    active: number;
    superseded: number;
    reverted: number;
    pending: number;
  };
  decisions_per_agent: AgentDecisionCount[];
  unresolved_contradictions: number;
  total_agents: number;
  total_artifacts: number;
  total_sessions: number;
  recent_activity: ActivityItem[];
  decision_trend: TrendPoint[];
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatTime(iso: string) {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

const STATUS_COLORS: Record<string, { bg: string; text: string; bar: string }> = {
  active: { bg: 'bg-status-active/10', text: 'text-status-active', bar: 'bg-status-active' },
  superseded: {
    bg: 'bg-status-superseded/10',
    text: 'text-status-superseded',
    bar: 'bg-status-superseded',
  },
  reverted: {
    bg: 'bg-status-reverted/10',
    text: 'text-status-reverted',
    bar: 'bg-status-reverted',
  },
  pending: {
    bg: 'bg-status-pending/10',
    text: 'text-status-pending',
    bar: 'bg-status-pending',
  },
};

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function StatCard({
  label,
  value,
  icon,
  sub,
  warn,
}: {
  label: string;
  value: number | string;
  icon: React.ReactNode;
  sub?: string;
  warn?: boolean;
}) {
  return (
    <div
      className={`card p-4 flex items-start gap-3 ${warn ? 'ring-1 ring-status-reverted/40' : ''}`}
    >
      <div
        className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
          warn ? 'bg-status-reverted/10' : 'bg-primary/10'
        }`}
      >
        <span className={warn ? 'text-status-reverted' : 'text-primary'}>{icon}</span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-2xs text-[var(--text-secondary)] uppercase tracking-wide mb-0.5">
          {label}
        </p>
        <p
          className={`text-xl font-semibold tabular-nums leading-tight ${
            warn && typeof value === 'number' && value > 0 ? 'text-status-reverted' : ''
          }`}
        >
          {value}
        </p>
        {sub && <p className="text-2xs text-[var(--text-tertiary)] mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function ProjectStats() {
  const { get } = useApi();
  const { projectId } = useProject();

  const [stats, setStats] = useState<ProjectStatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    get<ProjectStatsData>(`/api/projects/${projectId}/stats`)
      .then((data) => {
        if (!cancelled) {
          setStats(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || 'Failed to load project stats');
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [get, projectId]);

  /* ---- Loading ---------------------------------------------------- */
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3">
          <Loader2 size={24} className="animate-spin text-primary" />
          <span className="text-sm text-[var(--text-secondary)]">Loading stats…</span>
        </div>
      </div>
    );
  }

  /* ---- Error ------------------------------------------------------ */
  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="card p-6 max-w-md text-center">
          <AlertTriangle size={24} className="mx-auto mb-2 text-status-reverted" />
          <p className="text-sm text-status-reverted">{error}</p>
        </div>
      </div>
    );
  }

  /* ---- Empty ------------------------------------------------------ */
  if (!stats) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center py-12">
          <BarChart3 size={28} className="mx-auto mb-2 text-[var(--text-tertiary)]" />
          <p className="text-sm text-[var(--text-secondary)]">No stats available</p>
        </div>
      </div>
    );
  }

  const maxAgentCount =
    stats.decisions_per_agent.length > 0
      ? Math.max(...stats.decisions_per_agent.map((a) => a.count))
      : 1;

  const trendMax =
    stats.decision_trend.length > 0 ? Math.max(...stats.decision_trend.map((t) => t.count), 1) : 1;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-lg font-semibold mb-1">Project Stats</h1>
            <p className="text-sm text-[var(--text-secondary)]">
              Overview of decisions, agents, and activity
            </p>
          </div>
          <button
            onClick={async () => {
              try {
                const data = await get(`/api/projects/${projectId}/export`);
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `nexus-export-${new Date().toISOString().slice(0, 10)}.json`;
                a.click();
                URL.revokeObjectURL(url);
              } catch {
                alert('Export failed');
              }
            }}
            className="flex items-center gap-2 px-3 py-2 rounded-md bg-primary/10 text-primary text-sm font-medium hover:bg-primary/20 transition-colors"
          >
            <Download size={14} /> Export Project
          </button>
        </div>

        {/* Top stat cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard
            label="Total Decisions"
            value={stats.total_decisions}
            icon={<FileText size={18} />}
          />
          <StatCard
            label="Contradictions"
            value={stats.unresolved_contradictions}
            icon={<AlertTriangle size={18} />}
            warn={stats.unresolved_contradictions > 0}
            sub={stats.unresolved_contradictions > 0 ? 'Needs attention' : 'All clear'}
          />
          <StatCard label="Total Agents" value={stats.total_agents} icon={<Users size={18} />} />
          <StatCard label="Sessions" value={stats.total_sessions} icon={<Clock size={18} />} />
        </div>

        {/* Decisions by status */}
        <div className="card p-5">
          <h2 className="text-sm font-semibold mb-4 flex items-center gap-2">
            <BarChart3 size={16} className="text-primary" />
            Decisions by Status
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {(['active', 'superseded', 'reverted', 'pending'] as const).map((status) => {
              const colors = STATUS_COLORS[status];
              const count = stats.by_status[status] ?? 0;
              const pct =
                stats.total_decisions > 0 ? Math.round((count / stats.total_decisions) * 100) : 0;
              return (
                <div key={status} className={`rounded-lg p-3 ${colors.bg}`}>
                  <p className={`text-xs font-medium capitalize mb-1 ${colors.text}`}>{status}</p>
                  <p className="text-2xl font-semibold tabular-nums">{count}</p>
                  <p className="text-2xs text-[var(--text-tertiary)]">{pct}% of total</p>
                </div>
              );
            })}
          </div>
        </div>

        {/* Two-column: Agent chart + Artifacts/Sessions */}
        <div className="grid md:grid-cols-2 gap-5">
          {/* Decisions per agent */}
          <div className="card p-5">
            <h2 className="text-sm font-semibold mb-4 flex items-center gap-2">
              <Users size={16} className="text-primary" />
              Decisions per Agent
            </h2>
            {stats.decisions_per_agent.length === 0 ? (
              <p className="text-sm text-[var(--text-secondary)] py-4 text-center">No agent data</p>
            ) : (
              <div className="space-y-3">
                {stats.decisions_per_agent
                  .sort((a, b) => b.count - a.count)
                  .map((row) => {
                    const pct =
                      maxAgentCount > 0 ? Math.round((row.count / maxAgentCount) * 100) : 0;
                    return (
                      <div key={row.agent}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-medium truncate max-w-[70%]">
                            {row.agent}
                          </span>
                          <span className="text-xs text-[var(--text-secondary)] tabular-nums">
                            {row.count}
                          </span>
                        </div>
                        <div className="h-2 rounded-full bg-[var(--border-light)] overflow-hidden">
                          <div
                            className="h-full rounded-full bg-primary transition-all duration-500"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}
          </div>

          {/* Artifacts + extra metrics */}
          <div className="flex flex-col gap-3">
            <div className="card p-4 flex items-start gap-3">
              <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 bg-primary/10">
                <FileText size={18} className="text-primary" />
              </div>
              <div>
                <p className="text-2xs text-[var(--text-secondary)] uppercase tracking-wide mb-0.5">
                  Artifacts
                </p>
                <p className="text-xl font-semibold tabular-nums">{stats.total_artifacts}</p>
              </div>
            </div>

            {/* Unresolved contradictions callout */}
            {stats.unresolved_contradictions > 0 && (
              <div className="card p-4 ring-1 ring-status-reverted/40 flex items-start gap-3">
                <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 bg-status-reverted/10">
                  <AlertTriangle size={18} className="text-status-reverted" />
                </div>
                <div>
                  <p className="text-xs font-semibold text-status-reverted mb-0.5">
                    {stats.unresolved_contradictions} Unresolved Contradiction
                    {stats.unresolved_contradictions !== 1 ? 's' : ''}
                  </p>
                  <p className="text-2xs text-[var(--text-secondary)]">
                    Review contradictions to maintain decision consistency
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Decision trend */}
        {stats.decision_trend && stats.decision_trend.length > 0 && (
          <div className="card p-5">
            <h2 className="text-sm font-semibold mb-4 flex items-center gap-2">
              <TrendingUp size={16} className="text-primary" />
              Decision Trend
            </h2>
            <div className="flex items-end gap-1.5 h-24">
              {stats.decision_trend.map((point) => {
                const heightPct = trendMax > 0 ? Math.round((point.count / trendMax) * 100) : 0;
                return (
                  <div
                    key={point.date}
                    className="flex-1 flex flex-col items-center gap-1 group"
                    title={`${formatDate(point.date)}: ${point.count}`}
                  >
                    <div
                      className="w-full rounded-t bg-primary/70 hover:bg-primary transition-colors duration-150"
                      style={{ height: `${Math.max(heightPct, 4)}%` }}
                    />
                  </div>
                );
              })}
            </div>
            {/* X-axis labels — show first, middle, last */}
            {stats.decision_trend.length >= 2 && (
              <div className="flex justify-between mt-2">
                <span className="text-2xs text-[var(--text-tertiary)]">
                  {formatDate(stats.decision_trend[0].date)}
                </span>
                <span className="text-2xs text-[var(--text-tertiary)]">
                  {formatDate(
                    stats.decision_trend[Math.floor(stats.decision_trend.length / 2)].date,
                  )}
                </span>
                <span className="text-2xs text-[var(--text-tertiary)]">
                  {formatDate(stats.decision_trend[stats.decision_trend.length - 1].date)}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Recent activity */}
        {stats.recent_activity && stats.recent_activity.length > 0 && (
          <div className="card p-5">
            <h2 className="text-sm font-semibold mb-4 flex items-center gap-2">
              <Activity size={16} className="text-primary" />
              Recent Activity
            </h2>
            <div className="space-y-2">
              {stats.recent_activity.map((item) => (
                <div
                  key={item.id}
                  className="flex items-start gap-3 py-2 border-b border-[var(--border-light)] last:border-0"
                >
                  <div className="w-2 h-2 rounded-full bg-primary/60 mt-1.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm leading-snug">{item.description}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      {item.agent && (
                        <span className="text-2xs text-[var(--text-secondary)]">{item.agent}</span>
                      )}
                      <span className="text-2xs text-[var(--text-tertiary)]">
                        {formatTime(item.timestamp)}
                      </span>
                    </div>
                  </div>
                  <span className="text-2xs text-[var(--text-tertiary)] capitalize whitespace-nowrap">
                    {item.type.replace(/_/g, ' ')}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
