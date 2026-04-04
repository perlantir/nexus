import { useState, useEffect, useCallback } from 'react';
import { useApi } from '../hooks/useApi';
import { useProject } from '../App';
import {
  Plus,
  Trash2,
  Zap,
  Check,
  X,
  ToggleLeft,
  ToggleRight,
  Send,
  Hash,
  MessageSquare,
} from 'lucide-react';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface WebhookConfig {
  id: string;
  project_id: string;
  name: string;
  url: string;
  platform: string;
  events: string[] | string;
  enabled: boolean | number;
  secret: string | null;
  metadata: Record<string, unknown> | string;
  created_at: string;
  updated_at: string;
}

const PLATFORMS = ['generic', 'slack', 'discord', 'telegram'] as const;

const ALL_EVENTS = [
  'decision_created',
  'decision_superseded',
  'decision_reverted',
  'contradiction_detected',
  'distillery_completed',
  'scan_completed',
] as const;

const PLATFORM_ICONS: Record<string, React.ReactNode> = {
  generic: <Zap size={16} />,
  slack: <Hash size={16} />,
  discord: <MessageSquare size={16} />,
  telegram: <Send size={16} />,
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function parseEvents(events: string[] | string): string[] {
  if (typeof events === 'string') {
    try { return JSON.parse(events); } catch { return []; }
  }
  return events;
}

function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname;
    return `${u.protocol}//${host}/****`;
  } catch {
    return url.length > 30 ? url.slice(0, 30) + '…' : url;
  }
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function Webhooks() {
  const { get, post, patch, del } = useApi();
  const { projectId } = useProject();
  const [webhooks, setWebhooks] = useState<WebhookConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; error?: string }>>({});
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  // Form state
  const [formName, setFormName] = useState('');
  const [formUrl, setFormUrl] = useState('');
  const [formPlatform, setFormPlatform] = useState<string>('generic');
  const [formEvents, setFormEvents] = useState<string[]>([]);
  const [formSecret, setFormSecret] = useState('');
  const [formError, setFormError] = useState('');

  const fetchWebhooks = useCallback(async () => {
    try {
      const data = await get<WebhookConfig[]>(`/api/projects/${projectId}/webhooks`);
      setWebhooks(Array.isArray(data) ? data : []);
    } catch {
      setWebhooks([]);
    } finally {
      setLoading(false);
    }
  }, [get, projectId]);

  useEffect(() => { fetchWebhooks(); }, [fetchWebhooks]);

  const handleCreate = async () => {
    setFormError('');
    if (!formName.trim() || !formUrl.trim()) {
      setFormError('Name and URL are required');
      return;
    }
    try {
      await post(`/api/projects/${projectId}/webhooks`, {
        name: formName.trim(),
        url: formUrl.trim(),
        platform: formPlatform,
        events: formEvents,
        secret: formSecret.trim() || undefined,
      });
      setShowForm(false);
      setFormName(''); setFormUrl(''); setFormPlatform('generic');
      setFormEvents([]); setFormSecret('');
      fetchWebhooks();
    } catch (err: unknown) {
      const e = err as { message?: string };
      setFormError(e.message ?? 'Failed to create webhook');
    }
  };

  const handleToggle = async (wh: WebhookConfig) => {
    const enabled = typeof wh.enabled === 'number' ? !wh.enabled : !wh.enabled;
    await patch(`/api/projects/${projectId}/webhooks/${wh.id}`, { enabled });
    fetchWebhooks();
  };

  const handleDelete = async (id: string) => {
    await del(`/api/projects/${projectId}/webhooks/${id}`);
    setDeleteConfirm(null);
    fetchWebhooks();
  };

  const handleTest = async (id: string) => {
    try {
      const result = await post<{ success: boolean; status_code?: number; error?: string }>(
        `/api/projects/${projectId}/webhooks/${id}/test`, {},
      );
      setTestResults((prev) => ({ ...prev, [id]: result }));
    } catch {
      setTestResults((prev) => ({ ...prev, [id]: { success: false, error: 'Request failed' } }));
    }
  };

  const toggleEvent = (event: string) => {
    setFormEvents((prev) =>
      prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event],
    );
  };

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center">
        <span className="text-[var(--text-secondary)]">Loading webhooks…</span>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Webhooks</h1>
          <p className="text-sm text-[var(--text-secondary)] mt-1">
            Get notified in Slack, Discord, or Telegram when decisions change
          </p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-white text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          <Plus size={16} /> Add Webhook
        </button>
      </div>

      {/* Setup instructions */}
      <div className="mb-6 p-4 rounded-lg bg-[var(--bg-hover)] border border-[var(--border-light)] text-sm text-[var(--text-secondary)]">
        <p className="font-medium text-[var(--text-primary)] mb-2">Platform Setup</p>
        <ul className="list-disc pl-5 space-y-1">
          <li><strong>Slack:</strong> Create an Incoming Webhook at <em>api.slack.com/messaging/webhooks</em></li>
          <li><strong>Discord:</strong> Channel Settings → Integrations → Webhooks → New Webhook</li>
          <li><strong>Telegram:</strong> Create a bot via @BotFather, then set bot_token and chat_id in metadata</li>
        </ul>
      </div>

      {/* Add form */}
      {showForm && (
        <div className="mb-6 p-5 rounded-lg border border-[var(--border-light)] bg-[var(--bg-hover)]">
          <h2 className="text-lg font-semibold mb-4">New Webhook</h2>
          {formError && (
            <div className="mb-3 p-2 rounded bg-red-500/10 text-red-400 text-sm">{formError}</div>
          )}
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-xs font-medium mb-1 text-[var(--text-secondary)]">Name</label>
              <input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g. team-slack"
                className="w-full px-3 py-2 rounded-md bg-[var(--bg-secondary)] border border-[var(--border-light)] text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1 text-[var(--text-secondary)]">Platform</label>
              <select
                value={formPlatform}
                onChange={(e) => setFormPlatform(e.target.value)}
                className="w-full px-3 py-2 rounded-md bg-[var(--bg-secondary)] border border-[var(--border-light)] text-sm"
              >
                {PLATFORMS.map((p) => (
                  <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="mb-4">
            <label className="block text-xs font-medium mb-1 text-[var(--text-secondary)]">Webhook URL</label>
            <input
              value={formUrl}
              onChange={(e) => setFormUrl(e.target.value)}
              placeholder="https://hooks.slack.com/services/..."
              className="w-full px-3 py-2 rounded-md bg-[var(--bg-secondary)] border border-[var(--border-light)] text-sm"
            />
          </div>
          <div className="mb-4">
            <label className="block text-xs font-medium mb-1 text-[var(--text-secondary)]">Events</label>
            <div className="flex flex-wrap gap-2">
              {ALL_EVENTS.map((event) => (
                <button
                  key={event}
                  onClick={() => toggleEvent(event)}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                    formEvents.includes(event)
                      ? 'bg-primary/20 text-primary border border-primary/40'
                      : 'bg-[var(--bg-hover)] text-[var(--text-secondary)] border border-[var(--border-light)] hover:bg-[var(--bg-active)]'
                  }`}
                >
                  {event.replace(/_/g, ' ')}
                </button>
              ))}
            </div>
          </div>
          <div className="mb-4">
            <label className="block text-xs font-medium mb-1 text-[var(--text-secondary)]">
              Secret (optional — used for HMAC-SHA256 signature)
            </label>
            <input
              type="password"
              value={formSecret}
              onChange={(e) => setFormSecret(e.target.value)}
              placeholder="Optional signing secret"
              className="w-full px-3 py-2 rounded-md bg-[var(--bg-secondary)] border border-[var(--border-light)] text-sm"
            />
          </div>
          <div className="flex gap-3">
            <button
              onClick={handleCreate}
              className="px-4 py-2 rounded-md bg-primary text-white text-sm font-medium hover:bg-primary/90"
            >
              Create Webhook
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="px-4 py-2 rounded-md bg-[var(--bg-hover)] text-sm hover:bg-[var(--bg-active)]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Webhook list */}
      {webhooks.length === 0 && !showForm ? (
        <div className="text-center py-16 text-[var(--text-secondary)]">
          <Zap size={40} className="mx-auto mb-3 opacity-30" />
          <p className="text-lg font-medium mb-1">No webhooks configured</p>
          <p className="text-sm">Add a webhook to receive notifications in your team channels</p>
        </div>
      ) : (
        <div className="space-y-3">
          {webhooks.map((wh) => {
            const events = parseEvents(wh.events);
            const isEnabled = typeof wh.enabled === 'number' ? !!wh.enabled : wh.enabled;
            const testResult = testResults[wh.id];

            return (
              <div
                key={wh.id}
                className={`p-4 rounded-lg border transition-colors ${
                  isEnabled
                    ? 'border-[var(--border-light)] bg-[var(--bg-hover)]'
                    : 'border-[var(--border-light)] bg-[var(--bg-secondary)] opacity-60'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-3">
                    <span className="w-8 h-8 rounded-md bg-[var(--bg-active)] flex items-center justify-center">
                      {PLATFORM_ICONS[wh.platform] ?? <Zap size={16} />}
                    </span>
                    <div>
                      <span className="font-semibold text-sm">{wh.name}</span>
                      <span className="ml-2 text-xs px-2 py-0.5 rounded bg-[var(--bg-active)] text-[var(--text-secondary)]">
                        {wh.platform}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleTest(wh.id)}
                      title="Send test payload"
                      className="p-1.5 rounded hover:bg-[var(--bg-active)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                    >
                      <Zap size={14} />
                    </button>
                    <button
                      onClick={() => handleToggle(wh)}
                      title={isEnabled ? 'Disable' : 'Enable'}
                      className="p-1.5 rounded hover:bg-[var(--bg-active)] transition-colors"
                    >
                      {isEnabled ? (
                        <ToggleRight size={18} className="text-green-400" />
                      ) : (
                        <ToggleLeft size={18} className="text-[var(--text-secondary)]" />
                      )}
                    </button>
                    {deleteConfirm === wh.id ? (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => handleDelete(wh.id)}
                          className="p-1.5 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30"
                        >
                          <Check size={14} />
                        </button>
                        <button
                          onClick={() => setDeleteConfirm(null)}
                          className="p-1.5 rounded hover:bg-[var(--bg-active)] text-[var(--text-secondary)]"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setDeleteConfirm(wh.id)}
                        title="Delete"
                        className="p-1.5 rounded hover:bg-[var(--bg-active)] text-[var(--text-secondary)] hover:text-red-400 transition-colors"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </div>

                <div className="text-xs text-[var(--text-secondary)] mb-2 font-mono">
                  {maskUrl(wh.url)}
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {events.map((event) => (
                    <span
                      key={event}
                      className="px-2 py-0.5 rounded-full text-xs bg-[var(--bg-hover)] text-[var(--text-secondary)] border border-[var(--border-light)]"
                    >
                      {event.replace(/_/g, ' ')}
                    </span>
                  ))}
                  {events.length === 0 && (
                    <span className="text-xs text-[var(--text-secondary)] italic">No events selected</span>
                  )}
                </div>

                {testResult && (
                  <div
                    className={`mt-2 text-xs px-3 py-1.5 rounded ${
                      testResult.success
                        ? 'bg-green-500/10 text-green-400'
                        : 'bg-red-500/10 text-red-400'
                    }`}
                  >
                    {testResult.success ? 'Test successful' : `Test failed: ${testResult.error ?? 'Unknown error'}`}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
