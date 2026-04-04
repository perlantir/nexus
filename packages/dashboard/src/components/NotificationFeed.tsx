import { useEffect, useState } from 'react';
import {
  Bell,
  Loader2,
  Check,
  AlertTriangle,
  ArrowRight,
  FileText,
  RefreshCw,
  CheckCircle2,
  Eye,
} from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useProject } from '../App';
import type { Notification } from '../types';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const URGENCY_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  critical: {
    bg: 'bg-status-reverted/10',
    text: 'text-status-reverted',
    dot: 'bg-status-reverted',
  },
  high: {
    bg: 'bg-[#DA7101]/10',
    text: 'text-[#DA7101]',
    dot: 'bg-[#DA7101]',
  },
  medium: {
    bg: 'bg-primary/10',
    text: 'text-primary',
    dot: 'bg-primary',
  },
  low: {
    bg: 'bg-gray-200',
    text: 'text-[var(--text-secondary)]',
    dot: 'bg-gray-400',
  },
};

const TYPE_ICONS: Record<string, typeof Bell> = {
  contradiction: AlertTriangle,
  supersession: ArrowRight,
  new_decision: FileText,
  status_change: RefreshCw,
  session_complete: CheckCircle2,
};

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function NotificationFeed() {
  const { get, patch } = useApi();
  const { projectId } = useProject();

  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'unread'>('all');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    get<Notification[]>(`/api/projects/${projectId}/notifications`)
      .then((data) => {
        if (!cancelled) {
          setNotifications(Array.isArray(data) ? data : []);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || 'Failed to load notifications');
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [get, projectId]);

  const filtered = filter === 'unread' ? notifications.filter((n) => !n.read) : notifications;

  const unreadCount = notifications.filter((n) => !n.read).length;

  async function markAsRead(id: string) {
    try {
      await patch(`/api/projects/${projectId}/notifications/${id}`, {
        read: true,
      });
      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    } catch {
      // Silently fail
    }
  }

  async function markAllAsRead() {
    const unread = notifications.filter((n) => !n.read);
    try {
      await Promise.all(
        unread.map((n) =>
          patch(`/api/projects/${projectId}/notifications/${n.id}`, {
            read: true,
          }),
        ),
      );
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    } catch {
      // Silently fail
    }
  }

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

  /* ---- Loading / Error ------------------------------------------- */

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3">
          <Loader2 size={24} className="animate-spin text-primary" />
          <span className="text-sm text-[var(--text-secondary)]">Loading notifications…</span>
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
      <div className="max-w-2xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-lg font-semibold mb-1 flex items-center gap-2">
              Notifications
              {unreadCount > 0 && (
                <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-primary text-white">
                  {unreadCount}
                </span>
              )}
            </h1>
            <p className="text-sm text-[var(--text-secondary)]">
              Stay informed about decision changes
            </p>
          </div>
          {unreadCount > 0 && (
            <button onClick={markAllAsRead} className="btn-ghost text-xs">
              <Check size={14} />
              Mark all read
            </button>
          )}
        </div>

        {/* Filter tabs */}
        <div className="flex items-center gap-1 mb-6 border-b border-[var(--border-light)]">
          <button
            onClick={() => setFilter('all')}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              filter === 'all'
                ? 'border-primary text-primary'
                : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            All
            <span className="ml-1.5 text-xs opacity-60">({notifications.length})</span>
          </button>
          <button
            onClick={() => setFilter('unread')}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              filter === 'unread'
                ? 'border-primary text-primary'
                : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            Unread
            <span className="ml-1.5 text-xs opacity-60">({unreadCount})</span>
          </button>
        </div>

        {/* Notification list */}
        {filtered.length === 0 ? (
          <div className="text-center py-12">
            <Bell
              size={28}
              className="mx-auto mb-2 text-[var(--text-tertiary)]"
            />
            <p className="text-sm text-[var(--text-secondary)]">
              {filter === 'unread' ? 'No unread notifications' : 'No notifications yet'}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {filtered
              .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
              .map((notification) => {
                const urgency = URGENCY_COLORS[notification.urgency] || URGENCY_COLORS.low;
                const IconComponent = TYPE_ICONS[notification.type] || Bell;

                return (
                  <div
                    key={notification.id}
                    className={`card p-4 transition-all animate-slide-up ${
                      !notification.read ? 'border-l-2' : ''
                    }`}
                    style={{
                      borderLeftColor: !notification.read
                        ? notification.urgency === 'critical'
                          ? '#A13544'
                          : notification.urgency === 'high'
                            ? '#DA7101'
                            : notification.urgency === 'medium'
                              ? '#01696F'
                              : '#7A7974'
                        : undefined,
                    }}
                  >
                    <div className="flex items-start gap-3">
                      {/* Icon */}
                      <div
                        className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${urgency.bg}`}
                      >
                        <IconComponent size={14} className={urgency.text} />
                      </div>

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <p
                              className={`text-sm leading-relaxed ${
                                notification.read
                                  ? 'text-[var(--text-secondary)]'
                                  : ''
                              }`}
                            >
                              {notification.message}
                            </p>
                            {notification.role_context && (
                              <p className="text-xs text-[var(--text-tertiary)] mt-0.5">
                                {notification.role_context}
                              </p>
                            )}
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <span className="text-2xs text-[var(--text-tertiary)] whitespace-nowrap">
                              {formatTime(notification.created_at)}
                            </span>
                          </div>
                        </div>

                        {/* Bottom row */}
                        <div className="flex items-center gap-3 mt-2">
                          {/* Urgency badge */}
                          <span
                            className={`inline-flex items-center gap-1 text-2xs font-medium capitalize ${urgency.text}`}
                          >
                            <span className={`w-1.5 h-1.5 rounded-full ${urgency.dot}`} />
                            {notification.urgency}
                          </span>

                          {/* Type */}
                          <span className="text-2xs text-[var(--text-tertiary)] capitalize">
                            {notification.type.replace(/_/g, ' ')}
                          </span>

                          {/* Mark as read */}
                          {!notification.read && (
                            <button
                              onClick={() => markAsRead(notification.id)}
                              className="ml-auto btn-ghost text-2xs py-0.5 px-2"
                            >
                              <Eye size={12} />
                              Mark read
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
          </div>
        )}
      </div>
    </div>
  );
}
