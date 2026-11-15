import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Calendar,
  CheckCircle2,
  Clock,
  Download,
  KeyRound,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Users,
} from 'lucide-react';
import {
  changeManagerPassword,
  createEmployee,
  deactivateEmployee,
  fetchAlertRules,
  fetchManagerHistory,
  fetchManagerToday,
  regenerateEmployeeSecretCode,
  updateAlertRules,
} from '../api';
import type {
  BranchInfo,
  EmployeeStatus,
  ManagerHistoryResponse,
  ManagerTodayResponse,
  PeakBreakRule,
} from '../types';
import {
  formatDisplayDate,
  formatDisplayMonth,
  formatDurationClock,
  formatDurationCompact,
  formatShortTime,
  formatTime,
  getInitials,
  getLocalDateKey,
  getLocalMonthKey,
} from '../utils/format';
import { EmployeePerformanceAnalytics } from './EmployeePerformanceAnalytics';
import { ManagerNotificationsPanel } from './ManagerNotificationsPanel';

type ManagerSection = 'overview' | 'today' | 'analytics' | 'history' | 'settings';

interface ManagerDashboardProps {
  branch?: BranchInfo | null;
  isDefaultPassword: boolean;
  onPasswordChanged: () => void;
  onSessionExpired: () => void;
}

const STATUS_META: Record<EmployeeStatus, { label: string; className: string }> = {
  in_branch: { label: 'In Branch', className: 'text-emerald-700' },
  on_break: { label: 'On Break', className: 'text-amber-700' },
  off_shift: { label: 'Off Shift', className: 'text-slate-500' },
};

export function ManagerDashboard({
  branch,
  isDefaultPassword,
  onPasswordChanged,
  onSessionExpired,
}: ManagerDashboardProps) {
  const [activeSection, setActiveSection] = useState<ManagerSection>('overview');
  const [refreshSignal, setRefreshSignal] = useState(0);
  const newPasswordInputRef = useRef<HTMLInputElement | null>(null);
  const newStaffNameInputRef = useRef<HTMLInputElement | null>(null);

  // Live clock for in-process break timers
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Today state
  const [todayData, setTodayData] = useState<ManagerTodayResponse | null>(null);
  const [todayLoading, setTodayLoading] = useState(true);
  const [todayError, setTodayError] = useState<string | null>(null);

  // History state
  const [historyMode, setHistoryMode] = useState<'date' | 'month'>('date');
  const [historyDate, setHistoryDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return getLocalDateKey(d);
  });
  const [historyMonth, setHistoryMonth] = useState(() => getLocalMonthKey());
  const [historyEmployeeId, setHistoryEmployeeId] = useState<string>('');
  const [historySearch, setHistorySearch] = useState('');
  const [historyData, setHistoryData] = useState<ManagerHistoryResponse | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);

  // Staff creation form
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState('');
  const [newCode, setNewCode] = useState('');
  const [staffActionMsg, setStaffActionMsg] = useState<string | null>(null);
  const [staffActionErr, setStaffActionErr] = useState<string | null>(null);
  const [addingStaff, setAddingStaff] = useState(false);

  // Password change form
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [pwErr, setPwErr] = useState<string | null>(null);
  const [savingPw, setSavingPw] = useState(false);

  // Concurrent break threshold settings
  const [thresholdLimitEnabled, setThresholdLimitEnabled] = useState(false);
  const [thresholdCount, setThresholdCount] = useState<number>(2);
  const [savingThreshold, setSavingThreshold] = useState(false);
  const [thresholdMsg, setThresholdMsg] = useState<string | null>(null);
  const [thresholdErr, setThresholdErr] = useState<string | null>(null);

  // Peak time break thresholds
  const [peakRules, setPeakRules] = useState<PeakBreakRule[]>([]);
  const [peakLabel, setPeakLabel] = useState('');
  const [peakStartTime, setPeakStartTime] = useState('10:00');
  const [peakEndTime, setPeakEndTime] = useState('13:00');
  const [peakMaxBreaks, setPeakMaxBreaks] = useState<number>(1);
  const [savingPeak, setSavingPeak] = useState(false);
  const [peakMsg, setPeakMsg] = useState<string | null>(null);
  const [peakErr, setPeakErr] = useState<string | null>(null);

  const handleAuthError = useCallback(
    (err: unknown): boolean => {
      if (typeof err === 'object' && err !== null && 'status' in err && (err as { status?: number }).status === 401) {
        onSessionExpired();
        return true;
      }
      return false;
    },
    [onSessionExpired]
  );

  const loadToday = useCallback(async () => {
    try {
      setTodayError(null);
      const res = await fetchManagerToday(getLocalDateKey());
      setTodayData(res);
      const std = res.effectiveBreakPolicy?.standardLimit ?? res.maxConcurrentBreaks;
      if (std !== null && std >= 1) {
        setThresholdLimitEnabled(true);
        setThresholdCount(std);
      } else {
        setThresholdLimitEnabled(false);
      }
    } catch (err) {
      if (handleAuthError(err)) return;
      setTodayError(err instanceof Error ? err.message : 'Unable to load Today dashboard.');
    } finally {
      setTodayLoading(false);
    }
  }, [handleAuthError]);

  const loadRulesForSettings = useCallback(async () => {
    try {
      const res = await fetchAlertRules();
      if (res.rules.maxConcurrentBreaks !== null && res.rules.maxConcurrentBreaks >= 1) {
        setThresholdLimitEnabled(true);
        setThresholdCount(res.rules.maxConcurrentBreaks);
      } else {
        setThresholdLimitEnabled(false);
      }
      setPeakRules(res.rules.peakBreakRules ?? []);
    } catch (err) {
      handleAuthError(err);
    }
  }, [handleAuthError]);

  const loadHistory = useCallback(async () => {
    try {
      setHistoryLoading(true);
      setHistoryError(null);
      const res = await fetchManagerHistory({
        mode: historyMode,
        date: historyDate,
        month: historyMonth,
        employeeId: historyEmployeeId || undefined,
      });
      setHistoryData(res);
    } catch (err) {
      if (handleAuthError(err)) return;
      setHistoryError(err instanceof Error ? err.message : 'Unable to load history records.');
    } finally {
      setHistoryLoading(false);
    }
  }, [historyMode, historyDate, historyMonth, historyEmployeeId, handleAuthError]);

  useEffect(() => {
    loadToday();
    const poll = window.setInterval(loadToday, 15000);
    return () => window.clearInterval(poll);
  }, [loadToday]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    if (activeSection === 'settings') {
      loadRulesForSettings();
    }
  }, [activeSection, loadRulesForSettings]);

  const todayTotalCollectiveSeconds = useMemo(() => {
    if (!todayData) return 0;
    return todayData.employeeSummaries.reduce(
      (sum, item) => sum + item.collectiveCompletedSeconds,
      0
    );
  }, [todayData]);

  const filteredHistorySummaries = useMemo(() => {
    if (!historyData) return [];
    const q = historySearch.trim().toLowerCase();
    return historyData.employeeSummaries.filter((s) => {
      const hasActivity = s.totalBreaks > 0 || (s.daysLogged ?? 0) > 0;
      if (!hasActivity && !historyEmployeeId) return false;
      if (!q) return true;
      return (
        s.employeeName.toLowerCase().includes(q) ||
        s.employeeCode.toLowerCase().includes(q) ||
        s.employeeRole.toLowerCase().includes(q)
      );
    });
  }, [historyData, historySearch, historyEmployeeId]);

  const filteredHistoryBreaks = useMemo(() => {
    if (!historyData) return [];
    const q = historySearch.trim().toLowerCase();
    if (!q) return historyData.breaks;
    return historyData.breaks.filter(
      (b) =>
        b.employeeName.toLowerCase().includes(q) ||
        b.employeeCode.toLowerCase().includes(q) ||
        b.reasonCategory.toLowerCase().includes(q) ||
        (b.customReason && b.customReason.toLowerCase().includes(q))
    );
  }, [historyData, historySearch]);

  const filteredHistoryLogs = useMemo(() => {
    if (!historyData) return [];
    const q = historySearch.trim().toLowerCase();
    if (!q) return historyData.logs;
    return historyData.logs.filter(
      (l) =>
        l.employeeName.toLowerCase().includes(q) ||
        l.employeeCode.toLowerCase().includes(q) ||
        l.reasonCategory.toLowerCase().includes(q) ||
        (l.customReason && l.customReason.toLowerCase().includes(q))
    );
  }, [historyData, historySearch]);

  const handleExportCsv = () => {
    if (!historyData) return;
    const rows: string[][] = [
      ['Date', 'Employee Code', 'Employee Name', 'Role', 'Direction / Type', 'Reason', 'Manual Reason', 'Out / Punch Time', 'In Time', 'Duration (Seconds)', 'Status'],
    ];

    for (const br of filteredHistoryBreaks) {
      rows.push([
        br.dateKey,
        br.employeeCode,
        br.employeeName,
        br.employeeRole,
        'BREAK',
        br.reasonCategory,
        br.customReason ?? '',
        br.outTime,
        br.inTime ?? '',
        String(br.durationSeconds ?? ''),
        br.status,
      ]);
    }

    for (const lg of filteredHistoryLogs) {
      rows.push([
        lg.dateKey,
        lg.employeeCode,
        lg.employeeName,
        lg.employeeRole,
        `PUNCH_${lg.direction}`,
        lg.reasonCategory,
        lg.customReason ?? '',
        lg.timestamp,
        '',
        '',
        'recorded',
      ]);
    }

    const escapeCsv = (val: string) => `"${val.replace(/"/g, '""')}"`;
    const csv = rows.map((r) => r.map(escapeCsv).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `branch-history-${historyData.mode}-${historyData.filterValue}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleAddEmployee = async (e: React.FormEvent) => {
    e.preventDefault();
    setStaffActionErr(null);
    setStaffActionMsg(null);
    setAddingStaff(true);
    try {
      const res = await createEmployee({
        name: newName,
        role: newRole,
        code: newCode || undefined,
      });
      setStaffActionMsg(
        `Added ${res.employee.name} (${res.employee.code}) · Auto-assigned Secret Code: ${res.employee.secretCode}`
      );
      setNewName('');
      setNewRole('');
      setNewCode('');
      setRefreshSignal((s) => s + 1);
      await Promise.all([loadToday(), loadHistory()]);
    } catch (err) {
      if (handleAuthError(err)) return;
      setStaffActionErr(err instanceof Error ? err.message : 'Unable to add employee.');
    } finally {
      setAddingStaff(false);
    }
  };

  const handleRegenerateSecretCode = async (id: string, name: string) => {
    setStaffActionErr(null);
    setStaffActionMsg(null);
    try {
      const res = await regenerateEmployeeSecretCode(id);
      setStaffActionMsg(`New 4-digit secret code for ${name}: ${res.employee.secretCode}`);
      await Promise.all([loadToday(), loadHistory()]);
    } catch (err) {
      if (handleAuthError(err)) return;
      setStaffActionErr(err instanceof Error ? err.message : 'Unable to regenerate secret code.');
    }
  };

  const handleDeactivateEmployee = async (id: string, name: string) => {
    setStaffActionErr(null);
    setStaffActionMsg(null);
    try {
      await deactivateEmployee(id);
      setStaffActionMsg(`Removed ${name} from active terminal roster. Historical records preserved.`);
      await Promise.all([loadToday(), loadHistory()]);
    } catch (err) {
      if (handleAuthError(err)) return;
      setStaffActionErr(err instanceof Error ? err.message : 'Unable to deactivate employee.');
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwErr(null);
    setPwMsg(null);
    if (newPw.trim().length < 4) {
      setPwErr('New password must be at least 4 characters.');
      return;
    }
    if (newPw !== confirmPw) {
      setPwErr('New password and confirmation do not match.');
      return;
    }

    setSavingPw(true);
    try {
      await changeManagerPassword(currentPw, newPw, isDefaultPassword);
      setPwMsg(
        isDefaultPassword
          ? 'New manager portal password created successfully.'
          : 'Manager password updated successfully.'
      );
      setCurrentPw('');
      setNewPw('');
      setConfirmPw('');
      setRefreshSignal((s) => s + 1);
      onPasswordChanged();
    } catch (err) {
      if (handleAuthError(err)) return;
      setPwErr(err instanceof Error ? err.message : 'Unable to update password.');
    } finally {
      setSavingPw(false);
    }
  };

  const handleSaveThreshold = async (e: React.FormEvent) => {
    e.preventDefault();
    setThresholdErr(null);
    setThresholdMsg(null);
    if (thresholdLimitEnabled && (!Number.isFinite(thresholdCount) || thresholdCount < 1)) {
      setThresholdErr('Enter at least 1 staff member for the concurrent break threshold.');
      return;
    }

    setSavingThreshold(true);
    try {
      const nextVal = thresholdLimitEnabled ? Math.round(thresholdCount) : null;
      const res = await updateAlertRules({ maxConcurrentBreaks: nextVal });
      setThresholdMsg(
        res.rules.maxConcurrentBreaks !== null
          ? `Threshold saved: maximum ${res.rules.maxConcurrentBreaks} staff can be on break at a time.`
          : 'Break threshold disabled (unlimited staff can take breaks simultaneously).'
      );
      await loadToday();
    } catch (err) {
      if (handleAuthError(err)) return;
      setThresholdErr(err instanceof Error ? err.message : 'Unable to save break threshold.');
    } finally {
      setSavingThreshold(false);
    }
  };

  const handleAddPeakRule = async (e: React.FormEvent) => {
    e.preventDefault();
    setPeakErr(null);
    setPeakMsg(null);

    if (!/^\d{2}:\d{2}$/.test(peakStartTime) || !/^\d{2}:\d{2}$/.test(peakEndTime)) {
      setPeakErr('Please enter valid peak start and end times.');
      return;
    }
    if (peakStartTime === peakEndTime) {
      setPeakErr('Peak start time and end time must be different.');
      return;
    }
    if (!Number.isFinite(peakMaxBreaks) || peakMaxBreaks < 0 || peakMaxBreaks > 100) {
      setPeakErr('Mark out threshold must be between 0 and 100.');
      return;
    }

    const newRule: PeakBreakRule = {
      id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `pk-${Date.now()}`,
      label: peakLabel.trim() || 'Peak Hours',
      startTime: peakStartTime,
      endTime: peakEndTime,
      maxConcurrentBreaks: Math.round(peakMaxBreaks),
      enabled: true,
    };

    const nextRules = [...peakRules, newRule];
    setSavingPeak(true);
    try {
      const res = await updateAlertRules({ peakBreakRules: nextRules });
      setPeakRules(res.rules.peakBreakRules ?? nextRules);
      setPeakLabel('');
      setPeakMsg(
        `Created peak threshold "${newRule.label}" (${newRule.startTime}–${newRule.endTime}, max ${newRule.maxConcurrentBreaks} out).`
      );
      await loadToday();
    } catch (err) {
      if (handleAuthError(err)) return;
      setPeakErr(err instanceof Error ? err.message : 'Unable to save peak threshold.');
    } finally {
      setSavingPeak(false);
    }
  };

  const handleTogglePeakRule = async (ruleId: string) => {
    setPeakErr(null);
    setPeakMsg(null);
    const nextRules = peakRules.map((r) => (r.id === ruleId ? { ...r, enabled: !r.enabled } : r));
    setSavingPeak(true);
    try {
      const res = await updateAlertRules({ peakBreakRules: nextRules });
      setPeakRules(res.rules.peakBreakRules ?? nextRules);
      await loadToday();
    } catch (err) {
      if (handleAuthError(err)) return;
      setPeakErr(err instanceof Error ? err.message : 'Unable to update peak threshold.');
    } finally {
      setSavingPeak(false);
    }
  };

  const handleDeletePeakRule = async (ruleId: string) => {
    setPeakErr(null);
    setPeakMsg(null);
    const nextRules = peakRules.filter((r) => r.id !== ruleId);
    setSavingPeak(true);
    try {
      const res = await updateAlertRules({ peakBreakRules: nextRules });
      setPeakRules(res.rules.peakBreakRules ?? nextRules);
      setPeakMsg('Peak time threshold removed.');
      await loadToday();
    } catch (err) {
      if (handleAuthError(err)) return;
      setPeakErr(err instanceof Error ? err.message : 'Unable to remove peak threshold.');
    } finally {
      setSavingPeak(false);
    }
  };

  const showToday = activeSection === 'overview' || activeSection === 'today';
  const showAnalytics = activeSection === 'overview' || activeSection === 'analytics';
  const showHistory = activeSection === 'overview' || activeSection === 'history';
  const showSettings = activeSection === 'settings';

  const handleRealtimeRefresh = useCallback(() => {
    setRefreshSignal((s) => s + 1);
    loadToday();
    loadHistory();
  }, [loadToday, loadHistory]);

  const needsStaffSetup = todayData !== null && todayData.employeeSummaries.length === 0;

  const jumpToPasswordSetup = useCallback(() => {
    setActiveSection('settings');
    window.requestAnimationFrame(() => {
      newPasswordInputRef.current?.focus();
    });
  }, []);

  const jumpToAddStaff = useCallback(() => {
    setActiveSection('settings');
    window.requestAnimationFrame(() => {
      newStaffNameInputRef.current?.focus();
    });
  }, []);

  return (
    <div className="space-y-8">
      {/* Manager Header + Section Switch */}
      <div className="flex flex-col gap-4 border-b border-slate-200 pb-6 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
            Manager Operations Dashboard
          </h1>
          <p className="mt-1.5 text-sm text-slate-600">
            Real-time branch break supervision, employee performance analytics, and history archives.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap items-center gap-1 rounded-lg bg-slate-100 p-1">
            {(
              [
                { id: 'overview', label: 'All Sections' },
                { id: 'today', label: 'Today' },
                { id: 'analytics', label: 'Analytics' },
                { id: 'history', label: 'History' },
                { id: 'settings', label: 'Staff & Settings' },
              ] as { id: ManagerSection; label: string }[]
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveSection(tab.id)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  activeSection === tab.id
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={handleRealtimeRefresh}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {!showSettings && (
        <ManagerNotificationsPanel
          refreshSignal={refreshSignal}
          onDashboardEvent={handleRealtimeRefresh}
          onAuthError={onSessionExpired}
          onNavigateToPassword={jumpToPasswordSetup}
          onNavigateToAddStaff={jumpToAddStaff}
        />
      )}

      {(isDefaultPassword || needsStaffSetup) && activeSection !== 'settings' && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/90 p-5 text-amber-950">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-sm font-semibold text-amber-950">
                Complete Your Branch Setup
              </h2>
              <p className="mt-0.5 text-xs text-amber-900">
                {branch
                  ? `Branch ${branch.branchName} (${branch.email} · Setup ID ${branch.setupCode}) is ready.`
                  : 'Complete these onboarding steps before opening the staff terminal.'}
              </p>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {isDefaultPassword && (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-white px-4 py-3">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-slate-900">
                    1. Create New Manager Portal Password
                  </div>
                  <p className="mt-0.5 text-xs text-slate-600">
                    Replace the temporary setup password before locking the portal.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={jumpToPasswordSetup}
                  className="rounded-lg bg-teal-700 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-teal-800 whitespace-nowrap shrink-0"
                >
                  Create Password
                </button>
              </div>
            )}

            {needsStaffSetup && (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-white px-4 py-3">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-slate-900">
                    {isDefaultPassword ? '2. ' : '1. '}Add Branch Staff Members
                  </div>
                  <p className="mt-0.5 text-xs text-slate-600">
                    Each staff member automatically receives a 4-digit secret code.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={jumpToAddStaff}
                  className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-slate-800 whitespace-nowrap shrink-0"
                >
                  Add Staff
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ===================================================================== */}
      {/* TODAY HEADING                                                         */}
      {/* ===================================================================== */}
      {showToday && (
        <section aria-labelledby="today-heading" className="space-y-6">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
            <div>
              <h2 id="today-heading" className="text-xl font-semibold text-slate-900">
                Today
              </h2>
              <p className="text-sm text-slate-500">
                {todayData ? formatDisplayDate(todayData.dateKey) : formatDisplayDate(getLocalDateKey())}
              </p>
            </div>
            {todayData && (
              <div className="text-xs text-slate-500 tabular-nums">
                {todayData.activeStaffCount} in branch · {todayData.breaksInProcess.length} on break ·{' '}
                {todayData.offShiftCount} off shift
              </div>
            )}
          </div>

          {todayError && (
            <div className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{todayError}</span>
            </div>
          )}

          {/* Today KPI Strip */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <div className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
              <div className="text-xs font-medium text-slate-500">Staff In Branch</div>
              <div className="mt-2 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
                {todayLoading ? '—' : todayData?.activeStaffCount ?? 0}
              </div>
              <div className="mt-1 text-xs text-slate-500">Currently on floor</div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
              <div className="text-xs font-medium text-slate-500">Breaks in Process</div>
              <div className="mt-2 font-mono text-2xl font-semibold text-amber-700 tabular-nums">
                {todayLoading ? '—' : todayData?.breaksInProcess.length ?? 0}
              </div>
              <div className="mt-1 text-xs text-slate-500">
                {todayData?.effectiveBreakPolicy?.activeMode === 'peak' &&
                todayData.effectiveBreakPolicy.activePeakRule
                  ? `Peak (${todayData.effectiveBreakPolicy.activePeakRule.startTime}–${todayData.effectiveBreakPolicy.activePeakRule.endTime}): max ${todayData.effectiveBreakPolicy.maxConcurrentBreaks}`
                  : todayData?.maxConcurrentBreaks !== null &&
                      todayData?.maxConcurrentBreaks !== undefined
                    ? `Limit: ${todayData.maxConcurrentBreaks} at a time`
                    : 'Active right now'}
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
              <div className="text-xs font-medium text-slate-500">Breaks Already Done</div>
              <div className="mt-2 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
                {todayLoading ? '—' : todayData?.breaksDone.length ?? 0}
              </div>
              <div className="mt-1 text-xs text-slate-500">Completed today</div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
              <div className="text-xs font-medium text-slate-500">Collective Break Time</div>
              <div className="mt-2 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
                {todayLoading ? '—' : formatDurationCompact(todayTotalCollectiveSeconds)}
              </div>
              <div className="mt-1 text-xs text-slate-500">All staff completed today</div>
            </div>
          </div>

          {/* Breaks in Process + Breaks Already Done */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            {/* Breaks in Process */}
            <div className="rounded-xl border border-slate-200 bg-white lg:col-span-5">
              <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
                <h3 className="text-base font-semibold text-slate-900">Breaks in Process</h3>
                <span className="font-mono text-xs font-medium text-amber-700 tabular-nums">
                  {todayData?.breaksInProcess.length ?? 0}
                  {todayData?.maxConcurrentBreaks !== null &&
                  todayData?.maxConcurrentBreaks !== undefined
                    ? ` / ${todayData.maxConcurrentBreaks} max${
                        todayData.effectiveBreakPolicy?.activeMode === 'peak' ? ' (Peak)' : ''
                      }`
                    : ' active'}
                </span>
              </div>

              {todayLoading ? (
                <div className="space-y-3 p-5">
                  <div className="h-14 animate-pulse rounded-lg bg-slate-100" />
                  <div className="h-14 animate-pulse rounded-lg bg-slate-100" />
                </div>
              ) : !todayData || todayData.breaksInProcess.length === 0 ? (
                <div className="px-5 py-10 text-center text-sm text-slate-500">
                  No staff members are currently out on a break.
                </div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {todayData.breaksInProcess.map((br) => {
                    const elapsedSec = Math.max(
                      0,
                      Math.floor((nowMs - new Date(br.outTime).getTime()) / 1000)
                    );
                    return (
                      <div key={br.id} className="flex items-center justify-between gap-4 px-5 py-4">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-slate-900">
                            {br.employeeName}
                            <span className="ml-2 font-mono text-xs font-normal text-slate-400">
                              {br.employeeCode}
                            </span>
                          </div>
                          <div className="mt-0.5 text-xs text-slate-600">
                            <span>{br.reasonCategory}</span>
                            {br.customReason && (
                              <>
                                <span aria-hidden="true"> · </span>
                                <span className="text-slate-700">{br.customReason}</span>
                              </>
                            )}
                            <span aria-hidden="true"> · </span>
                            <span className="font-mono tabular-nums">Out {formatShortTime(br.outTime)}</span>
                          </div>
                        </div>

                        <div className="shrink-0 text-right">
                          <div className="font-mono text-base font-semibold text-amber-700 tabular-nums">
                            {formatDurationClock(elapsedSec)}
                          </div>
                          <div className="text-xs text-slate-400">Elapsed</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Breaks Already Done */}
            <div className="rounded-xl border border-slate-200 bg-white lg:col-span-7">
              <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
                <h3 className="text-base font-semibold text-slate-900">Breaks Already Done</h3>
                <span className="font-mono text-xs text-slate-500 tabular-nums">
                  {todayData?.breaksDone.length ?? 0} completed
                </span>
              </div>

              {todayLoading ? (
                <div className="space-y-3 p-5">
                  <div className="h-12 animate-pulse rounded-lg bg-slate-100" />
                  <div className="h-12 animate-pulse rounded-lg bg-slate-100" />
                </div>
              ) : !todayData || todayData.breaksDone.length === 0 ? (
                <div className="px-5 py-10 text-center text-sm text-slate-500">
                  No completed breaks recorded today yet.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-left text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                        <th className="px-5 py-3">Employee</th>
                        <th className="px-5 py-3">Reason</th>
                        <th className="px-5 py-3">Out</th>
                        <th className="px-5 py-3">In</th>
                        <th className="px-5 py-3 text-right">Duration</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {todayData.breaksDone.map((br) => (
                        <tr key={br.id} className="hover:bg-slate-50/60">
                          <td className="px-5 py-3 font-medium text-slate-900 whitespace-nowrap">
                            {br.employeeName}
                          </td>
                          <td className="px-5 py-3 text-slate-700">
                            <div>{br.reasonCategory}</div>
                            {br.customReason && (
                              <div className="text-xs text-slate-500">{br.customReason}</div>
                            )}
                          </td>
                          <td className="px-5 py-3 font-mono text-xs text-slate-600 tabular-nums whitespace-nowrap">
                            {formatShortTime(br.outTime)}
                          </td>
                          <td className="px-5 py-3 font-mono text-xs text-slate-600 tabular-nums whitespace-nowrap">
                            {formatShortTime(br.inTime)}
                          </td>
                          <td className="px-5 py-3 text-right font-mono text-xs font-semibold text-slate-900 tabular-nums whitespace-nowrap">
                            {formatDurationCompact(br.durationSeconds)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          {/* Per-Employee Break Count & Collective Break Time Today */}
          <div className="rounded-xl border border-slate-200 bg-white">
            <div className="flex flex-col gap-1 border-b border-slate-200 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <h3 className="text-base font-semibold text-slate-900">
                Today&apos;s Break Summary per Employee
              </h3>
              <span className="text-xs text-slate-500">
                Total breaks count and collective break duration per staff member
              </span>
            </div>

            {todayLoading ? (
              <div className="space-y-3 p-5">
                {[1, 2, 3].map((n) => (
                  <div key={n} className="h-12 animate-pulse rounded-lg bg-slate-100" />
                ))}
              </div>
            ) : !todayData || todayData.employeeSummaries.length === 0 ? (
              <div className="px-5 py-10 text-center text-sm text-slate-500">
                No active staff members found.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                      <th className="px-5 py-3">Employee</th>
                      <th className="px-5 py-3">Status</th>
                      <th className="px-5 py-3">Shift Window</th>
                      <th className="px-5 py-3 text-right">Total Breaks</th>
                      <th className="px-5 py-3 text-right">Collective Time</th>
                      <th className="px-5 py-3">Breakdown by Reason</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {todayData.employeeSummaries.map((row) => {
                      const statusMeta = row.currentStatus
                        ? STATUS_META[row.currentStatus]
                        : STATUS_META.off_shift;

                      const activeExtraSec =
                        row.inProgressBreaks > 0 && row.activeBreakOutTime
                          ? Math.max(
                              0,
                              Math.floor(
                                (nowMs - new Date(row.activeBreakOutTime).getTime()) / 1000
                              )
                            )
                          : 0;

                      const breakdownParts = Object.entries(row.reasonBreakdown).map(
                        ([reason, info]) =>
                          `${reason} (${info.count}${info.seconds > 0 ? ` · ${formatDurationCompact(info.seconds)}` : ''})`
                      );

                      return (
                        <tr key={row.employeeId} className="hover:bg-slate-50/60">
                          <td className="px-5 py-3.5 whitespace-nowrap">
                            <div className="flex items-center gap-3">
                              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-xs font-semibold text-slate-700">
                                {getInitials(row.employeeName)}
                              </div>
                              <div>
                                <div className="font-medium text-slate-900">{row.employeeName}</div>
                                <div className="text-xs text-slate-500">
                                  <span className="font-mono">{row.employeeCode}</span>
                                  <span aria-hidden="true"> · </span>
                                  <span>{row.employeeRole}</span>
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="px-5 py-3.5 whitespace-nowrap">
                            <span className={`text-xs font-semibold ${statusMeta.className}`}>
                              {statusMeta.label}
                            </span>
                          </td>
                          <td className="px-5 py-3.5 font-mono text-xs text-slate-600 tabular-nums whitespace-nowrap">
                            {row.shiftStartTime ? formatShortTime(row.shiftStartTime) : '—'}
                            {row.shiftEndTime ? ` – ${formatShortTime(row.shiftEndTime)}` : ''}
                          </td>
                          <td className="px-5 py-3.5 text-right font-mono font-semibold text-slate-900 tabular-nums whitespace-nowrap">
                            {row.totalBreaks}
                            {row.inProgressBreaks > 0 && (
                              <span className="ml-1.5 text-xs font-normal text-amber-700">
                                ({row.inProgressBreaks} live)
                              </span>
                            )}
                          </td>
                          <td className="px-5 py-3.5 text-right font-mono font-semibold text-slate-900 tabular-nums whitespace-nowrap">
                            {formatDurationCompact(row.collectiveCompletedSeconds + activeExtraSec)}
                            {activeExtraSec > 0 && (
                              <div className="text-xs font-normal text-amber-700">
                                incl. {formatDurationClock(activeExtraSec)} active
                              </div>
                            )}
                          </td>
                          <td className="px-5 py-3.5 text-xs text-slate-600">
                            {breakdownParts.length > 0 ? breakdownParts.join(' · ') : 'No breaks'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      )}

      {/* ===================================================================== */}
      {/* HISTORY HEADING                                                       */}
      {/* ===================================================================== */}
      {showHistory && (
        <section aria-labelledby="history-heading" className="space-y-6 border-t border-slate-200 pt-8">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h2 id="history-heading" className="text-xl font-semibold text-slate-900">
                History
              </h2>
              <p className="text-sm text-slate-500">
                All saved employee attendance and break records, filtered date-wise or month-wise.
              </p>
            </div>

            <button
              type="button"
              onClick={handleExportCsv}
              disabled={!historyData || (filteredHistoryBreaks.length === 0 && filteredHistoryLogs.length === 0)}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Export CSV</span>
            </button>
          </div>

          {/* Filter Toolbar */}
          <div className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex flex-wrap items-center gap-3">
                {/* Date-wise / Month-wise Segmented Control */}
                <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
                  <button
                    type="button"
                    onClick={() => setHistoryMode('date')}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                      historyMode === 'date'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Date-wise
                  </button>
                  <button
                    type="button"
                    onClick={() => setHistoryMode('month')}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                      historyMode === 'month'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Month-wise
                  </button>
                </div>

                {/* Date or Month Picker */}
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-slate-400" />
                  {historyMode === 'date' ? (
                    <input
                      type="date"
                      value={historyDate}
                      onChange={(e) => setHistoryDate(e.target.value)}
                      className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 font-mono text-xs text-slate-900 focus:border-teal-700 focus:bg-white focus:outline-none"
                    />
                  ) : (
                    <input
                      type="month"
                      value={historyMonth}
                      onChange={(e) => setHistoryMonth(e.target.value)}
                      className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 font-mono text-xs text-slate-900 focus:border-teal-700 focus:bg-white focus:outline-none"
                    />
                  )}
                </div>

                {/* Employee Filter */}
                <select
                  value={historyEmployeeId}
                  onChange={(e) => setHistoryEmployeeId(e.target.value)}
                  className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-900 focus:border-teal-700 focus:bg-white focus:outline-none"
                >
                  <option value="">All Employees</option>
                  {(historyData?.employees ?? []).map((emp) => (
                    <option key={emp.id} value={emp.id}>
                      {emp.name} ({emp.code})
                    </option>
                  ))}
                </select>
              </div>

              {/* Search Input */}
              <div className="relative w-full lg:w-64">
                <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={historySearch}
                  onChange={(e) => setHistorySearch(e.target.value)}
                  placeholder="Search employee or reason..."
                  className="w-full rounded-lg border border-slate-200 bg-slate-50 py-1.5 pr-3 pl-8 text-xs text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:bg-white focus:outline-none"
                />
              </div>
            </div>

            {/* Quick-jump saved dates or months */}
            {historyData && (
              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 text-xs">
                <span className="text-slate-500">
                  Saved {historyMode === 'date' ? 'dates' : 'months'}:
                </span>
                {historyMode === 'date'
                  ? historyData.availableDates.slice(0, 8).map((d) => (
                      <button
                        key={d}
                        type="button"
                        onClick={() => setHistoryDate(d)}
                        className={`rounded-md border px-2.5 py-1 font-mono transition-colors whitespace-nowrap ${
                          historyDate === d
                            ? 'border-teal-700 bg-teal-50 text-teal-900 font-medium'
                            : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        {d}
                      </button>
                    ))
                  : historyData.availableMonths.slice(0, 8).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setHistoryMonth(m)}
                        className={`rounded-md border px-2.5 py-1 font-mono transition-colors whitespace-nowrap ${
                          historyMonth === m
                            ? 'border-teal-700 bg-teal-50 text-teal-900 font-medium'
                            : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        {m}
                      </button>
                    ))}
              </div>
            )}
          </div>

          {historyError && (
            <div className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{historyError}</span>
            </div>
          )}

          {/* History Period Summary per Employee */}
          <div className="rounded-xl border border-slate-200 bg-white">
            <div className="flex flex-col gap-1 border-b border-slate-200 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <h3 className="text-base font-semibold text-slate-900">
                {historyMode === 'date'
                  ? `Employee Summary · ${formatDisplayDate(historyDate)}`
                  : `Monthly Summary · ${formatDisplayMonth(historyMonth)}`}
              </h3>
              <span className="text-xs text-slate-500 tabular-nums">
                {filteredHistoryBreaks.length} break sessions · {filteredHistoryLogs.length} In/Out punches
              </span>
            </div>

            {historyLoading ? (
              <div className="space-y-3 p-5">
                {[1, 2, 3].map((n) => (
                  <div key={n} className="h-12 animate-pulse rounded-lg bg-slate-100" />
                ))}
              </div>
            ) : filteredHistorySummaries.length === 0 ? (
              <div className="px-5 py-10 text-center text-sm text-slate-500">
                No saved employee records found for this {historyMode === 'date' ? 'date' : 'month'}.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                      <th className="px-5 py-3">Employee</th>
                      <th className="px-5 py-3">
                        {historyMode === 'month' ? 'Days Logged' : 'Shift Window'}
                      </th>
                      <th className="px-5 py-3 text-right">Total Breaks</th>
                      <th className="px-5 py-3 text-right">Collective Break Time</th>
                      <th className="px-5 py-3 text-right">Avg Break</th>
                      <th className="px-5 py-3">Break Categories</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredHistorySummaries.map((row) => {
                      const avgSec =
                        row.completedBreaks > 0
                          ? Math.round(row.collectiveCompletedSeconds / row.completedBreaks)
                          : 0;
                      const cats = Object.entries(row.reasonBreakdown).map(
                        ([reason, info]) =>
                          `${reason} (${info.count}${info.seconds > 0 ? ` · ${formatDurationCompact(info.seconds)}` : ''})`
                      );
                      return (
                        <tr key={row.employeeId} className="hover:bg-slate-50/60">
                          <td className="px-5 py-3.5 whitespace-nowrap">
                            <div className="font-medium text-slate-900">{row.employeeName}</div>
                            <div className="text-xs text-slate-500">
                              <span className="font-mono">{row.employeeCode}</span>
                              <span aria-hidden="true"> · </span>
                              <span>{row.employeeRole}</span>
                            </div>
                          </td>
                          <td className="px-5 py-3.5 font-mono text-xs text-slate-600 tabular-nums whitespace-nowrap">
                            {historyMode === 'month'
                              ? `${row.daysLogged ?? 0} ${row.daysLogged === 1 ? 'day' : 'days'}`
                              : `${row.shiftStartTime ? formatShortTime(row.shiftStartTime) : '—'}${row.shiftEndTime ? ` – ${formatShortTime(row.shiftEndTime)}` : ''}`}
                          </td>
                          <td className="px-5 py-3.5 text-right font-mono font-semibold text-slate-900 tabular-nums whitespace-nowrap">
                            {row.totalBreaks}
                          </td>
                          <td className="px-5 py-3.5 text-right font-mono font-semibold text-slate-900 tabular-nums whitespace-nowrap">
                            {formatDurationCompact(row.collectiveCompletedSeconds)}
                          </td>
                          <td className="px-5 py-3.5 text-right font-mono text-xs text-slate-600 tabular-nums whitespace-nowrap">
                            {row.completedBreaks > 0 ? formatDurationCompact(avgSec) : '—'}
                          </td>
                          <td className="px-5 py-3.5 text-xs text-slate-600">
                            {cats.length > 0 ? cats.join(' · ') : 'Shift logs only'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Detailed Saved Break Sessions & Raw In/Out Logs */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {/* Break History Table */}
            <div className="rounded-xl border border-slate-200 bg-white">
              <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-5 py-4">
                <h3 className="text-base font-semibold text-slate-900">Saved Break Sessions</h3>
                <span className="font-mono text-xs text-slate-500 tabular-nums">
                  {filteredHistoryBreaks.length} records
                </span>
              </div>

              {filteredHistoryBreaks.length === 0 ? (
                <div className="px-5 py-10 text-center text-sm text-slate-500">
                  No break sessions recorded for this period.
                </div>
              ) : (
                <div className="max-h-[420px] overflow-auto">
                  <table className="w-full border-collapse text-left text-sm">
                    <thead className="sticky top-0 bg-slate-50">
                      <tr className="border-b border-slate-200 text-xs font-medium text-slate-500">
                        <th className="px-4 py-2.5">Date</th>
                        <th className="px-4 py-2.5">Employee</th>
                        <th className="px-4 py-2.5">Reason</th>
                        <th className="px-4 py-2.5">Window</th>
                        <th className="px-4 py-2.5 text-right">Duration</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {filteredHistoryBreaks.map((br) => (
                        <tr key={br.id} className="hover:bg-slate-50/60">
                          <td className="px-4 py-2.5 font-mono text-xs text-slate-500 tabular-nums whitespace-nowrap">
                            {br.dateKey}
                          </td>
                          <td className="px-4 py-2.5 font-medium text-slate-900 whitespace-nowrap">
                            {br.employeeName}
                          </td>
                          <td className="px-4 py-2.5 text-xs text-slate-700">
                            <div>{br.reasonCategory}</div>
                            {br.customReason && (
                              <div className="text-slate-500">{br.customReason}</div>
                            )}
                          </td>
                          <td className="px-4 py-2.5 font-mono text-xs text-slate-600 tabular-nums whitespace-nowrap">
                            {formatShortTime(br.outTime)} –{' '}
                            {br.inTime ? formatShortTime(br.inTime) : 'Active'}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono text-xs font-semibold text-slate-900 tabular-nums whitespace-nowrap">
                            {br.durationSeconds !== null
                              ? formatDurationCompact(br.durationSeconds)
                              : 'In process'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Raw In/Out Attendance Logs */}
            <div className="rounded-xl border border-slate-200 bg-white">
              <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-5 py-4">
                <h3 className="text-base font-semibold text-slate-900">In / Out Punch Log</h3>
                <span className="font-mono text-xs text-slate-500 tabular-nums">
                  {filteredHistoryLogs.length} punches
                </span>
              </div>

              {filteredHistoryLogs.length === 0 ? (
                <div className="px-5 py-10 text-center text-sm text-slate-500">
                  No In/Out punches recorded for this period.
                </div>
              ) : (
                <div className="max-h-[420px] overflow-auto">
                  <table className="w-full border-collapse text-left text-sm">
                    <thead className="sticky top-0 bg-slate-50">
                      <tr className="border-b border-slate-200 text-xs font-medium text-slate-500">
                        <th className="px-4 py-2.5">Date & Time</th>
                        <th className="px-4 py-2.5">Employee</th>
                        <th className="px-4 py-2.5">Action</th>
                        <th className="px-4 py-2.5">Reason</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {filteredHistoryLogs.map((lg) => (
                        <tr key={lg.id} className="hover:bg-slate-50/60">
                          <td className="px-4 py-2.5 font-mono text-xs text-slate-500 tabular-nums whitespace-nowrap">
                            {lg.dateKey} · {formatTime(lg.timestamp)}
                          </td>
                          <td className="px-4 py-2.5 font-medium text-slate-900 whitespace-nowrap">
                            {lg.employeeName}
                          </td>
                          <td className="px-4 py-2.5 whitespace-nowrap">
                            <span
                              className={`text-xs font-semibold ${
                                lg.direction === 'IN' ? 'text-teal-700' : 'text-slate-700'
                              }`}
                            >
                              Mark {lg.direction}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-xs text-slate-700">
                            <div>{lg.reasonCategory}</div>
                            {lg.customReason && (
                              <div className="text-slate-500">{lg.customReason}</div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {/* ===================================================================== */}
      {/* EMPLOYEE PERFORMANCE ANALYTICS                                        */}
      {/* ===================================================================== */}
      {showAnalytics && (
        <EmployeePerformanceAnalytics
          refreshSignal={refreshSignal}
          onAuthError={onSessionExpired}
        />
      )}

      {/* ===================================================================== */}
      {/* STAFF & SECURITY SETTINGS                                             */}
      {/* ===================================================================== */}
      {showSettings && (
        <section aria-label="Staff Roster and Manager Password Settings" className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          {/* Staff Roster Management */}
          <div className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 lg:col-span-7">
            <h2 className="text-lg font-semibold text-slate-900">Branch Staff Roster &amp; Secret Codes</h2>
            <p className="mt-1 text-sm text-slate-500">
              All staff members are automatically assigned a unique 4-digit secret code required to mark In or Out.
            </p>

            {staffActionMsg && (
              <div className="mt-4 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-800">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span>{staffActionMsg}</span>
              </div>
            )}
            {staffActionErr && (
              <div className="mt-4 flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-800">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{staffActionErr}</span>
              </div>
            )}

            <form onSubmit={handleAddEmployee} className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-12">
              <input
                ref={newStaffNameInputRef}
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Full Name (e.g. Tariq Mehmood)"
                required
                className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 focus:border-teal-700 focus:bg-white focus:outline-none sm:col-span-5"
              />
              <input
                type="text"
                value={newRole}
                onChange={(e) => setNewRole(e.target.value)}
                placeholder="Role (e.g. Teller)"
                required
                className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 focus:border-teal-700 focus:bg-white focus:outline-none sm:col-span-4"
              />
              <input
                type="text"
                value={newCode}
                onChange={(e) => setNewCode(e.target.value)}
                placeholder="Code (optional)"
                className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm text-slate-900 focus:border-teal-700 focus:bg-white focus:outline-none sm:col-span-3"
              />
              <div className="sm:col-span-12">
                <button
                  type="submit"
                  disabled={addingStaff}
                  className="inline-flex items-center gap-2 rounded-lg bg-teal-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-teal-800 disabled:opacity-60 whitespace-nowrap"
                >
                  <Plus className="h-4 w-4" />
                  <span>{addingStaff ? 'Adding...' : 'Add Staff Member'}</span>
                </button>
              </div>
            </form>

            <div className="mt-6 divide-y divide-slate-100 border-t border-slate-200">
              {(todayData?.employeeSummaries ?? []).map((emp) => (
                <div key={emp.employeeId} className="flex flex-wrap items-center justify-between gap-4 py-3">
                  <div>
                    <div className="text-sm font-medium text-slate-900">{emp.employeeName}</div>
                    <div className="text-xs text-slate-500">
                      <span className="font-mono">{emp.employeeCode}</span>
                      <span aria-hidden="true"> · </span>
                      <span>{emp.employeeRole}</span>
                      {emp.secretCode && (
                        <>
                          <span aria-hidden="true"> · </span>
                          <span>
                            Secret Code:{' '}
                            <strong className="font-mono font-semibold text-slate-900 tabular-nums">
                              {emp.secretCode}
                            </strong>
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleRegenerateSecretCode(emp.employeeId, emp.employeeName)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 whitespace-nowrap shrink-0"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      <span>New Code</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeactivateEmployee(emp.employeeId, emp.employeeName)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-rose-700 transition-colors hover:border-rose-200 hover:bg-rose-50 whitespace-nowrap shrink-0"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span>Remove</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Right Column: Break Threshold + Manager Password */}
          <div className="space-y-6 lg:col-span-5">
            {/* Concurrent Break Threshold */}
            <div className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
              <div className="flex items-center gap-2.5">
                <Users className="h-5 w-5 text-teal-700" />
                <h2 className="text-lg font-semibold text-slate-900">Concurrent Break Threshold</h2>
              </div>
              <p className="mt-1 text-sm text-slate-500">
                Limit how many staff members can be out on break at the same time. Additional break
                attempts are blocked with a wait warning until someone marks In.
              </p>

              <form onSubmit={handleSaveThreshold} className="mt-5 space-y-4">
                {thresholdMsg && (
                  <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-800">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    <span>{thresholdMsg}</span>
                  </div>
                )}
                {thresholdErr && (
                  <div className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-800">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span>{thresholdErr}</span>
                  </div>
                )}

                <label className="flex cursor-pointer items-center gap-2.5 text-sm font-medium text-slate-800">
                  <input
                    type="checkbox"
                    checked={thresholdLimitEnabled}
                    onChange={(e) => {
                      setThresholdLimitEnabled(e.target.checked);
                      setThresholdMsg(null);
                      setThresholdErr(null);
                    }}
                    className="h-4 w-4 rounded border-slate-300 text-teal-700 focus:ring-teal-700"
                  />
                  <span>Enforce maximum staff on break at one time</span>
                </label>

                {thresholdLimitEnabled && (
                  <div>
                    <label
                      htmlFor="concurrent-break-limit"
                      className="block text-xs font-medium text-slate-700"
                    >
                      Maximum Staff Allowed on Break Simultaneously
                    </label>
                    <input
                      id="concurrent-break-limit"
                      type="number"
                      min={1}
                      max={100}
                      value={thresholdCount}
                      onChange={(e) =>
                        setThresholdCount(Math.max(1, Math.min(100, Number(e.target.value) || 1)))
                      }
                      className="mt-1.5 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm text-slate-900 focus:border-teal-700 focus:bg-white focus:outline-none sm:max-w-[160px]"
                    />
                    <p className="mt-1.5 text-xs text-slate-500">
                      Applies to break reasons (Launch, Namaz, Rest Room, Other). Shift End is always allowed.
                    </p>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={savingThreshold}
                  className="w-full rounded-lg bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-teal-800 disabled:opacity-60"
                >
                  {savingThreshold ? 'Saving Threshold...' : 'Save Standard Break Threshold'}
                </button>
              </form>
            </div>

            {/* Peak Time Break Thresholds */}
            <div className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
              <div className="flex items-center gap-2.5">
                <Clock className="h-5 w-5 text-amber-700" />
                <h2 className="text-lg font-semibold text-slate-900">Peak Time Break Thresholds</h2>
              </div>
              <p className="mt-1 text-sm text-slate-500">
                Define separate peak hours and a stricter simultaneous mark-out threshold during busy
                branch windows. Overrides the standard limit while active.
              </p>

              <form onSubmit={handleAddPeakRule} className="mt-5 space-y-4">
                {peakMsg && (
                  <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-800">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    <span>{peakMsg}</span>
                  </div>
                )}
                {peakErr && (
                  <div className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-800">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span>{peakErr}</span>
                  </div>
                )}

                <div>
                  <label
                    htmlFor="peak-label-input"
                    className="block text-xs font-medium text-slate-700"
                  >
                    Peak Period Name
                  </label>
                  <input
                    id="peak-label-input"
                    type="text"
                    value={peakLabel}
                    onChange={(e) => setPeakLabel(e.target.value)}
                    placeholder="e.g. Morning Rush or Afternoon Peak"
                    maxLength={60}
                    className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 focus:border-teal-700 focus:bg-white focus:outline-none"
                  />
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div>
                    <label
                      htmlFor="peak-start-time"
                      className="block text-xs font-medium text-slate-700"
                    >
                      Peak Start Time
                    </label>
                    <input
                      id="peak-start-time"
                      type="time"
                      value={peakStartTime}
                      onChange={(e) => setPeakStartTime(e.target.value)}
                      required
                      className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm text-slate-900 focus:border-teal-700 focus:bg-white focus:outline-none"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="peak-end-time"
                      className="block text-xs font-medium text-slate-700"
                    >
                      Peak End Time
                    </label>
                    <input
                      id="peak-end-time"
                      type="time"
                      value={peakEndTime}
                      onChange={(e) => setPeakEndTime(e.target.value)}
                      required
                      className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm text-slate-900 focus:border-teal-700 focus:bg-white focus:outline-none"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="peak-max-breaks"
                      className="block text-xs font-medium text-slate-700"
                    >
                      Max Staff Out
                    </label>
                    <input
                      id="peak-max-breaks"
                      type="number"
                      min={0}
                      max={100}
                      value={peakMaxBreaks}
                      onChange={(e) =>
                        setPeakMaxBreaks(Math.max(0, Math.min(100, Number(e.target.value) || 0)))
                      }
                      required
                      className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm text-slate-900 focus:border-teal-700 focus:bg-white focus:outline-none"
                    />
                  </div>
                </div>
                <p className="text-xs text-slate-500">
                  Set Max Staff Out to 0 to pause all break mark-outs during peak hours (Shift End remains allowed).
                </p>

                <button
                  type="submit"
                  disabled={savingPeak}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-amber-700 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-amber-800 disabled:opacity-60"
                >
                  <Plus className="h-4 w-4" />
                  <span>{savingPeak ? 'Saving...' : 'Create Peak Time Threshold'}</span>
                </button>
              </form>

              <div className="mt-5 divide-y divide-slate-100 border-t border-slate-200">
                {peakRules.length === 0 ? (
                  <div className="pt-4 text-xs text-slate-500">
                    No peak hour windows configured yet.
                  </div>
                ) : (
                  peakRules.map((rule) => {
                    const isActiveNow =
                      todayData?.effectiveBreakPolicy?.activeMode === 'peak' &&
                      todayData.effectiveBreakPolicy.activePeakRule?.id === rule.id;
                    return (
                      <div
                        key={rule.id}
                        className="flex flex-wrap items-center justify-between gap-3 py-3"
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-x-2 text-sm font-medium text-slate-900">
                            <span>{rule.label}</span>
                            {isActiveNow && (
                              <span className="text-xs font-semibold text-amber-700">
                                · Active now
                              </span>
                            )}
                            {!rule.enabled && (
                              <span className="text-xs font-normal text-slate-400">· Paused</span>
                            )}
                          </div>
                          <div className="mt-0.5 font-mono text-xs text-slate-600 tabular-nums">
                            {rule.startTime} – {rule.endTime} ·{' '}
                            {rule.maxConcurrentBreaks === 0
                              ? '0 allowed (breaks paused)'
                              : `Max ${rule.maxConcurrentBreaks} out`}
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            disabled={savingPeak}
                            onClick={() => handleTogglePeakRule(rule.id)}
                            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                          >
                            {rule.enabled ? 'Disable' : 'Enable'}
                          </button>
                          <button
                            type="button"
                            disabled={savingPeak}
                            onClick={() => handleDeletePeakRule(rule.id)}
                            aria-label={`Delete ${rule.label}`}
                            className="rounded-lg border border-slate-200 bg-white p-1.5 text-rose-700 hover:border-rose-200 hover:bg-rose-50 disabled:opacity-50"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Manager Password Settings */}
            <div className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
              <div className="flex items-center gap-2.5">
                <KeyRound className="h-5 w-5 text-slate-700" />
                <h2 className="text-lg font-semibold text-slate-900">
                  {isDefaultPassword ? 'Create Manager Portal Password' : 'Manager Password'}
                </h2>
              </div>
              <p className="mt-1 text-sm text-slate-500">
                {isDefaultPassword
                  ? 'Set a dedicated password to protect the Manager Portal for this branch.'
                  : 'Update the password required to unlock the Manager Portal.'}
              </p>

              <form onSubmit={handleChangePassword} className="mt-5 space-y-4">
                {pwMsg && (
                  <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-800">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    <span>{pwMsg}</span>
                  </div>
                )}
                {pwErr && (
                  <div className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-800">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span>{pwErr}</span>
                  </div>
                )}

                {!isDefaultPassword && (
                  <div>
                    <label className="block text-xs font-medium text-slate-700">
                      Current Password
                    </label>
                    <input
                      type="password"
                      value={currentPw}
                      onChange={(e) => setCurrentPw(e.target.value)}
                      required
                      className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 focus:border-teal-700 focus:bg-white focus:outline-none"
                    />
                  </div>
                )}

                <div>
                  <label className="block text-xs font-medium text-slate-700">New Password</label>
                  <input
                    ref={newPasswordInputRef}
                    type="password"
                    value={newPw}
                    onChange={(e) => setNewPw(e.target.value)}
                    required
                    minLength={4}
                    placeholder="At least 4 characters"
                    className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 focus:border-teal-700 focus:bg-white focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    Confirm New Password
                  </label>
                  <input
                    type="password"
                    value={confirmPw}
                    onChange={(e) => setConfirmPw(e.target.value)}
                    required
                    minLength={4}
                    placeholder="Re-enter new password"
                    className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 focus:border-teal-700 focus:bg-white focus:outline-none"
                  />
                </div>

                <button
                  type="submit"
                  disabled={savingPw}
                  className="w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-slate-800 disabled:opacity-60"
                >
                  {savingPw
                    ? 'Saving Password...'
                    : isDefaultPassword
                      ? 'Create Manager Password'
                      : 'Update Manager Password'}
                </button>
              </form>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
