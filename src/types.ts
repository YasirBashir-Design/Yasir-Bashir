export const OUT_REASONS = [
  'Shift End',
  'Launch Break',
  'Namaz Break',
  'Rest Room Break',
  'Other',
] as const;

export const PREDEFINED_REASONS = [
  'Shift Start',
  'Forgot Shift Start',
  'Shift Resume',
  ...OUT_REASONS,
] as const;

export type OutReasonCategory = (typeof OUT_REASONS)[number];
export type ReasonCategory = (typeof PREDEFINED_REASONS)[number];

export type PunchDirection = 'IN' | 'OUT';

export type EmployeeStatus = 'in_branch' | 'on_break' | 'off_shift';

export interface Employee {
  id: string;
  code: string;
  name: string;
  role: string;
  active: boolean;
  createdAt: string;
  secretCode?: string;
}

export interface ActiveBreakInfo {
  id: string;
  reasonCategory: ReasonCategory;
  customReason: string | null;
  outTime: string;
}

export interface LastOutLogInfo {
  reasonCategory: ReasonCategory;
  customReason: string | null;
  timestamp: string;
}

export interface UnclosedShiftInfo {
  dateKey: string;
  shiftStartTime: string;
  lastLogTime: string;
  lastLogDirection: PunchDirection;
  lastLogReason: ReasonCategory;
}

export interface StaffMemberState {
  employee: Employee;
  status: EmployeeStatus;
  hasShiftStartToday: boolean;
  shiftStartTime: string | null;
  shiftEndTime: string | null;
  activeBreak: ActiveBreakInfo | null;
  lastOutLog: LastOutLogInfo | null;
  unclosedPreviousShift: UnclosedShiftInfo | null;
  todayBreaksCount: number;
  todayCompletedBreakSeconds: number;
  lastPunchAt: string | null;
}

export interface AttendanceLog {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  employeeRole: string;
  direction: PunchDirection;
  reasonCategory: ReasonCategory;
  customReason: string | null;
  timestamp: string;
  dateKey: string;
  monthKey: string;
}

export interface BreakSession {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  employeeRole: string;
  reasonCategory: ReasonCategory;
  customReason: string | null;
  outTime: string;
  inTime: string | null;
  durationSeconds: number | null;
  status: 'in_progress' | 'completed';
  dateKey: string;
  monthKey: string;
}

export interface EmployeeBreakSummary {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  employeeRole: string;
  secretCode?: string;
  currentStatus?: EmployeeStatus;
  shiftStartTime?: string | null;
  shiftEndTime?: string | null;
  daysLogged?: number;
  totalBreaks: number;
  completedBreaks: number;
  inProgressBreaks: number;
  collectiveCompletedSeconds: number;
  activeBreakOutTime?: string | null;
  reasonBreakdown: Record<string, { count: number; seconds: number }>;
}

export interface PeakBreakRule {
  id: string;
  label: string;
  startTime: string;
  endTime: string;
  maxConcurrentBreaks: number;
  enabled: boolean;
}

export interface EffectiveBreakPolicy {
  activeMode: 'standard' | 'peak';
  maxConcurrentBreaks: number | null;
  standardLimit: number | null;
  activePeakRule: PeakBreakRule | null;
}

export interface StaffKioskResponse {
  dateKey: string;
  maxConcurrentBreaks: number | null;
  effectiveBreakPolicy: EffectiveBreakPolicy;
  staff: StaffMemberState[];
  recentLogs: AttendanceLog[];
}

export interface ManagerTodayResponse {
  dateKey: string;
  maxConcurrentBreaks: number | null;
  effectiveBreakPolicy: EffectiveBreakPolicy;
  breaksInProcess: BreakSession[];
  breaksDone: BreakSession[];
  employeeSummaries: EmployeeBreakSummary[];
  todayLogs: AttendanceLog[];
  activeStaffCount: number;
  offShiftCount: number;
}

export interface ManagerHistoryResponse {
  mode: 'date' | 'month';
  filterValue: string;
  employeeSummaries: EmployeeBreakSummary[];
  breaks: BreakSession[];
  logs: AttendanceLog[];
  availableDates: string[];
  availableMonths: string[];
  employees: Employee[];
}

export type AnalyticsRange = 'weekly' | 'monthly' | 'yearly';

export interface AnalyticsTrendPoint {
  bucketKey: string;
  label: string;
  totalMinutes: number;
  breakCount: number;
  avgMinutes: number;
}

export interface EmployeeAnalyticsMetric {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  employeeRole: string;
  totalBreaks: number;
  completedBreaks: number;
  totalBreakMinutes: number;
  avgBreakMinutes: number;
  daysClockedIn: number;
  onTimeClockIns: number;
  lateClockIns: number;
  categoryCounts: Record<string, number>;
}

export interface ManagerAnalyticsResponse {
  range: AnalyticsRange;
  startDateKey: string;
  endDateKey: string;
  employeeId: string | null;
  employees: Employee[];
  kpis: {
    totalBreaks: number;
    totalBreakMinutes: number;
    avgBreakMinutes: number;
    teamAvgBreakMinutes: number;
    onTimeRatePercent: number;
    totalShiftDays: number;
  };
  trendSeries: AnalyticsTrendPoint[];
  employeeMetrics: EmployeeAnalyticsMetric[];
}

export interface BranchInfo {
  id: string;
  setupCode: string;
  email: string;
  branchName: string;
  createdAt: string;
}

export type NotificationEventType =
  | 'other_break'
  | 'break_exceeded'
  | 'missed_clock_in'
  | 'setup_password'
  | 'setup_staff';
export type NotificationSeverity = 'info' | 'warning' | 'alert';

export interface ManagerNotification {
  id: string;
  eventType: NotificationEventType;
  severity: NotificationSeverity;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  title: string;
  message: string;
  dateKey: string;
  createdAt: string;
  readAt: string | null;
}

export interface AlertRulesConfig {
  lunchBreakLimitMinutes: number;
  otherBreakLimitMinutes: number;
  clockInCutoffTime: string;
  alertOnOtherBreak: boolean;
  maxConcurrentBreaks: number | null;
  peakBreakRules: PeakBreakRule[];
}

