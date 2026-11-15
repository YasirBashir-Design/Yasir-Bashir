import type {
  AlertRulesConfig,
  AnalyticsRange,
  BranchInfo,
  Employee,
  ManagerAnalyticsResponse,
  ManagerHistoryResponse,
  ManagerNotification,
  ManagerTodayResponse,
  OutReasonCategory,
  PunchDirection,
  ReasonCategory,
  StaffKioskResponse,
  StaffMemberState,
} from './types';
import { getLocalDateKey } from './utils/format';

const TOKEN_KEY = 'branchledger_manager_token';
const BRANCH_KEY = 'branchledger_active_branch';

export function getStoredBranch(): BranchInfo | null {
  try {
    const raw = localStorage.getItem(BRANCH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BranchInfo>;
    if (
      typeof parsed.id === 'string' &&
      typeof parsed.email === 'string' &&
      typeof parsed.setupCode === 'string' &&
      typeof parsed.branchName === 'string'
    ) {
      return parsed as BranchInfo;
    }
    return null;
  } catch {
    return null;
  }
}

export function setStoredBranch(branch: BranchInfo | null): void {
  try {
    if (branch) {
      localStorage.setItem(BRANCH_KEY, JSON.stringify(branch));
    } else {
      localStorage.removeItem(BRANCH_KEY);
    }
  } catch {
    // Ignore storage errors in restricted contexts
  }
}

export function getStoredManagerToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setStoredManagerToken(token: string | null): void {
  try {
    if (token) {
      sessionStorage.setItem(TOKEN_KEY, token);
    } else {
      sessionStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    // Ignore storage errors in restricted contexts
  }
}

async function requestJson<T>(url: string, options: RequestInit = {}, useAuth = false): Promise<T> {
  const headers = new Headers(options.headers);
  if (!headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json');
  }
  const activeBranch = getStoredBranch();
  if (activeBranch && !headers.has('X-Branch-Id')) {
    headers.set('X-Branch-Id', activeBranch.id);
  }
  if (useAuth) {
    const token = getStoredManagerToken();
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
  }

  const res = await fetch(url, {
    ...options,
    headers,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errMessage =
      typeof data?.error === 'string' ? data.error : `Request failed (${res.status})`;
    const error = new Error(errMessage) as Error & { status?: number };
    error.status = res.status;
    throw error;
  }

  return data as T;
}

export async function fetchCurrentBranch(branchId?: string): Promise<{ branch: BranchInfo | null }> {
  const qs = branchId ? `?branchId=${encodeURIComponent(branchId)}` : '';
  return requestJson<{ branch: BranchInfo | null }>(`/api/branches/current${qs}`);
}

export async function signupBranch(payload: {
  email: string;
  branchName?: string;
}): Promise<{
  branch: BranchInfo;
  token: string;
  expiresAt: string;
  isDefaultPassword: boolean;
}> {
  const result = await requestJson<{
    branch: BranchInfo;
    token: string;
    expiresAt: string;
    isDefaultPassword: boolean;
  }>('/api/branches/signup', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  setStoredBranch(result.branch);
  setStoredManagerToken(result.token);
  return result;
}

export async function openExistingBranch(identifier: string): Promise<{ branch: BranchInfo }> {
  const result = await requestJson<{ branch: BranchInfo }>('/api/branches/open', {
    method: 'POST',
    body: JSON.stringify({ identifier }),
  });
  setStoredBranch(result.branch);
  setStoredManagerToken(null);
  return result;
}

export async function fetchStaffKioskState(dateKey = getLocalDateKey()): Promise<StaffKioskResponse> {
  const qs = new URLSearchParams({
    date: dateKey,
    localTime: getLocalHHMM(),
  });
  return requestJson<StaffKioskResponse>(`/api/staff/state?${qs.toString()}`);
}

export async function submitStaffPunch(payload: {
  employeeId: string;
  secretCode: string;
  direction: PunchDirection;
  reasonCategory?: OutReasonCategory | ReasonCategory;
  customReason?: string;
  forgotShiftStart?: boolean;
  manualTime?: string;
  timezoneOffsetMinutes?: number;
  dateKey?: string;
}): Promise<{
  success: boolean;
  dateKey: string;
  resolvedReason: string;
  resolvedCustom: string | null;
  timestamp: string;
  member: StaffMemberState | null;
  staff: StaffMemberState[];
}> {
  return requestJson('/api/staff/punch', {
    method: 'POST',
    body: JSON.stringify({
      ...payload,
      localTime: getLocalHHMM(),
      timezoneOffsetMinutes: payload.timezoneOffsetMinutes ?? new Date().getTimezoneOffset(),
      dateKey: payload.dateKey ?? getLocalDateKey(),
    }),
  });
}

export async function submitClosePreviousShift(payload: {
  employeeId: string;
  secretCode: string;
  previousDateKey: string;
  endTime: string;
  reason: string;
  timezoneOffsetMinutes?: number;
  dateKey?: string;
}): Promise<{
  success: boolean;
  previousDateKey: string;
  timestamp: string;
  member: StaffMemberState | null;
  staff: StaffMemberState[];
}> {
  return requestJson('/api/staff/close-previous-shift', {
    method: 'POST',
    body: JSON.stringify({
      ...payload,
      timezoneOffsetMinutes: payload.timezoneOffsetMinutes ?? new Date().getTimezoneOffset(),
      dateKey: payload.dateKey ?? getLocalDateKey(),
    }),
  });
}

export async function checkManagerSession(): Promise<{
  authenticated: boolean;
  isDefaultPassword: boolean;
}> {
  return requestJson('/api/manager/session', {}, true);
}

export async function loginManager(password: string): Promise<{
  token: string;
  expiresAt: string;
  isDefaultPassword: boolean;
}> {
  const result = await requestJson<{
    token: string;
    expiresAt: string;
    isDefaultPassword: boolean;
  }>('/api/manager/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
  setStoredManagerToken(result.token);
  return result;
}

export async function logoutManager(): Promise<void> {
  try {
    await requestJson('/api/manager/logout', { method: 'POST' }, true);
  } finally {
    setStoredManagerToken(null);
  }
}

export async function changeManagerPassword(
  currentPassword: string,
  newPassword: string,
  isInitialSetup = false
): Promise<{ success: boolean }> {
  return requestJson(
    '/api/manager/change-password',
    {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword, isInitialSetup }),
    },
    true
  );
}

export async function fetchManagerToday(dateKey = getLocalDateKey()): Promise<ManagerTodayResponse> {
  const qs = new URLSearchParams({
    date: dateKey,
    localTime: getLocalHHMM(),
  });
  return requestJson<ManagerTodayResponse>(
    `/api/manager/dashboard/today?${qs.toString()}`,
    {},
    true
  );
}

export async function fetchManagerHistory(params: {
  mode: 'date' | 'month';
  date?: string;
  month?: string;
  employeeId?: string;
}): Promise<ManagerHistoryResponse> {
  const qs = new URLSearchParams({ mode: params.mode });
  if (params.date) qs.set('date', params.date);
  if (params.month) qs.set('month', params.month);
  if (params.employeeId) qs.set('employeeId', params.employeeId);
  return requestJson<ManagerHistoryResponse>(`/api/manager/history?${qs.toString()}`, {}, true);
}

export async function createEmployee(payload: {
  name: string;
  role: string;
  code?: string;
}): Promise<{ employee: Employee }> {
  return requestJson(
    '/api/manager/employees',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    true
  );
}

export async function regenerateEmployeeSecretCode(id: string): Promise<{ employee: Employee }> {
  return requestJson(
    `/api/manager/employees/${encodeURIComponent(id)}/regenerate-code`,
    {
      method: 'POST',
    },
    true
  );
}

export async function deactivateEmployee(id: string): Promise<{ success: boolean }> {
  return requestJson(
    `/api/manager/employees/${encodeURIComponent(id)}`,
    {
      method: 'DELETE',
    },
    true
  );
}

export async function fetchManagerAnalytics(params: {
  range: AnalyticsRange;
  date?: string;
  employeeId?: string;
}): Promise<ManagerAnalyticsResponse> {
  const qs = new URLSearchParams({
    range: params.range,
    date: params.date ?? getLocalDateKey(),
  });
  if (params.employeeId) {
    qs.set('employeeId', params.employeeId);
  }
  return requestJson<ManagerAnalyticsResponse>(`/api/manager/analytics?${qs.toString()}`, {}, true);
}

function getLocalHHMM(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

export async function fetchManagerNotifications(dateKey = getLocalDateKey()): Promise<{
  notifications: ManagerNotification[];
  unreadCount: number;
  rules: AlertRulesConfig;
}> {
  const qs = new URLSearchParams({
    date: dateKey,
    localTime: getLocalHHMM(),
  });
  return requestJson(`/api/manager/notifications?${qs.toString()}`, {}, true);
}

export async function markNotificationRead(id: string): Promise<{ success: boolean }> {
  return requestJson(`/api/manager/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' }, true);
}

export async function markAllNotificationsRead(): Promise<{ success: boolean }> {
  return requestJson('/api/manager/notifications/read-all', { method: 'POST' }, true);
}

export async function dismissNotification(id: string): Promise<{ success: boolean }> {
  return requestJson(`/api/manager/notifications/${encodeURIComponent(id)}`, { method: 'DELETE' }, true);
}

export async function fetchAlertRules(): Promise<{ rules: AlertRulesConfig }> {
  return requestJson('/api/manager/alert-rules', {}, true);
}

export async function updateAlertRules(
  rules: Partial<AlertRulesConfig>
): Promise<{ rules: AlertRulesConfig }> {
  return requestJson(
    '/api/manager/alert-rules',
    {
      method: 'PUT',
      body: JSON.stringify({
        ...rules,
        dateKey: getLocalDateKey(),
        localTime: getLocalHHMM(),
      }),
    },
    true
  );
}

export function getManagerWebSocketUrl(): string | null {
  const token = getStoredManagerToken();
  if (!token || typeof window === 'undefined') return null;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws/manager?token=${encodeURIComponent(token)}`;
}

export function getStaffWebSocketUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const branch = getStoredBranch();
  const qs = branch ? `?branchId=${encodeURIComponent(branch.id)}` : '';
  return `${protocol}//${window.location.host}/ws/staff${qs}`;
}

