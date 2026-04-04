import { useEffect, useState, useCallback } from 'react';
import {
  Plus,
  Loader2,
  AlertCircle,
  RefreshCw,
  Clock,
  Database,
  FolderOpen,
  Webhook,
  Search,
  CheckCircle2,
  XCircle,
  Activity,
  ChevronDown,
  ChevronUp,
  X,
  ToggleLeft,
  ToggleRight,
} from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useProject } from '../App';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type ConnectorType = 'openclaw' | 'directory' | 'webhook';

interface ConnectorConfig {
  path?: string;
  url?: string;
  secret?: string;
  interval_minutes?: number;
}

interface Connector {
  id: string;
  name: ConnectorType;
  config: ConnectorConfig;
  enabled: boolean;
  last_poll_at?: string;
  sources_processed: number;
  status: 'active' | 'error' | 'idle';
  error_message?: string;
}

interface DiscoveryStatus {
  running: boolean;
  last_run_at?: string;
  decisions_found: number;
  sources_scanned: number;
  next_run_at?: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function connectorIcon(name: ConnectorType) {
  switch (name) {
    case 'openclaw':
      return <Search size={16} className="text-primary" />;
    case 'directory':
      return <FolderOpen size={16} className="text-primary" />;
    case 'webhook':
      return <Webhook size={16} className="text-primary" />;
  }
}

function connectorLabel(name: ConnectorType) {
  switch (name) {
    case 'openclaw':
      return 'OpenClaw';
    case 'directory':
      return 'Directory';
    case 'webhook':
      return 'Webhook';
  }
}

function statusDot(status: Connector['status']) {
  const base = 'w-2 h-2 rounded-full shrink-0';
  switch (status) {
    case 'active':
      return <span className={`${base} bg-green-400`} title="Active" />;
    case 'error':
      return <span className={`${base} bg-red-400`} title="Error" />;
    case 'idle':
      return <span className={`${base} bg-yellow-400`} title="Idle" />;
  }
}

function relativeTime(iso?: string) {
  if (!iso) return 'Never';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/* ------------------------------------------------------------------ */
/*  ConnectorCard                                                      */
/* ------------------------------------------------------------------ */

interface ConnectorCardProps {
  connector: Connector;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
}

function ConnectorCard({ connector, onToggle, onDelete }: ConnectorCardProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="card p-4 animate-slide-up">
      <div className="flex items-center gap-3">
        {/* Icon */}
        <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
          {connectorIcon(connector.name)}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            {statusDot(connector.status)}
            <span className="text-sm font-semibold">{connectorLabel(connector.name)}</span>
          </div>
          <p className="text-xs text-[var(--text-secondary)] truncate">
            {connector.config.path || connector.config.url || '—'}
          </p>
        </div>

        {/* Stats */}
        <div className="hidden sm:flex items-center gap-4 mr-4">
          <div className="text-right">
            <p className="text-xs text-[var(--text-secondary)]">
              Last poll
            </p>
            <p className="text-xs font-medium">{relativeTime(connector.last_poll_at)}</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-[var(--text-secondary)]">
              Sources
            </p>
            <p className="text-xs font-medium">{connector.sources_processed}</p>
          </div>
        </div>

        {/* Toggle */}
        <button
          onClick={() => onToggle(connector.id, !connector.enabled)}
          className="shrink-0 transition-colors"
          title={connector.enabled ? 'Disable connector' : 'Enable connector'}
        >
          {connector.enabled ? (
            <ToggleRight size={24} className="text-primary" />
          ) : (
            <ToggleLeft size={24} className="text-[var(--text-secondary)]" />
          )}
        </button>

        {/* Expand */}
        <button
          onClick={() => setExpanded((e) => !e)}
          className="btn-ghost p-1"
          title={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </button>

        {/* Delete */}
        <button
          onClick={() => onDelete(connector.id)}
          className="btn-ghost p-1 hover:text-red-400 transition-colors"
          title="Remove connector"
        >
          <X size={15} />
        </button>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="mt-4 pt-4 border-t border-[var(--border-light)] space-y-3">
          {/* Mobile stats */}
          <div className="flex items-center gap-6 sm:hidden">
            <div>
              <p className="text-xs text-[var(--text-secondary)]">Last poll</p>
              <p className="text-xs font-medium">{relativeTime(connector.last_poll_at)}</p>
            </div>
            <div>
              <p className="text-xs text-[var(--text-secondary)]">Sources processed</p>
              <p className="text-xs font-medium">{connector.sources_processed}</p>
            </div>
          </div>

          {/* Config details */}
          {connector.config.path && (
            <div>
              <p className="text-xs text-[var(--text-secondary)] mb-0.5">Path</p>
              <code className="text-xs font-mono bg-[var(--border-light)]/30 px-2 py-1 rounded">
                {connector.config.path}
              </code>
            </div>
          )}
          {connector.config.url && (
            <div>
              <p className="text-xs text-[var(--text-secondary)] mb-0.5">URL</p>
              <code className="text-xs font-mono bg-[var(--border-light)]/30 px-2 py-1 rounded break-all">
                {connector.config.url}
              </code>
            </div>
          )}
          {connector.config.interval_minutes && (
            <div>
              <p className="text-xs text-[var(--text-secondary)] mb-0.5">
                Poll interval
              </p>
              <p className="text-xs font-medium">{connector.config.interval_minutes} minutes</p>
            </div>
          )}

          {/* Error */}
          {connector.status === 'error' && connector.error_message && (
            <div className="flex items-start gap-2 p-2 rounded-md bg-red-500/10 border border-red-500/20">
              <AlertCircle size={13} className="shrink-0 mt-0.5 text-red-400" />
              <p className="text-xs text-red-300">{connector.error_message}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Add connector form                                                 */
/* ------------------------------------------------------------------ */

const CONNECTOR_TYPES: ConnectorType[] = ['openclaw', 'directory', 'webhook'];

interface AddConnectorFormProps {
  onAdd: (connector: { name: ConnectorType; config: ConnectorConfig }) => Promise<void>;
  onCancel: () => void;
}

function AddConnectorForm({ onAdd, onCancel }: AddConnectorFormProps) {
  const [type, setType] = useState<ConnectorType>('openclaw');
  const [path, setPath] = useState('');
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [interval, setInterval] = useState('30');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const config: ConnectorConfig = {};
    if (type === 'openclaw' || type === 'directory') {
      if (!path.trim()) {
        setError('Path is required.');
        return;
      }
      config.path = path.trim();
    } else {
      if (!url.trim()) {
        setError('Webhook URL is required.');
        return;
      }
      config.url = url.trim();
      if (secret.trim()) config.secret = secret.trim();
    }

    const parsed = parseInt(interval);
    if (!isNaN(parsed) && parsed > 0) config.interval_minutes = parsed;

    setLoading(true);
    try {
      await onAdd({ name: type, config });
    } catch (err: unknown) {
      const e = err as { message?: string };
      setError(e.message || 'Failed to add connector.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="card p-5 animate-slide-up">
      <h3 className="text-sm font-semibold mb-4">New connector</h3>

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-md bg-red-500/10 border border-red-500/20 mb-4">
          <AlertCircle size={14} className="shrink-0 mt-0.5 text-red-400" />
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}

      <div className="space-y-4">
        {/* Type */}
        <div>
          <label className="block text-xs font-medium mb-1.5 uppercase tracking-wider text-[var(--text-secondary)]">
            Connector type
          </label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as ConnectorType)}
            className="input w-full"
          >
            {CONNECTOR_TYPES.map((t) => (
              <option key={t} value={t}>
                {connectorLabel(t)}
              </option>
            ))}
          </select>
        </div>

        {/* Path */}
        {(type === 'openclaw' || type === 'directory') && (
          <div>
            <label className="block text-xs font-medium mb-1.5 uppercase tracking-wider text-[var(--text-secondary)]">
              {type === 'openclaw' ? 'OpenClaw path' : 'Directory path'} <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={type === 'openclaw' ? '/path/to/openclaw' : '/projects/myapp'}
              className="input w-full"
              autoFocus
            />
          </div>
        )}

        {/* Webhook URL */}
        {type === 'webhook' && (
          <>
            <div>
              <label className="block text-xs font-medium mb-1.5 uppercase tracking-wider text-[var(--text-secondary)]">
                Webhook URL <span className="text-red-400">*</span>
              </label>
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://hooks.example.com/…"
                className="input w-full"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1.5 uppercase tracking-wider text-[var(--text-secondary)]">
                Secret <span className="opacity-50">(optional)</span>
              </label>
              <input
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder="Signing secret"
                className="input w-full"
              />
            </div>
          </>
        )}

        {/* Poll interval */}
        {type !== 'webhook' && (
          <div>
            <label className="block text-xs font-medium mb-1.5 uppercase tracking-wider text-[var(--text-secondary)]">
              Poll interval (minutes)
            </label>
            <input
              type="number"
              value={interval}
              onChange={(e) => setInterval(e.target.value)}
              min="1"
              max="1440"
              className="input w-32"
            />
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 justify-end mt-5">
        <button type="button" onClick={onCancel} className="btn-secondary text-sm">
          Cancel
        </button>
        <button type="submit" disabled={loading} className="btn-primary text-sm flex items-center gap-2">
          {loading ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          Add connector
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/*  Connectors page                                                    */
/* ------------------------------------------------------------------ */

export function Connectors() {
  const { get, post, patch, del } = useApi();
  const { projectId } = useProject();

  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [discovery, setDiscovery] = useState<DiscoveryStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  /* ---- Fetch ---------------------------------------------------- */

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [connectorsRes, statusRes] = await Promise.allSettled([
        get<Connector[]>(`/api/projects/${projectId}/connectors`),
        get<DiscoveryStatus>(`/api/projects/${projectId}/discovery/status`),
      ]);
      if (connectorsRes.status === 'fulfilled') setConnectors(Array.isArray(connectorsRes.value) ? connectorsRes.value : []);
      if (statusRes.status === 'fulfilled') setDiscovery(statusRes.value);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message :
        (typeof err === 'object' && err !== null && 'message' in err)
          ? String((err as {message: unknown}).message)
          : 'Failed to load connectors.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [get, projectId]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  /* ---- Actions -------------------------------------------------- */

  async function handleToggle(id: string, enabled: boolean) {
    try {
      await patch(`/api/projects/${projectId}/connectors/${id}`, { enabled });
      setConnectors((prev) => prev.map((c) => (c.id === id ? { ...c, enabled } : c)));
    } catch {
      // silent — refresh will sync
    }
  }

  async function handleDelete(id: string) {
    try {
      await del(`/api/projects/${projectId}/connectors/${id}`);
      setConnectors((prev) => prev.filter((c) => c.id !== id));
    } catch {
      // silent
    }
  }

  async function handleAdd({
    name,
    config,
  }: {
    name: ConnectorType;
    config: ConnectorConfig;
  }) {
    const created = await post<Connector>(`/api/projects/${projectId}/connectors`, {
      name,
      config,
      enabled: true,
    });
    setConnectors((prev) => [...prev, created]);
    setShowForm(false);
  }

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3">
          <Loader2 size={24} className="animate-spin text-primary" />
          <span className="text-sm text-[var(--text-secondary)]">Loading connectors…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-lg font-semibold mb-1">Connectors</h1>
            <p className="text-sm text-[var(--text-secondary)]">
              Manage auto-discovery sources for this project.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={fetchAll}
              className="btn-secondary flex items-center gap-1.5 text-xs"
              title="Refresh"
            >
              <RefreshCw size={13} />
              Refresh
            </button>
            <button
              onClick={() => setShowForm((v) => !v)}
              className="btn-primary flex items-center gap-1.5 text-sm"
            >
              <Plus size={15} />
              Add connector
            </button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-start gap-2 p-3 rounded-md bg-red-500/10 border border-red-500/20 mb-6">
            <AlertCircle size={15} className="shrink-0 mt-0.5 text-red-400" />
            <p className="text-sm text-red-300">{error}</p>
            <button onClick={fetchAll} className="ml-auto shrink-0 text-xs text-red-400 hover:text-red-300 flex items-center gap-1">
              <RefreshCw size={11} />
              Retry
            </button>
          </div>
        )}

        {/* Discovery status banner */}
        {discovery && (
          <div className="card p-4 mb-6">
            <div className="flex items-center gap-2 mb-3">
              <Activity size={16} className="text-primary" />
              <h3 className="text-sm font-semibold">Discovery Status</h3>
              {discovery.running ? (
                <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-green-500/15 text-green-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                  Running
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-[var(--border-light)]/40 text-[var(--text-secondary)]">
                  Idle
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[
                {
                  icon: <Database size={14} />,
                  label: 'Decisions found',
                  value: discovery.decisions_found,
                },
                {
                  icon: <FolderOpen size={14} />,
                  label: 'Sources scanned',
                  value: discovery.sources_scanned,
                },
                {
                  icon: <Clock size={14} />,
                  label: 'Last run',
                  value: relativeTime(discovery.last_run_at),
                },
                {
                  icon: <Clock size={14} />,
                  label: 'Next run',
                  value: relativeTime(discovery.next_run_at),
                },
              ].map((item, i) => (
                <div key={i}>
                  <div className="flex items-center gap-1.5 text-[var(--text-secondary)] mb-1">
                    {item.icon}
                    <span className="text-xs">{item.label}</span>
                  </div>
                  <p className="text-sm font-semibold">{item.value}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Add form */}
        {showForm && (
          <div className="mb-6">
            <AddConnectorForm onAdd={handleAdd} onCancel={() => setShowForm(false)} />
          </div>
        )}

        {/* Connector list */}
        {connectors.length === 0 ? (
          <div className="text-center py-16">
            <div className="w-14 h-14 rounded-xl bg-[var(--border-light)]/30 flex items-center justify-center mx-auto mb-4">
              <Database size={22} className="text-[var(--text-secondary)]" />
            </div>
            <p className="text-sm font-medium mb-1">No connectors configured</p>
            <p className="text-xs text-[var(--text-secondary)] mb-4">
              Add a connector to start auto-discovering decisions.
            </p>
            <button
              onClick={() => setShowForm(true)}
              className="btn-primary text-sm flex items-center gap-2 mx-auto"
            >
              <Plus size={15} />
              Add your first connector
            </button>
          </div>
        ) : (
          <>
            {/* Active/disabled sections */}
            {['active', 'idle', 'error'].map((status) => {
              const group = connectors.filter((c) => c.status === status);
              if (group.length === 0) return null;
              const labelMap: Record<string, string> = {
                active: 'Active',
                idle: 'Idle',
                error: 'Errors',
              };
              const iconMap: Record<string, React.ReactNode> = {
                active: <CheckCircle2 size={14} className="text-green-400" />,
                idle: <Clock size={14} className="text-yellow-400" />,
                error: <XCircle size={14} className="text-red-400" />,
              };
              return (
                <div key={status} className="mb-6">
                  <div className="flex items-center gap-2 mb-3">
                    {iconMap[status]}
                    <h2 className="text-xs font-medium uppercase tracking-wider text-[var(--text-secondary)]">
                      {labelMap[status]} ({group.length})
                    </h2>
                  </div>
                  <div className="space-y-3">
                    {group.map((c) => (
                      <ConnectorCard
                        key={c.id}
                        connector={c}
                        onToggle={handleToggle}
                        onDelete={handleDelete}
                      />
                    ))}
                  </div>
                </div>
              );
            })}

            {/* Disabled connectors */}
            {(() => {
              const disabled = connectors.filter((c) => !c.enabled);
              if (disabled.length === 0) return null;
              return (
                <div className="mb-6">
                  <div className="flex items-center gap-2 mb-3">
                    <ToggleLeft size={14} className="text-[var(--text-secondary)]" />
                    <h2 className="text-xs font-medium uppercase tracking-wider text-[var(--text-secondary)]">
                      Disabled ({disabled.length})
                    </h2>
                  </div>
                  <div className="space-y-3 opacity-60">
                    {disabled.map((c) => (
                      <ConnectorCard
                        key={c.id}
                        connector={c}
                        onToggle={handleToggle}
                        onDelete={handleDelete}
                      />
                    ))}
                  </div>
                </div>
              );
            })()}
          </>
        )}
      </div>
    </div>
  );
}
