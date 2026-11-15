import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Coffee,
  Eye,
  EyeOff,
  History,
  KeyRound,
  LogIn,
  LogOut,
  Search,
} from 'lucide-react';
import {
  fetchStaffKioskState,
  getStaffWebSocketUrl,
  submitClosePreviousShift,
  submitStaffPunch,
} from '../api';
import {
  OUT_REASONS,
  type AttendanceLog,
  type EffectiveBreakPolicy,
  type EmployeeStatus,
  type OutReasonCategory,
  type PunchDirection,
  type StaffMemberState,
} from '../types';
import {
  formatDisplayDate,
  formatDurationClock,
  formatDurationCompact,
  formatShortTime,
  formatTime,
  getInitials,
  getLocalDateKey,
} from '../utils/format';

type StatusFilter = 'all' | EmployeeStatus;

const STATUS_LABELS: Record<EmployeeStatus, { label: string; colorClass: string }> = {
  in_branch: { label: 'In Branch', colorClass: 'text-emerald-700' },
  on_break: { label: 'On Break', colorClass: 'text-amber-700' },
  off_shift: { label: 'Off Shift', colorClass: 'text-slate-500' },
};

function getCurrentLocalHHMM(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

interface StaffTerminalProps {
  onGoToManager?: () => void;
}

export function StaffTerminal({ onGoToManager }: StaffTerminalProps) {
  const [staff, setStaff] = useState<StaffMemberState[]>([]);
  const [maxConcurrentBreaks, setMaxConcurrentBreaks] = useState<number | null>(null);
  const [effectiveBreakPolicy, setEffectiveBreakPolicy] = useState<EffectiveBreakPolicy | null>(null);
  const [recentLogs, setRecentLogs] = useState<AttendanceLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const [direction, setDirection] = useState<PunchDirection>('IN');
  const [outReason, setOutReason] = useState<OutReasonCategory>('Launch Break');
  const [customOutReason, setCustomOutReason] = useState('');

  const [forgotShiftStart, setForgotShiftStart] = useState(false);
  const [manualStartTime, setManualStartTime] = useState('09:00');
  const [forgotReason, setForgotReason] = useState('');

  const [prevShiftEndTime, setPrevShiftEndTime] = useState('18:00');
  const [prevShiftReason, setPrevShiftReason] = useState('');

  const [secretCode, setSecretCode] = useState('');
  const [showSecretCode, setShowSecretCode] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);

  const [nowMs, setNowMs] = useState(() => Date.now());
  const selectedIdRef = useRef<string>('');
  selectedIdRef.current = selectedId;
  const secretCodeInputRef = useRef<HTMLInputElement | null>(null);
  const terminalTopRef = useRef<HTMLDivElement | null>(null);

  const focusSecretCode = useCallback(() => {
    window.requestAnimationFrame(() => {
      secretCodeInputRef.current?.focus();
    });
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const applySmartDefaults = useCallback((member: StaffMemberState) => {
    setSelectedId(member.employee.id);
    setSubmitError(null);
    setCustomOutReason('');
    setForgotShiftStart(false);
    setManualStartTime('09:00');
    setForgotReason('');
    setPrevShiftEndTime('18:00');
    setPrevShiftReason('');
    setSecretCode('');
    setShowSecretCode(false);

    if (!member.hasShiftStartToday || member.status === 'off_shift' || member.status === 'on_break') {
      setDirection('IN');
    } else {
      setDirection('OUT');
      setOutReason('Launch Break');
    }
  }, []);

  const loadKiosk = useCallback(
    async (preserveSelection = true) => {
      try {
        setLoadError(null);
        const data = await fetchStaffKioskState(getLocalDateKey());
        setStaff(data.staff);
        setMaxConcurrentBreaks(data.maxConcurrentBreaks ?? null);
        setEffectiveBreakPolicy(data.effectiveBreakPolicy ?? null);
        setRecentLogs(data.recentLogs);
        if (data.staff.length === 0) {
          setSelectedId('');
        } else if (!preserveSelection || !selectedIdRef.current) {
          applySmartDefaults(data.staff[0]);
        }
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Unable to load branch staff state.');
      } finally {
        setLoading(false);
      }
    },
    [applySmartDefaults]
  );

  useEffect(() => {
    loadKiosk(false);
    const poll = window.setInterval(() => {
      loadKiosk(true);
    }, 15000);
    return () => window.clearInterval(poll);
  }, [loadKiosk]);

  useEffect(() => {
    const wsUrl = getStaffWebSocketUrl();
    if (!wsUrl) return;

    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      ws = new WebSocket(wsUrl);

      ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data) as { event?: string };
          if (parsed.event === 'staff:updated') {
            loadKiosk(true);
          }
        } catch {
          // Ignore malformed payloads
        }
      };

      ws.onclose = () => {
        if (!disposed) {
          reconnectTimer = window.setTimeout(connect, 3000);
        }
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (ws) ws.close();
    };
  }, [loadKiosk]);

  const selectedMember = useMemo(
    () => staff.find((s) => s.employee.id === selectedId) ?? null,
    [staff, selectedId]
  );

  const filteredStaff = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return staff.filter((item) => {
      if (statusFilter !== 'all' && item.status !== statusFilter) {
        return false;
      }
      if (!q) return true;
      return (
        item.employee.name.toLowerCase().includes(q) ||
        item.employee.code.toLowerCase().includes(q) ||
        item.employee.role.toLowerCase().includes(q)
      );
    });
  }, [staff, searchQuery, statusFilter]);

  const currentBreaks = useMemo(() => {
    return staff
      .filter(
        (member): member is StaffMemberState & { activeBreak: NonNullable<StaffMemberState['activeBreak']> } =>
          member.status === 'on_break' && member.activeBreak !== null
      )
      .sort(
        (a, b) =>
          new Date(a.activeBreak.outTime).getTime() - new Date(b.activeBreak.outTime).getTime()
      );
  }, [staff]);

  const countsByStatus = useMemo(() => {
    let inBranch = 0;
    let onBreak = 0;
    let offShift = 0;
    for (const s of staff) {
      if (s.status === 'in_branch') inBranch += 1;
      else if (s.status === 'on_break') onBreak += 1;
      else offShift += 1;
    }
    return { inBranch, onBreak, offShift };
  }, [staff]);

  const otherActiveBreaksCount = useMemo(() => {
    if (!selectedMember) return currentBreaks.length;
    return currentBreaks.filter((m) => m.employee.id !== selectedMember.employee.id).length;
  }, [currentBreaks, selectedMember]);

  const isBreakThresholdReached = useMemo(() => {
    if (direction !== 'OUT' || outReason === 'Shift End') return false;
    if (maxConcurrentBreaks === null || maxConcurrentBreaks < 0) return false;
    return otherActiveBreaksCount >= maxConcurrentBreaks;
  }, [direction, outReason, maxConcurrentBreaks, otherActiveBreaksCount]);

  const thresholdWarningText = useMemo(() => {
    if (!isBreakThresholdReached || maxConcurrentBreaks === null) return null;
    if (effectiveBreakPolicy?.activeMode === 'peak' && effectiveBreakPolicy.activePeakRule) {
      const pr = effectiveBreakPolicy.activePeakRule;
      if (maxConcurrentBreaks === 0) {
        return `Peak hours (${pr.label}: ${pr.startTime}–${pr.endTime}): breaks are paused right now (0 allowed). Wait until peak hours end.`;
      }
      return `Peak hours threshold reached (${pr.label}: ${pr.startTime}–${pr.endTime}): ${otherActiveBreaksCount} of ${maxConcurrentBreaks} staff ${
        otherActiveBreaksCount === 1 ? 'is' : 'are'
      } already outside or on break. Wait for your turn.`;
    }
    return `Break threshold reached: ${otherActiveBreaksCount} of ${maxConcurrentBreaks} staff ${
      otherActiveBreaksCount === 1 ? 'is' : 'are'
    } already outside or on break. Wait for your turn.`;
  }, [isBreakThresholdReached, maxConcurrentBreaks, otherActiveBreaksCount, effectiveBreakPolicy]);

  const unclosedPreviousShift =
    selectedMember && !selectedMember.hasShiftStartToday
      ? selectedMember.unclosedPreviousShift
      : null;

  const isMarkOutMissingShiftStart =
    direction === 'OUT' && selectedMember !== null && !selectedMember.hasShiftStartToday;

  const handleSelectFromRoster = (member: StaffMemberState) => {
    setSuccessNotice(null);
    applySmartDefaults(member);
    terminalTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedMember) {
      setSubmitError('Please select a staff member from the branch roster.');
      return;
    }

    if (direction === 'IN') {
      if (unclosedPreviousShift) {
        if (!/^\d{2}:\d{2}$/.test(prevShiftEndTime)) {
          setSubmitError('Please enter your shift end time for the last day.');
          return;
        }
        if (prevShiftReason.trim().length < 2) {
          setSubmitError('Please give the reason for not ending your shift on the last day.');
          return;
        }
      } else if (!selectedMember.hasShiftStartToday && forgotShiftStart) {
        if (!/^\d{2}:\d{2}$/.test(manualStartTime)) {
          setSubmitError('Please enter your actual shift start time for today.');
          return;
        }
        if (manualStartTime > getCurrentLocalHHMM()) {
          setSubmitError('Entered shift start time cannot be later than the current time.');
          return;
        }
        if (forgotReason.trim().length < 2) {
          setSubmitError('Please enter the reason for forgetting to mark Shift Start.');
          return;
        }
      }
    } else {
      if (isMarkOutMissingShiftStart) {
        setSubmitError(
          'You have not marked Shift Start today. Please enter your arrival time under Forgot Shift Start first (or mark IN for Shift Start).'
        );
        return;
      }
      if (isBreakThresholdReached && thresholdWarningText) {
        setSubmitError(thresholdWarningText);
        return;
      }
      if (outReason === 'Other' && customOutReason.trim().length < 2) {
        setSubmitError('Please enter a manual reason when Other is selected.');
        return;
      }
    }

    if (!/^\d{1,4}$/.test(secretCode.trim())) {
      setSubmitError('Please enter your 4-digit secret code to confirm.');
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    setSuccessNotice(null);

    try {
      if (direction === 'IN' && unclosedPreviousShift) {
        const closed = await submitClosePreviousShift({
          employeeId: selectedMember.employee.id,
          secretCode: secretCode.trim(),
          previousDateKey: unclosedPreviousShift.dateKey,
          endTime: prevShiftEndTime,
          reason: prevShiftReason.trim(),
          dateKey: getLocalDateKey(),
        });

        setSuccessNotice(
          `Ended ${selectedMember.employee.name}'s ${closed.previousDateKey} shift at ${formatTime(closed.timestamp)}. You can now mark Shift Start for today.`
        );
        setPrevShiftReason('');
        setSecretCode('');
        setStaff(closed.staff);
        await loadKiosk(true);
        if (closed.member) {
          applySmartDefaults(closed.member);
        }
        return;
      }

      const response = await submitStaffPunch({
        employeeId: selectedMember.employee.id,
        secretCode: secretCode.trim(),
        direction,
        reasonCategory: direction === 'OUT' ? outReason : undefined,
        customReason:
          direction === 'IN'
            ? forgotShiftStart
              ? forgotReason.trim()
              : undefined
            : outReason === 'Other'
              ? customOutReason.trim()
              : undefined,
        forgotShiftStart:
          direction === 'IN' && !selectedMember.hasShiftStartToday && forgotShiftStart
            ? true
            : undefined,
        manualTime:
          direction === 'IN' && !selectedMember.hasShiftStartToday && forgotShiftStart
            ? manualStartTime
            : undefined,
        dateKey: getLocalDateKey(),
      });

      const reasonDisplay = response.resolvedCustom
        ? `${response.resolvedReason} (${response.resolvedCustom})`
        : response.resolvedReason;

      setSuccessNotice(
        `${selectedMember.employee.name} marked ${direction} · ${reasonDisplay} at ${formatTime(response.timestamp)}`
      );
      setCustomOutReason('');
      setForgotReason('');
      setForgotShiftStart(false);
      setSecretCode('');
      setStaff(response.staff);
      await loadKiosk(true);
      if (response.member) {
        applySmartDefaults(response.member);
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to submit attendance mark.');
    } finally {
      setSubmitting(false);
    }
  };

  const liveNow = new Date(nowMs);
  const liveClockString = liveNow.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
  const liveDateString = liveNow.toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  const activeBreakElapsedSec =
    selectedMember?.activeBreak
      ? Math.max(0, Math.floor((nowMs - new Date(selectedMember.activeBreak.outTime).getTime()) / 1000))
      : 0;

  const detectedInLabel = useMemo(() => {
    if (!selectedMember) return '';
    if (!selectedMember.hasShiftStartToday) {
      return forgotShiftStart
        ? `Forgot Shift Start (${manualStartTime})`
        : 'Shift Start (First Mark IN today)';
    }
    if (selectedMember.activeBreak) {
      return selectedMember.activeBreak.reasonCategory === 'Other' &&
        selectedMember.activeBreak.customReason
        ? `Other (${selectedMember.activeBreak.customReason})`
        : selectedMember.activeBreak.reasonCategory;
    }
    if (selectedMember.lastOutLog) {
      if (selectedMember.lastOutLog.reasonCategory === 'Shift End') {
        return 'Shift Resume (After Shift End)';
      }
      return selectedMember.lastOutLog.reasonCategory === 'Other' &&
        selectedMember.lastOutLog.customReason
        ? `Other (${selectedMember.lastOutLog.customReason})`
        : selectedMember.lastOutLog.reasonCategory;
    }
    return 'Shift Resume';
  }, [selectedMember, forgotShiftStart, manualStartTime]);

  return (
    <div className="space-y-8" ref={terminalTopRef}>
      {/* Page Header */}
      <div className="flex flex-col gap-4 border-b border-slate-200 pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
            Branch Staff Attendance Terminal
          </h1>
          <p className="mt-1.5 text-sm text-slate-600">
            First Mark IN starts your shift automatically; subsequent Mark IN entries detect your last Mark OUT.
          </p>
        </div>
        <div className="text-left sm:text-right">
          <div className="font-mono text-2xl font-semibold tracking-tight text-slate-900 tabular-nums">
            {liveClockString}
          </div>
          <div className="mt-0.5 text-xs text-slate-500">{liveDateString}</div>
        </div>
      </div>

      {loadError && (
        <div className="flex items-center justify-between gap-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          <div className="flex items-center gap-2.5">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{loadError}</span>
          </div>
          <button
            type="button"
            onClick={() => loadKiosk(true)}
            className="font-medium text-rose-900 underline underline-offset-2 hover:text-rose-700 whitespace-nowrap shrink-0"
          >
            Retry
          </button>
        </div>
      )}

      {/* TOP ROW: Mark In/Out Window (Left) + Current Breaks Live Window (Right) */}
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-12">
        {/* Top-Left: Mark In / Out Form */}
        <section
          aria-label="Mark In and Out Form"
          className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 lg:col-span-7"
        >
          {loading ? (
            <div className="space-y-4 py-8">
              <div className="h-12 animate-pulse rounded-lg bg-slate-100" />
              <div className="h-24 animate-pulse rounded-lg bg-slate-100" />
            </div>
          ) : staff.length === 0 ? (
            <div className="py-12 text-center">
              <h2 className="text-base font-semibold text-slate-900">
                No staff members added to this branch yet
              </h2>
              <p className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-slate-500">
                Open the Manager Portal to add your branch staff members and generate their
                4-digit secret codes before marking In or Out.
              </p>
              {onGoToManager && (
                <button
                  type="button"
                  onClick={onGoToManager}
                  className="mt-5 inline-flex items-center justify-center rounded-lg bg-teal-700 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-teal-800 whitespace-nowrap"
                >
                  Open Manager Portal to Add Staff
                </button>
              )}
            </div>
          ) : !selectedMember ? (
            <div className="py-16 text-center text-sm text-slate-500">
              Select a staff member from the Branch Roster below to mark In or Out.
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-6">
              {/* Selected Staff Summary */}
              <div className="flex flex-col gap-3 border-b border-slate-200 pb-5 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-3.5">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-sm font-semibold text-white">
                    {getInitials(selectedMember.employee.name)}
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold text-slate-900">
                      {selectedMember.employee.name}
                    </h2>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
                      <span className="font-mono">{selectedMember.employee.code}</span>
                      <span aria-hidden="true">·</span>
                      <span>{selectedMember.employee.role}</span>
                      <span aria-hidden="true">·</span>
                      <span className={`font-medium ${STATUS_LABELS[selectedMember.status].colorClass}`}>
                        {STATUS_LABELS[selectedMember.status].label}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="text-xs text-slate-500 sm:text-right tabular-nums">
                  {selectedMember.shiftStartTime ? (
                    <div>Shift started {formatShortTime(selectedMember.shiftStartTime)}</div>
                  ) : (
                    <div>Not clocked in today</div>
                  )}
                  <div className="mt-0.5">
                    Today: {selectedMember.todayBreaksCount} breaks ·{' '}
                    {formatDurationCompact(selectedMember.todayCompletedBreakSeconds)}
                  </div>
                </div>
              </div>

              {selectedMember.status === 'on_break' && selectedMember.activeBreak && (
                <div className="flex items-center justify-between gap-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Clock className="h-4 w-4 shrink-0 text-amber-700" />
                    <span className="truncate">
                      Last Mark OUT:{' '}
                      <strong className="font-medium">
                        {selectedMember.activeBreak.reasonCategory === 'Other' &&
                        selectedMember.activeBreak.customReason
                          ? `Other (${selectedMember.activeBreak.customReason})`
                          : selectedMember.activeBreak.reasonCategory}
                      </strong>{' '}
                      at {formatShortTime(selectedMember.activeBreak.outTime)}
                    </span>
                  </div>
                  <span className="font-mono text-sm font-semibold text-amber-800 tabular-nums shrink-0">
                    {formatDurationClock(activeBreakElapsedSec)}
                  </span>
                </div>
              )}

              {successNotice && (
                <div className="flex items-center gap-2.5 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-700" />
                  <span>{successNotice}</span>
                </div>
              )}

              {submitError && (
                <div className="flex items-center gap-2.5 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
                  <AlertCircle className="h-4 w-4 shrink-0 text-rose-700" />
                  <span>{submitError}</span>
                </div>
              )}

              {/* Step 1: In / Out Direction */}
              <div>
                <label className="block text-sm font-medium text-slate-800">
                  01. Attendance Action
                </label>
                <div className="mt-2.5 grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setDirection('IN');
                      setSubmitError(null);
                      focusSecretCode();
                    }}
                    className={`flex items-center justify-center gap-2.5 rounded-lg border px-4 py-3.5 text-sm font-semibold transition-colors whitespace-nowrap ${
                      direction === 'IN'
                        ? 'border-teal-700 bg-teal-700 text-white'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <LogIn className="h-4 w-4 shrink-0" />
                    <span>Mark IN</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setDirection('OUT');
                      setForgotShiftStart(false);
                      setSubmitError(null);
                    }}
                    className={`flex items-center justify-center gap-2.5 rounded-lg border px-4 py-3.5 text-sm font-semibold transition-colors whitespace-nowrap ${
                      direction === 'OUT'
                        ? 'border-slate-900 bg-slate-900 text-white'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <LogOut className="h-4 w-4 shrink-0" />
                    <span>Mark OUT</span>
                  </button>
                </div>
              </div>

              {/* Step 2: Mark IN (Automatic + Forgot Shift Start ONLY) OR Mark OUT (Break / Shift End Reasons) */}
              {direction === 'IN' ? (
                <div className="space-y-4">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="block text-sm font-medium text-slate-800">
                      02. Mark IN Mode
                    </span>
                    <span className="text-xs text-slate-500">
                      {selectedMember.hasShiftStartToday ? 'Auto-detected' : 'Shift Start'}
                    </span>
                  </div>

                  {unclosedPreviousShift ? (
                    <div className="space-y-4 rounded-lg border border-rose-200 bg-rose-50/80 p-4">
                      <div className="flex items-start gap-2.5">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-700" />
                        <div>
                          <div className="text-sm font-semibold text-rose-950">
                            End Last Day&apos;s Shift First ({formatDisplayDate(unclosedPreviousShift.dateKey)})
                          </div>
                          <p className="mt-1 text-xs text-rose-900">
                            You did not end your shift on {unclosedPreviousShift.dateKey} (last mark:{' '}
                            {unclosedPreviousShift.lastLogReason} at{' '}
                            {formatShortTime(unclosedPreviousShift.lastLogTime)}). Please end last
                            day&apos;s shift first and give the reason for not ending it.
                          </p>
                        </div>
                      </div>

                      <div className="space-y-3 border-t border-rose-200 pt-3">
                        <div>
                          <label
                            htmlFor="prev-shift-end-time"
                            className="block text-xs font-medium text-rose-950"
                          >
                            Shift End Time on {unclosedPreviousShift.dateKey}
                          </label>
                          <input
                            id="prev-shift-end-time"
                            type="time"
                            value={prevShiftEndTime}
                            onChange={(e) => {
                              setPrevShiftEndTime(e.target.value);
                              if (submitError) setSubmitError(null);
                            }}
                            className="mt-1.5 w-full rounded-lg border border-rose-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 focus:border-teal-700 focus:outline-none sm:max-w-[180px]"
                          />
                        </div>

                        <div>
                          <label
                            htmlFor="prev-shift-end-reason"
                            className="block text-xs font-medium text-rose-950"
                          >
                            Reason for Not Ending Shift Last Day
                          </label>
                          <input
                            id="prev-shift-end-reason"
                            type="text"
                            value={prevShiftReason}
                            onChange={(e) => {
                              setPrevShiftReason(e.target.value);
                              if (submitError) setSubmitError(null);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && secretCode.length === 0) {
                                e.preventDefault();
                                focusSecretCode();
                              }
                            }}
                            maxLength={200}
                            placeholder="Explain why Shift End was not marked on the last day..."
                            autoFocus
                            className="mt-1.5 w-full rounded-lg border border-rose-300 bg-white px-3.5 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:outline-none"
                          />
                        </div>
                      </div>
                    </div>
                  ) : !selectedMember.hasShiftStartToday ? (
                    <div className="space-y-4 rounded-lg border border-slate-200 bg-slate-50/70 p-4">
                      <div>
                        <div className="text-sm font-semibold text-slate-900">
                          {forgotShiftStart ? 'Forgot Shift Start (Manual Back Time)' : 'Shift Start'}
                        </div>
                        <p className="mt-1 text-xs text-slate-600">
                          {forgotShiftStart
                            ? 'Enter your actual morning arrival time for today and the reason below.'
                            : 'First Mark IN of the day is automatically recorded as Shift Start at current time.'}
                        </p>
                      </div>

                      <button
                        type="button"
                        onClick={() => {
                          setForgotShiftStart((prev) => !prev);
                          setSubmitError(null);
                        }}
                        className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3.5 py-2.5 text-left text-sm font-medium transition-colors ${
                          forgotShiftStart
                            ? 'border-teal-700 bg-teal-50 text-teal-900'
                            : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:bg-slate-50'
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <History className="h-4 w-4 shrink-0" />
                          <span>Forgot Shift Start</span>
                        </span>
                        <span className="text-xs font-semibold">
                          {forgotShiftStart ? 'Selected · Click to cancel' : 'Enter back time'}
                        </span>
                      </button>

                      {forgotShiftStart && (
                        <div className="space-y-3 border-t border-slate-200 pt-3">
                          <div>
                            <label
                              htmlFor="forgot-shift-time"
                              className="block text-xs font-medium text-slate-700"
                            >
                              Actual Shift Start Time (Today)
                            </label>
                            <input
                              id="forgot-shift-time"
                              type="time"
                              value={manualStartTime}
                              max={getCurrentLocalHHMM()}
                              onChange={(e) => {
                                setManualStartTime(e.target.value);
                                if (submitError) setSubmitError(null);
                              }}
                              className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 focus:border-teal-700 focus:outline-none sm:max-w-[180px]"
                            />
                          </div>

                          <div>
                            <label
                              htmlFor="forgot-shift-reason"
                              className="block text-xs font-medium text-slate-700"
                            >
                              Reason for Forgot Shift Start
                            </label>
                            <input
                              id="forgot-shift-reason"
                              type="text"
                              value={forgotReason}
                              onChange={(e) => {
                                setForgotReason(e.target.value);
                                if (submitError) setSubmitError(null);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && secretCode.length === 0) {
                                  e.preventDefault();
                                  focusSecretCode();
                                }
                              }}
                              maxLength={200}
                              placeholder="Explain why shift start was missed at arrival time..."
                              autoFocus
                              className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:outline-none"
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-4">
                      <div className="text-sm font-semibold text-slate-900">
                        Detected Against Last Mark OUT
                      </div>
                      <p className="mt-1 text-sm text-slate-700">{detectedInLabel}</p>
                      {selectedMember.activeBreak ? (
                        <p className="mt-1.5 text-xs text-slate-500 tabular-nums">
                          Out since {formatShortTime(selectedMember.activeBreak.outTime)} · Confirming
                          Mark IN will complete this break and remove {selectedMember.employee.name} from
                          Current Breaks.
                        </p>
                      ) : selectedMember.lastOutLog ? (
                        <p className="mt-1.5 text-xs text-slate-500 tabular-nums">
                          Last marked OUT at {formatShortTime(selectedMember.lastOutLog.timestamp)}
                          {selectedMember.status === 'in_branch'
                            ? ' · Staff member is currently In Branch.'
                            : '.'}
                        </p>
                      ) : (
                        <p className="mt-1.5 text-xs text-slate-500">
                          Already shifted in today. Use Mark OUT if stepping out for a break or shift end.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <div className="flex items-baseline justify-between gap-2">
                      <label className="block text-sm font-medium text-slate-800">
                        02. Reason for Marking Out
                      </label>
                      <span className="text-xs text-slate-500">Select one option</span>
                    </div>

                    <div className="mt-2.5 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                      {OUT_REASONS.map((reason) => {
                        const active = outReason === reason;
                        return (
                          <button
                            key={reason}
                            type="button"
                            onClick={() => {
                              setOutReason(reason);
                              setSubmitError(null);
                              if (reason !== 'Other') {
                                focusSecretCode();
                              }
                            }}
                            className={`rounded-lg border px-3.5 py-2.5 text-left text-sm font-medium transition-colors ${
                              active
                                ? 'border-teal-700 bg-teal-50 text-teal-900'
                                : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50'
                            }`}
                          >
                            {reason}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {isMarkOutMissingShiftStart && (
                    <div
                      role="alert"
                      className="flex flex-col gap-3 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-950 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="flex items-start gap-2.5">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-700" />
                        <div>
                          <div className="font-semibold">Shift Start Required First</div>
                          <p className="mt-0.5 text-xs text-rose-900">
                            You have not marked Shift Start today. Please enter your arrival time in
                            the Forgot Shift Start option first (or mark IN for Shift Start).
                          </p>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setDirection('IN');
                          if (!unclosedPreviousShift) {
                            setForgotShiftStart(true);
                          }
                          setSubmitError(null);
                        }}
                        className="rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-xs font-semibold text-rose-900 transition-colors hover:bg-rose-100 whitespace-nowrap shrink-0"
                      >
                        {unclosedPreviousShift ? 'End Last Day Shift' : 'Go to Forgot Shift Start'}
                      </button>
                    </div>
                  )}

                  {!isMarkOutMissingShiftStart && thresholdWarningText && (
                    <div
                      role="alert"
                      className="flex items-start gap-2.5 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950"
                    >
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                      <div>
                        <div className="font-semibold">Wait for Your Turn</div>
                        <p className="mt-0.5 text-xs text-amber-900">{thresholdWarningText}</p>
                      </div>
                    </div>
                  )}

                  {outReason === 'Other' && (
                    <div>
                      <label
                        htmlFor="custom-reason-input"
                        className="block text-sm font-medium text-slate-800"
                      >
                        Write Reason Manually
                      </label>
                      <input
                        id="custom-reason-input"
                        type="text"
                        value={customOutReason}
                        onChange={(e) => {
                          setCustomOutReason(e.target.value);
                          if (submitError) setSubmitError(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && secretCode.length === 0) {
                            e.preventDefault();
                            focusSecretCode();
                          }
                        }}
                        maxLength={200}
                        placeholder="Enter specific reason for marking Out..."
                        autoFocus
                        className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:outline-none"
                      />
                      <p className="mt-1.5 text-xs text-slate-500">
                        Required when Other is selected. Recorded in manager logs and history.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* Step 3: Staff Secret Code Verification (max 4 digits) */}
              <div>
                <div className="flex items-baseline justify-between gap-2">
                  <label
                    htmlFor="staff-secret-code"
                    className="block text-sm font-medium text-slate-800"
                  >
                    03. Staff Secret Code
                  </label>
                  <span className="text-xs text-slate-500">Up to 4 digits</span>
                </div>

                <div className="relative mt-2 max-w-xs">
                  <KeyRound className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    ref={secretCodeInputRef}
                    id="staff-secret-code"
                    type={showSecretCode ? 'text' : 'password'}
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={4}
                    autoComplete="off"
                    value={secretCode}
                    onChange={(e) => {
                      const digitsOnly = e.target.value.replace(/\D/g, '').slice(0, 4);
                      setSecretCode(digitsOnly);
                      if (submitError) setSubmitError(null);
                    }}
                    placeholder="Enter 4-digit code"
                    className="w-full rounded-lg border border-slate-300 bg-white py-2.5 pr-10 pl-9 font-mono text-sm tracking-widest text-slate-900 placeholder:tracking-normal placeholder:font-sans placeholder:text-slate-400 focus:border-teal-700 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowSecretCode((prev) => !prev)}
                    aria-label={showSecretCode ? 'Hide secret code' : 'Show secret code'}
                    className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded p-1 text-slate-400 hover:text-slate-700"
                  >
                    {showSecretCode ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                <p className="mt-1.5 text-xs text-slate-500">
                  Required to unlock Mark {direction} for {selectedMember.employee.name}.
                </p>
              </div>

              {/* Submit Bar */}
              <div className="flex flex-col gap-3 border-t border-slate-200 pt-5 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-xs text-slate-600">
                  {isMarkOutMissingShiftStart
                    ? 'Please mark Shift Start (or Forgot Shift Start) before marking Out.'
                    : direction === 'IN' && unclosedPreviousShift
                      ? `Closes ${unclosedPreviousShift.dateKey} shift so you can mark Shift Start for today.`
                      : isBreakThresholdReached
                        ? 'Break limit reached — wait until an active staff member marks IN.'
                        : secretCode.length === 0
                          ? 'Enter your secret code above to confirm.'
                          : direction === 'IN'
                            ? selectedMember.activeBreak
                              ? `Marks ${selectedMember.employee.name} IN (${detectedInLabel}) and completes the active break.`
                              : `Marks ${selectedMember.employee.name} IN · ${detectedInLabel}.`
                            : outReason !== 'Shift End'
                              ? `Marks ${selectedMember.employee.name} OUT and starts a live ${outReason.toLowerCase()}.`
                              : `Records Mark OUT · Shift End for ${selectedMember.employee.name}.`}
                </div>

                <button
                  type="submit"
                  disabled={
                    submitting ||
                    secretCode.length === 0 ||
                    isBreakThresholdReached ||
                    isMarkOutMissingShiftStart ||
                    (direction === 'IN' &&
                      Boolean(unclosedPreviousShift) &&
                      prevShiftReason.trim().length < 2)
                  }
                  className="inline-flex items-center justify-center rounded-lg bg-teal-700 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                  {submitting
                    ? 'Saving...'
                    : direction === 'IN' && unclosedPreviousShift
                      ? 'End Last Day Shift'
                      : `Confirm Mark ${direction}`}
                </button>
              </div>
            </form>
          )}
        </section>

        {/* Top-Right: Live Current Breaks Window */}
        <section
          aria-label="Current Breaks Live Window"
          className="rounded-xl border border-slate-200 bg-white lg:col-span-5"
        >
          <div className="flex items-center justify-between gap-3 border-b border-slate-200 p-4 sm:px-5">
            <div className="flex items-center gap-2">
              <Coffee className="h-4 w-4 text-amber-700" />
              <h2 className="text-base font-semibold text-slate-900">Current Breaks</h2>
            </div>
            <span className="font-mono text-xs font-medium text-amber-700 tabular-nums">
              {currentBreaks.length}
              {maxConcurrentBreaks !== null
                ? ` / ${maxConcurrentBreaks} max${
                    effectiveBreakPolicy?.activeMode === 'peak' ? ' (Peak)' : ' out'
                  }`
                : ' staff out'}
            </span>
          </div>

          {effectiveBreakPolicy?.activeMode === 'peak' && effectiveBreakPolicy.activePeakRule && (
            <div className="flex items-center justify-between gap-2 border-b border-amber-200 bg-amber-50/70 px-5 py-2 text-xs text-amber-900">
              <span className="font-medium">
                Peak Window: {effectiveBreakPolicy.activePeakRule.label}
              </span>
              <span className="font-mono tabular-nums">
                {effectiveBreakPolicy.activePeakRule.startTime}–{effectiveBreakPolicy.activePeakRule.endTime} ·{' '}
                {effectiveBreakPolicy.activePeakRule.maxConcurrentBreaks === 0
                  ? 'Breaks paused'
                  : `Max ${effectiveBreakPolicy.activePeakRule.maxConcurrentBreaks} out`}
              </span>
            </div>
          )}

          {maxConcurrentBreaks !== null && currentBreaks.length >= maxConcurrentBreaks && (
            <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-5 py-2.5 text-xs font-medium text-amber-900">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-700" />
              <span>
                {maxConcurrentBreaks === 0
                  ? 'Breaks are paused during peak hours. New breaks must wait.'
                  : `Break limit (${maxConcurrentBreaks}) reached. New breaks must wait until someone returns.`}
              </span>
            </div>
          )}

          <div className="max-h-[540px] divide-y divide-slate-100 overflow-y-auto">
            {loading ? (
              <div className="space-y-3 p-4">
                {[1, 2].map((n) => (
                  <div key={n} className="h-20 rounded-lg bg-slate-100" />
                ))}
              </div>
            ) : currentBreaks.length === 0 ? (
              <div className="px-5 py-16 text-center">
                <p className="text-sm font-medium text-slate-700">No active breaks right now</p>
                <p className="mt-1 text-xs text-slate-500">
                  Staff who mark Out for a break appear here live until they mark In.
                </p>
              </div>
            ) : (
              currentBreaks.map((member) => {
                const elapsedSec = Math.max(
                  0,
                  Math.floor((nowMs - new Date(member.activeBreak.outTime).getTime()) / 1000)
                );
                const reasonDisplay =
                  member.activeBreak.reasonCategory === 'Other' && member.activeBreak.customReason
                    ? `Other (${member.activeBreak.customReason})`
                    : member.activeBreak.reasonCategory;
                const isSelected = member.employee.id === selectedId;

                return (
                  <button
                    key={member.activeBreak.id}
                    type="button"
                    onClick={() => {
                      setSuccessNotice(null);
                      applySmartDefaults(member);
                    }}
                    className={`block w-full px-4 py-4 text-left transition-colors sm:px-5 ${
                      isSelected ? 'bg-amber-50/70' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs font-semibold text-slate-500">
                            {member.employee.code}
                          </span>
                          <span aria-hidden="true" className="text-slate-300">
                            ·
                          </span>
                          <span className="truncate text-sm font-semibold text-slate-900">
                            {member.employee.name}
                          </span>
                        </div>
                        <div className="mt-0.5 text-xs text-slate-500">{member.employee.role}</div>
                      </div>

                      <div className="shrink-0 text-right">
                        <div className="font-mono text-sm font-semibold text-amber-700 tabular-nums">
                          {formatDurationClock(elapsedSec)}
                        </div>
                        <div className="mt-0.5 text-xs text-slate-400 tabular-nums">
                          Out {formatShortTime(member.activeBreak.outTime)}
                        </div>
                      </div>
                    </div>

                    <div className="mt-2.5 flex items-center justify-between gap-2 text-xs">
                      <span className="text-slate-500">Mark Out Reason:</span>
                      <span className="truncate font-medium text-slate-800">{reasonDisplay}</span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </section>
      </div>

      {/* BOTTOM ROW: Full-Width Branch Roster */}
      <section aria-label="Branch Staff Roster" className="rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:px-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Branch Roster</h2>
            <p className="mt-0.5 text-xs text-slate-500 tabular-nums">
              {countsByStatus.inBranch} in branch · {countsByStatus.onBreak} on break ·{' '}
              {countsByStatus.offShift} off shift — select your profile to mark In or Out above
            </p>
          </div>

          <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
            <div className="relative sm:w-64">
              <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search name, code, or role..."
                className="w-full rounded-lg border border-slate-200 bg-slate-50 py-1.5 pr-3 pl-9 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:bg-white focus:outline-none"
              />
            </div>

            <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
              {(
                [
                  { id: 'all', label: `All (${staff.length})` },
                  { id: 'in_branch', label: `In (${countsByStatus.inBranch})` },
                  { id: 'on_break', label: `Break (${countsByStatus.onBreak})` },
                  { id: 'off_shift', label: `Off (${countsByStatus.offShift})` },
                ] as { id: StatusFilter; label: string }[]
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setStatusFilter(tab.id)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    statusFilter === tab.id
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="p-4 sm:p-5">
          {loading ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {[1, 2, 3, 4].map((n) => (
                <div key={n} className="h-16 rounded-lg bg-slate-100" />
              ))}
            </div>
          ) : staff.length === 0 ? (
            <div className="py-10 text-center text-sm text-slate-500">
              <div>No staff members have been added to this branch yet.</div>
              {onGoToManager && (
                <button
                  type="button"
                  onClick={onGoToManager}
                  className="mt-3 text-xs font-semibold text-teal-700 underline underline-offset-2 hover:text-teal-900"
                >
                  Go to Manager Portal to add staff
                </button>
              )}
            </div>
          ) : filteredStaff.length === 0 ? (
            <div className="py-10 text-center text-sm text-slate-500">
              No staff members match your current filter.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {filteredStaff.map((member) => {
                const isSelected = member.employee.id === selectedId;
                const statusMeta = STATUS_LABELS[member.status];
                const memberBreakSec = member.activeBreak
                  ? Math.max(
                      0,
                      Math.floor((nowMs - new Date(member.activeBreak.outTime).getTime()) / 1000)
                    )
                  : 0;

                return (
                  <button
                    key={member.employee.id}
                    type="button"
                    onClick={() => handleSelectFromRoster(member)}
                    className={`flex items-center justify-between gap-3 rounded-lg border px-4 py-3 text-left transition-colors ${
                      isSelected
                        ? 'border-teal-700 bg-teal-50/70'
                        : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <div
                        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-xs font-semibold ${
                          isSelected ? 'bg-teal-700 text-white' : 'bg-slate-100 text-slate-700'
                        }`}
                      >
                        {getInitials(member.employee.name)}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-slate-900">
                          {member.employee.name}
                        </div>
                        <div className="truncate text-xs text-slate-500">
                          <span className="font-mono">{member.employee.code}</span>
                          <span aria-hidden="true"> · </span>
                          <span>{member.employee.role}</span>
                        </div>
                      </div>
                    </div>

                    <div className="shrink-0 text-right">
                      <div className={`text-xs font-medium ${statusMeta.colorClass}`}>
                        {statusMeta.label}
                      </div>
                      {member.status === 'on_break' && member.activeBreak ? (
                        <div className="mt-0.5 font-mono text-xs text-amber-700 tabular-nums">
                          {formatDurationClock(memberBreakSec)}
                        </div>
                      ) : member.todayBreaksCount > 0 ? (
                        <div className="mt-0.5 text-xs text-slate-400 tabular-nums">
                          {member.todayBreaksCount} {member.todayBreaksCount === 1 ? 'break' : 'breaks'}
                        </div>
                      ) : null}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* Recent Branch Activity Today */}
      <section aria-label="Recent Branch Activity" className="rounded-xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <h2 className="text-base font-semibold text-slate-900">Recent Branch Activity Today</h2>
          <span className="text-xs text-slate-500 tabular-nums">
            Showing latest {recentLogs.length} {recentLogs.length === 1 ? 'entry' : 'entries'}
          </span>
        </div>

        {recentLogs.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-slate-500">
            No In or Out marks recorded today yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                  <th className="px-5 py-3">Time</th>
                  <th className="px-5 py-3">Staff Member</th>
                  <th className="px-5 py-3">Action</th>
                  <th className="px-5 py-3">Reason</th>
                  <th className="px-5 py-3">Manual Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {recentLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-50/60">
                    <td className="px-5 py-3 font-mono text-xs text-slate-600 tabular-nums whitespace-nowrap">
                      {formatTime(log.timestamp)}
                    </td>
                    <td className="px-5 py-3 font-medium text-slate-900 whitespace-nowrap">
                      {log.employeeName}
                      <span className="ml-2 font-mono text-xs font-normal text-slate-400">
                        {log.employeeCode}
                      </span>
                    </td>
                    <td className="px-5 py-3 whitespace-nowrap">
                      <span
                        className={`font-semibold ${
                          log.direction === 'IN' ? 'text-teal-700' : 'text-slate-700'
                        }`}
                      >
                        Mark {log.direction}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-slate-700 whitespace-nowrap">
                      {log.reasonCategory}
                    </td>
                    <td className="px-5 py-3 text-slate-500">
                      {log.customReason ? log.customReason : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
