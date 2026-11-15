import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  Check,
  CheckCheck,
  Clock,
  Info,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import {
  dismissNotification,
  fetchManagerNotifications,
  getManagerWebSocketUrl,
  markAllNotificationsRead,
  markNotificationRead,
  updateAlertRules,
} from '../api';
import type {
  AlertRulesConfig,
  ManagerNotification,
  NotificationEventType,
} from '../types';
import { formatShortTime, getLocalDateKey } from '../utils/format';

interface ManagerNotificationsPanelProps {
  refreshSignal?: number;
  onDashboardEvent: () => void;
  onAuthError: () => void;
  onNavigateToPassword?: () => void;
  onNavigateToAddStaff?: () => void;
}

const EVENT_LABELS: Record<NotificationEventType, string> = {
  other_break: 'Other Break',
  break_exceeded: 'Break Limit Exceeded',
  missed_clock_in: 'Missed Clock-In',
  setup_password: 'Branch Security Setup',
  setup_staff: 'Team Setup',
};

export function ManagerNotificationsPanel({
  refreshSignal,
  onDashboardEvent,
  onAuthError,
  onNavigateToPassword,
  onNavigateToAddStaff,
}: ManagerNotificationsPanelProps) {
  const [notifications, setNotifications] = useState<ManagerNotification[]>([]);
  const [rules, setRules] = useState<AlertRulesConfig>({
    lunchBreakLimitMinutes: 30,
    otherBreakLimitMinutes: 15,
    clockInCutoffTime: '09:15',
    alertOnOtherBreak: true,
    maxConcurrentBreaks: null,
    peakBreakRules: [],
  });
  const [loading, setLoading] = useState(true);
  const [filterMode, setFilterMode] = useState<'all' | 'unread'>('all');
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'reconnecting'>(
    'connecting'
  );
  const [liveToast, setLiveToast] = useState<ManagerNotification | null>(null);

  // Alert rules editor
  const [showRules, setShowRules] = useState(false);
  const [draftRules, setDraftRules] = useState<AlertRulesConfig>(rules);
  const [savingRules, setSavingRules] = useState(false);
  const [rulesNotice, setRulesNotice] = useState<string | null>(null);

  const toastTimerRef = useRef<number | null>(null);

  const loadNotifications = useCallback(async () => {
    try {
      const res = await fetchManagerNotifications(getLocalDateKey());
      setNotifications(res.notifications);
      setRules(res.rules);
      setDraftRules(res.rules);
    } catch (err) {
      if (
        typeof err === 'object' &&
        err !== null &&
        'status' in err &&
        (err as { status?: number }).status === 401
      ) {
        onAuthError();
      }
    } finally {
      setLoading(false);
    }
  }, [onAuthError]);

  useEffect(() => {
    loadNotifications();
  }, [loadNotifications, refreshSignal]);

  // Real-time WebSocket connection for instant manager alerts
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      const url = getManagerWebSocketUrl();
      if (!url) return;

      setWsStatus((prev) => (prev === 'connected' ? 'connected' : 'connecting'));
      ws = new WebSocket(url);

      ws.onopen = () => {
        if (!disposed) {
          setWsStatus('connected');
        }
      };

      ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(String(event.data)) as {
            event: string;
            payload?: unknown;
          };

          if (parsed.event === 'notification:created' && parsed.payload) {
            const incoming = parsed.payload as ManagerNotification;
            setNotifications((prev) => {
              // Idempotent guard against duplicate events
              if (prev.some((n) => n.id === incoming.id)) return prev;
              return [incoming, ...prev];
            });
            setLiveToast(incoming);
            if (toastTimerRef.current) {
              window.clearTimeout(toastTimerRef.current);
            }
            toastTimerRef.current = window.setTimeout(() => {
              setLiveToast(null);
            }, 6000);
            onDashboardEvent();
          } else if (parsed.event === 'dashboard:updated') {
            onDashboardEvent();
            loadNotifications();
          } else if (parsed.event === 'notifications:synced') {
            loadNotifications();
          }
        } catch {
          // Ignore malformed frames
        }
      };

      ws.onclose = (ev) => {
        if (disposed) return;
        if (ev.code === 4001) {
          onAuthError();
          return;
        }
        setWsStatus('reconnecting');
        reconnectTimer = window.setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      ws?.close();
    };
  }, [loadNotifications, onDashboardEvent, onAuthError]);

  const unreadCount = useMemo(
    () => notifications.filter((n) => n.readAt === null).length,
    [notifications]
  );

  const visibleNotifications = useMemo(() => {
    if (filterMode === 'unread') {
      return notifications.filter((n) => n.readAt === null);
    }
    return notifications;
  }, [notifications, filterMode]);

  const handleMarkRead = async (id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, readAt: n.readAt ?? new Date().toISOString() } : n))
    );
    await markNotificationRead(id).catch(() => loadNotifications());
  };

  const handleMarkAllRead = async () => {
    const nowIso = new Date().toISOString();
    setNotifications((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? nowIso })));
    await markAllNotificationsRead().catch(() => loadNotifications());
  };

  const handleDismiss = async (id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
    await dismissNotification(id).catch(() => loadNotifications());
  };

  const handleSaveRules = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingRules(true);
    setRulesNotice(null);
    try {
      const res = await updateAlertRules(draftRules);
      setRules(res.rules);
      setDraftRules(res.rules);
      setRulesNotice('Alert thresholds saved and evaluated.');
      await loadNotifications();
    } finally {
      setSavingRules(false);
    }
  };

  return (
    <section
      aria-labelledby="notifications-heading"
      className="rounded-xl border border-slate-200 bg-white"
    >
      {/* Live Toast Banner on Real-Time WebSocket Arrival */}
      {liveToast && (
        <div className="flex items-center justify-between gap-4 border-b border-amber-200 bg-amber-50 px-5 py-3 text-sm text-amber-950">
          <div className="flex items-center gap-2.5">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-700" />
            <span>
              <strong className="font-semibold">New Live Alert:</strong> {liveToast.message}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setLiveToast(null)}
            aria-label="Close live alert banner"
            className="rounded p-1 text-amber-800 hover:bg-amber-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Panel Header */}
      <div className="flex flex-col gap-3 border-b border-slate-200 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-white">
            <Bell className="h-4 w-4" />
          </div>
          <div>
            <div className="flex items-center gap-2.5">
              <h2 id="notifications-heading" className="text-base font-semibold text-slate-900">
                Real-Time Manager Alerts
              </h2>
              <span className="text-xs text-slate-500 tabular-nums">
                · {unreadCount} unread
              </span>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
              <span className="inline-flex items-center gap-1.5">
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full ${
                    wsStatus === 'connected' ? 'bg-emerald-600' : 'bg-amber-500'
                  }`}
                />
                {wsStatus === 'connected'
                  ? 'WebSocket live stream connected'
                  : wsStatus === 'connecting'
                    ? 'Connecting alert stream...'
                    : 'Reconnecting alert stream...'}
              </span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">
                Limits: Lunch {rules.lunchBreakLimitMinutes}m / Other {rules.otherBreakLimitMinutes}m /
                Cutoff {rules.clockInCutoffTime}
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
            <button
              type="button"
              onClick={() => setFilterMode('all')}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
                filterMode === 'all'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              All ({notifications.length})
            </button>
            <button
              type="button"
              onClick={() => setFilterMode('unread')}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
                filterMode === 'unread'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Unread ({unreadCount})
            </button>
          </div>

          {unreadCount > 0 && (
            <button
              type="button"
              onClick={handleMarkAllRead}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 whitespace-nowrap"
            >
              <CheckCheck className="h-3.5 w-3.5" />
              <span>Mark All Read</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              setShowRules((prev) => !prev);
              setRulesNotice(null);
            }}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
              showRules
                ? 'border-teal-700 bg-teal-50 text-teal-900'
                : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
            }`}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            <span>Alert Rules</span>
          </button>
        </div>
      </div>

      {/* Collapsible Alert Rules Configuration */}
      {showRules && (
        <form
          onSubmit={handleSaveRules}
          className="border-b border-slate-200 bg-slate-50/70 px-5 py-4"
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <div>
              <label className="block text-xs font-medium text-slate-700">
                Launch / Lunch Break Limit (mins)
              </label>
              <input
                type="number"
                min={1}
                max={240}
                value={draftRules.lunchBreakLimitMinutes}
                onChange={(e) =>
                  setDraftRules((prev) => ({
                    ...prev,
                    lunchBreakLimitMinutes: Number(e.target.value) || 30,
                  }))
                }
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 font-mono text-sm text-slate-900 focus:border-teal-700 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700">
                Other Breaks Limit (mins)
              </label>
              <input
                type="number"
                min={1}
                max={240}
                value={draftRules.otherBreakLimitMinutes}
                onChange={(e) =>
                  setDraftRules((prev) => ({
                    ...prev,
                    otherBreakLimitMinutes: Number(e.target.value) || 15,
                  }))
                }
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 font-mono text-sm text-slate-900 focus:border-teal-700 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700">
                Max Staff on Break (0 = unlimited)
              </label>
              <input
                type="number"
                min={0}
                max={100}
                value={draftRules.maxConcurrentBreaks ?? 0}
                onChange={(e) => {
                  const val = Math.max(0, Math.min(100, Number(e.target.value) || 0));
                  setDraftRules((prev) => ({
                    ...prev,
                    maxConcurrentBreaks: val === 0 ? null : val,
                  }));
                }}
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 font-mono text-sm text-slate-900 focus:border-teal-700 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700">
                Missed Clock-In Cutoff Time
              </label>
              <input
                type="time"
                value={draftRules.clockInCutoffTime}
                onChange={(e) =>
                  setDraftRules((prev) => ({ ...prev, clockInCutoffTime: e.target.value }))
                }
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 font-mono text-sm text-slate-900 focus:border-teal-700 focus:outline-none"
              />
            </div>

            <div className="flex flex-col justify-between gap-2">
              <label className="flex cursor-pointer items-center gap-2 pt-5 text-xs font-medium text-slate-700">
                <input
                  type="checkbox"
                  checked={draftRules.alertOnOtherBreak}
                  onChange={(e) =>
                    setDraftRules((prev) => ({ ...prev, alertOnOtherBreak: e.target.checked }))
                  }
                  className="h-4 w-4 rounded border-slate-300 text-teal-700 focus:ring-teal-700"
                />
                <span>Alert when &apos;Other&apos; break starts</span>
              </label>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-teal-800">{rulesNotice ?? ''}</span>
            <button
              type="submit"
              disabled={savingRules}
              className="rounded-lg bg-slate-900 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-slate-800 disabled:opacity-60 whitespace-nowrap"
            >
              {savingRules ? 'Saving...' : 'Save & Evaluate Rules'}
            </button>
          </div>
        </form>
      )}

      {/* Notification List */}
      <div className="max-h-72 divide-y divide-slate-100 overflow-y-auto">
        {loading ? (
          <div className="space-y-2 p-5">
            <div className="h-12 animate-pulse rounded-lg bg-slate-100" />
            <div className="h-12 animate-pulse rounded-lg bg-slate-100" />
          </div>
        ) : visibleNotifications.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-slate-500">
            {filterMode === 'unread'
              ? 'All notifications have been read.'
              : 'No branch alerts triggered yet.'}
          </div>
        ) : (
          visibleNotifications.map((item) => {
            const isUnread = item.readAt === null;
            const severityIcon =
              item.severity === 'alert' ? (
                <AlertTriangle className="h-4 w-4 shrink-0 text-rose-600" />
              ) : item.severity === 'warning' ? (
                <Clock className="h-4 w-4 shrink-0 text-amber-600" />
              ) : (
                <Info className="h-4 w-4 shrink-0 text-teal-700" />
              );

            const severityTextClass =
              item.severity === 'alert'
                ? 'text-rose-700'
                : item.severity === 'warning'
                  ? 'text-amber-700'
                  : 'text-teal-700';

            return (
              <div
                key={item.id}
                className={`flex items-start justify-between gap-4 px-5 py-3.5 transition-colors ${
                  isUnread ? 'bg-slate-50/80' : 'bg-white'
                }`}
              >
                <div className="flex min-w-0 items-start gap-3">
                  <div className="mt-0.5">{severityIcon}</div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2 text-xs">
                      <span className={`font-semibold ${severityTextClass}`}>
                        {EVENT_LABELS[item.eventType]}
                      </span>
                      <span aria-hidden="true" className="text-slate-300">
                        ·
                      </span>
                      <span className="font-mono text-slate-500 tabular-nums">
                        {formatShortTime(item.createdAt)}
                      </span>
                      {isUnread && (
                        <>
                          <span aria-hidden="true" className="text-slate-300">
                            ·
                          </span>
                          <span className="font-semibold text-slate-900">New</span>
                        </>
                      )}
                    </div>
                    <div className="mt-0.5 text-sm font-medium text-slate-900">{item.title}</div>
                    <p className="mt-0.5 text-xs text-slate-600">{item.message}</p>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  {item.eventType === 'setup_password' && onNavigateToPassword && (
                    <button
                      type="button"
                      onClick={onNavigateToPassword}
                      className="rounded-md bg-teal-700 px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:bg-teal-800 whitespace-nowrap"
                    >
                      Create Password
                    </button>
                  )}
                  {item.eventType === 'setup_staff' && onNavigateToAddStaff && (
                    <button
                      type="button"
                      onClick={onNavigateToAddStaff}
                      className="rounded-md bg-slate-900 px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:bg-slate-800 whitespace-nowrap"
                    >
                      Add Staff
                    </button>
                  )}
                  {isUnread && (
                    <button
                      type="button"
                      onClick={() => handleMarkRead(item.id)}
                      title="Mark as read"
                      className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 whitespace-nowrap"
                    >
                      <Check className="inline h-3.5 w-3.5 mr-1" />
                      Read
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handleDismiss(item.id)}
                    title="Dismiss alert"
                    aria-label="Dismiss alert"
                    className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
