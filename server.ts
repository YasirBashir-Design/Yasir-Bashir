import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import dotenv from 'dotenv';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import {
  OUT_REASONS,
  type AlertRulesConfig,
  type AnalyticsRange,
  type AnalyticsTrendPoint,
  type AttendanceLog,
  type BranchInfo,
  type BreakSession,
  type EffectiveBreakPolicy,
  type Employee,
  type EmployeeAnalyticsMetric,
  type EmployeeBreakSummary,
  type EmployeeStatus,
  type ManagerNotification,
  type NotificationEventType,
  type NotificationSeverity,
  type PeakBreakRule,
  type PunchDirection,
  type ReasonCategory,
  type StaffMemberState,
  type UnclosedShiftInfo,
} from './src/types.ts';

dotenv.config();

const PORT = 3000;
const DEFAULT_BRANCH_ID = 'br-default';
const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'attendance.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS branches (
    id TEXT PRIMARY KEY,
    setup_code TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    branch_name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS employees (
    id TEXT PRIMARY KEY,
    branch_id TEXT NOT NULL DEFAULT 'br-default',
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    secret_code TEXT,
    UNIQUE(branch_id, code)
  );

  CREATE TABLE IF NOT EXISTS attendance_logs (
    id TEXT PRIMARY KEY,
    branch_id TEXT NOT NULL DEFAULT 'br-default',
    employee_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('IN', 'OUT')),
    reason_category TEXT NOT NULL,
    custom_reason TEXT,
    timestamp TEXT NOT NULL,
    date_key TEXT NOT NULL,
    month_key TEXT NOT NULL,
    FOREIGN KEY(employee_id) REFERENCES employees(id)
  );

  CREATE INDEX IF NOT EXISTS idx_logs_date ON attendance_logs(date_key);
  CREATE INDEX IF NOT EXISTS idx_logs_month ON attendance_logs(month_key);
  CREATE INDEX IF NOT EXISTS idx_logs_emp_date ON attendance_logs(employee_id, date_key);

  CREATE TABLE IF NOT EXISTS break_sessions (
    id TEXT PRIMARY KEY,
    branch_id TEXT NOT NULL DEFAULT 'br-default',
    employee_id TEXT NOT NULL,
    reason_category TEXT NOT NULL,
    custom_reason TEXT,
    out_time TEXT NOT NULL,
    in_time TEXT,
    duration_seconds INTEGER,
    status TEXT NOT NULL CHECK(status IN ('in_progress', 'completed')),
    date_key TEXT NOT NULL,
    month_key TEXT NOT NULL,
    FOREIGN KEY(employee_id) REFERENCES employees(id)
  );

  CREATE INDEX IF NOT EXISTS idx_breaks_date ON break_sessions(date_key);
  CREATE INDEX IF NOT EXISTS idx_breaks_month ON break_sessions(month_key);
  CREATE INDEX IF NOT EXISTS idx_breaks_status ON break_sessions(status);
  CREATE INDEX IF NOT EXISTS idx_breaks_emp_date ON break_sessions(employee_id, date_key);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS branch_settings (
    branch_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (branch_id, key)
  );

  CREATE TABLE IF NOT EXISTS manager_sessions (
    token TEXT PRIMARY KEY,
    branch_id TEXT NOT NULL DEFAULT 'br-default',
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS manager_notifications (
    id TEXT PRIMARY KEY,
    branch_id TEXT NOT NULL DEFAULT 'br-default',
    dedupe_key TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    employee_id TEXT NOT NULL,
    employee_name TEXT NOT NULL,
    employee_code TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    date_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    read_at TEXT,
    dismissed INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_notif_date ON manager_notifications(date_key, dismissed);
`);

function runMultiBranchMigrations(): void {
  db.prepare(
    `INSERT OR IGNORE INTO branches (id, setup_code, email, branch_name, created_at)
     VALUES (?, 'SETUP-1000', 'default@branchledger.local', 'Main Branch', ?)`
  ).run(DEFAULT_BRANCH_ID, new Date().toISOString());

  const empCols = db.prepare('PRAGMA table_info(employees)').all() as Array<{ name: string }>;
  if (!empCols.some((c) => String(c.name) === 'branch_id')) {
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec(`
      BEGIN;
      CREATE TABLE employees_v2 (
        id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL DEFAULT 'br-default',
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        secret_code TEXT,
        UNIQUE(branch_id, code)
      );
      INSERT INTO employees_v2 (id, branch_id, code, name, role, active, created_at, secret_code)
      SELECT id, 'br-default', code, name, role, active, created_at, secret_code FROM employees;
      DROP TABLE employees;
      ALTER TABLE employees_v2 RENAME TO employees;
      COMMIT;
    `);
    db.exec('PRAGMA foreign_keys = ON;');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_employees_branch ON employees(branch_id, active);');

  const logCols = db.prepare('PRAGMA table_info(attendance_logs)').all() as Array<{ name: string }>;
  if (!logCols.some((c) => String(c.name) === 'branch_id')) {
    db.exec("ALTER TABLE attendance_logs ADD COLUMN branch_id TEXT NOT NULL DEFAULT 'br-default'");
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_logs_branch_date ON attendance_logs(branch_id, date_key);');

  const breakCols = db.prepare('PRAGMA table_info(break_sessions)').all() as Array<{ name: string }>;
  if (!breakCols.some((c) => String(c.name) === 'branch_id')) {
    db.exec("ALTER TABLE break_sessions ADD COLUMN branch_id TEXT NOT NULL DEFAULT 'br-default'");
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_breaks_branch_date ON break_sessions(branch_id, date_key);');

  const sessionCols = db.prepare('PRAGMA table_info(manager_sessions)').all() as Array<{ name: string }>;
  if (!sessionCols.some((c) => String(c.name) === 'branch_id')) {
    db.exec("ALTER TABLE manager_sessions ADD COLUMN branch_id TEXT NOT NULL DEFAULT 'br-default'");
  }

  const notifCols = db.prepare('PRAGMA table_info(manager_notifications)').all() as Array<{ name: string }>;
  if (!notifCols.some((c) => String(c.name) === 'branch_id')) {
    db.exec("ALTER TABLE manager_notifications ADD COLUMN branch_id TEXT NOT NULL DEFAULT 'br-default'");
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_notif_branch_date ON manager_notifications(branch_id, date_key, dismissed);');

  const branchSettingsCnt = db.prepare('SELECT COUNT(*) as cnt FROM branch_settings').get() as { cnt: number };
  if (branchSettingsCnt.cnt === 0) {
    const legacySettings = db.prepare('SELECT key, value FROM settings').all() as Array<{
      key: string;
      value: string;
    }>;
    const insertBS = db.prepare(
      'INSERT OR IGNORE INTO branch_settings (branch_id, key, value) VALUES (?, ?, ?)'
    );
    for (const s of legacySettings) {
      insertBS.run(DEFAULT_BRANCH_ID, String(s.key), String(s.value));
    }
  }
}

runMultiBranchMigrations();

function getBranchSetting(branchId: string, key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM branch_settings WHERE branch_id = ? AND key = ?')
    .get(branchId, key) as { value: string } | undefined;
  return row?.value;
}

function setBranchSetting(branchId: string, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO branch_settings (branch_id, key, value) VALUES (?, ?, ?)').run(
    branchId,
    key,
    value
  );
}

function mapBranch(row: Record<string, unknown>): BranchInfo {
  return {
    id: String(row.id),
    setupCode: String(row.setup_code),
    email: String(row.email),
    branchName: String(row.branch_name),
    createdAt: String(row.created_at),
  };
}

function generateUniqueSetupCode(): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = `SETUP-${crypto.randomInt(1000, 10000)}`;
    const exists = db.prepare('SELECT id FROM branches WHERE setup_code = ?').get(candidate);
    if (!exists) return candidate;
  }
  return `SETUP-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
}

function generateUniqueSecretCode(branchId: string): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = String(crypto.randomInt(1000, 10000));
    const exists = db
      .prepare('SELECT id FROM employees WHERE branch_id = ? AND secret_code = ?')
      .get(branchId, candidate);
    if (!exists) return candidate;
  }
  for (let code = 1000; code <= 9999; code += 1) {
    const candidate = String(code);
    const exists = db
      .prepare('SELECT id FROM employees WHERE branch_id = ? AND secret_code = ?')
      .get(branchId, candidate);
    if (!exists) return candidate;
  }
  return String(crypto.randomInt(100, 9999));
}

function ensureEmployeeSecretCodes(): void {
  const missingRows = db
    .prepare("SELECT id, branch_id FROM employees WHERE secret_code IS NULL OR TRIM(secret_code) = ''")
    .all();

  if (missingRows.length > 0) {
    const updateStmt = db.prepare('UPDATE employees SET secret_code = ? WHERE id = ?');
    for (const row of missingRows) {
      updateStmt.run(generateUniqueSecretCode(String(row.branch_id || DEFAULT_BRANCH_ID)), String(row.id));
    }
  }
}

ensureEmployeeSecretCodes();

function hashPassword(password: string, existingSalt?: string): string {
  const salt = existingSalt || crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, keyHex] = parts;
  const derived = crypto.scryptSync(password, salt, 64);
  const storedBuf = Buffer.from(keyHex, 'hex');
  if (derived.length !== storedBuf.length) return false;
  return crypto.timingSafeEqual(derived, storedBuf);
}

function initializeManagerPassword(branchId: string): void {
  const existing = getBranchSetting(branchId, 'manager_password_hash');
  if (!existing) {
    const envPassword = branchId === DEFAULT_BRANCH_ID ? process.env.MANAGER_PASSWORD?.trim() : undefined;
    const initialPassword = envPassword && envPassword.length >= 4 ? envPassword : 'manager123';
    const isDefault = envPassword && envPassword.length >= 4 ? '0' : '1';
    const hashed = hashPassword(initialPassword);

    setBranchSetting(branchId, 'manager_password_hash', hashed);
    setBranchSetting(branchId, 'is_default_password', isDefault);
  }
}

initializeManagerPassword(DEFAULT_BRANCH_ID);

function getServerLocalDateKey(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function normalizeDateKey(input: unknown): string {
  if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return input;
  }
  return getServerLocalDateKey();
}

function normalizeMonthKey(input: unknown, fallbackDateKey: string): string {
  if (typeof input === 'string' && /^\d{4}-\d{2}$/.test(input)) {
    return input;
  }
  return fallbackDateKey.slice(0, 7);
}

function shiftDateKey(dateKey: string, deltaDays: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function previousMonthDateKey(dateKey: string, dayOfMonth = 15): string {
  const [y, m] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 2, dayOfMonth));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function ensureSeeded(todayDateKey: string, branchId = DEFAULT_BRANCH_ID): void {
  if (branchId !== DEFAULT_BRANCH_ID) {
    return;
  }
  const countRow = db
    .prepare('SELECT COUNT(*) as cnt FROM employees WHERE branch_id = ?')
    .get(branchId) as { cnt: number };
  if (countRow.cnt > 0) {
    return;
  }

  const nowMs = Date.now();
  const isoAgo = (minutesAgo: number): string => new Date(nowMs - minutesAgo * 60_000).toISOString();

  const todayMonth = todayDateKey.slice(0, 7);
  const yesterday = shiftDateKey(todayDateKey, -1);
  const yesterdayMonth = yesterday.slice(0, 7);
  const threeDaysAgo = shiftDateKey(todayDateKey, -3);
  const threeDaysAgoMonth = threeDaysAgo.slice(0, 7);
  const prevMonthDay1 = previousMonthDateKey(todayDateKey, 12);
  const prevMonthDay1Month = prevMonthDay1.slice(0, 7);
  const prevMonthDay2 = previousMonthDateKey(todayDateKey, 20);
  const prevMonthDay2Month = prevMonthDay2.slice(0, 7);

  const seedEmployees = [
    { id: 'emp-101', code: 'BR-101', name: 'Ahsan Raza', role: 'Branch Cashier' },
    { id: 'emp-102', code: 'BR-102', name: 'Sara Tariq', role: 'Customer Desk' },
    { id: 'emp-103', code: 'BR-103', name: 'Bilal Mahmood', role: 'Inventory Lead' },
    { id: 'emp-104', code: 'BR-104', name: 'Hina Siddiqui', role: 'Operations Executive' },
    { id: 'emp-105', code: 'BR-105', name: 'Usman Farooq', role: 'Floor Associate' },
    { id: 'emp-106', code: 'BR-106', name: 'Zainab Noor', role: 'Front Desk' },
  ];

  db.exec('BEGIN');
  try {
    const insertEmp = db.prepare(
      'INSERT INTO employees (id, branch_id, code, name, role, active, created_at, secret_code) VALUES (?, ?, ?, ?, ?, 1, ?, ?)'
    );
    for (const emp of seedEmployees) {
      insertEmp.run(
        emp.id,
        branchId,
        emp.code,
        emp.name,
        emp.role,
        isoAgo(60 * 24 * 45),
        generateUniqueSecretCode(branchId)
      );
    }

    const insertLog = db.prepare(
      `INSERT INTO attendance_logs
       (id, branch_id, employee_id, direction, reason_category, custom_reason, timestamp, date_key, month_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertBreak = db.prepare(
      `INSERT INTO break_sessions
       (id, branch_id, employee_id, reason_category, custom_reason, out_time, in_time, duration_seconds, status, date_key, month_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const addLog = (
      empId: string,
      dir: PunchDirection,
      reason: ReasonCategory,
      customReason: string | null,
      ts: string,
      dKey: string,
      mKey: string
    ) => {
      insertLog.run(crypto.randomUUID(), branchId, empId, dir, reason, customReason, ts, dKey, mKey);
    };

    const addCompletedBreak = (
      empId: string,
      reason: ReasonCategory,
      customReason: string | null,
      outTs: string,
      inTs: string,
      durationSec: number,
      dKey: string,
      mKey: string
    ) => {
      addLog(empId, 'OUT', reason, customReason, outTs, dKey, mKey);
      addLog(empId, 'IN', reason, customReason, inTs, dKey, mKey);
      insertBreak.run(
        crypto.randomUUID(),
        branchId,
        empId,
        reason,
        customReason,
        outTs,
        inTs,
        durationSec,
        'completed',
        dKey,
        mKey
      );
    };

    // Today's active branch punches
    addLog('emp-101', 'IN', 'Shift Start', null, isoAgo(320), todayDateKey, todayMonth);
    addLog('emp-102', 'IN', 'Shift Start', null, isoAgo(315), todayDateKey, todayMonth);
    addLog('emp-103', 'IN', 'Shift Start', null, isoAgo(295), todayDateKey, todayMonth);
    addLog('emp-104', 'IN', 'Shift Start', null, isoAgo(280), todayDateKey, todayMonth);
    addLog('emp-105', 'IN', 'Shift Start', null, isoAgo(260), todayDateKey, todayMonth);

    // Completed breaks today
    addCompletedBreak(
      'emp-102',
      'Rest Room Break',
      null,
      isoAgo(210),
      isoAgo(204),
      375,
      todayDateKey,
      todayMonth
    );
    addCompletedBreak(
      'emp-102',
      'Launch Break',
      null,
      isoAgo(125),
      isoAgo(92),
      1965,
      todayDateKey,
      todayMonth
    );
    addCompletedBreak(
      'emp-103',
      'Namaz Break',
      null,
      isoAgo(140),
      isoAgo(127),
      780,
      todayDateKey,
      todayMonth
    );
    addCompletedBreak(
      'emp-104',
      'Other',
      'Courier dispatch pickup at gate',
      isoAgo(85),
      isoAgo(68),
      1020,
      todayDateKey,
      todayMonth
    );

    // One break currently in process today (Usman Farooq on Namaz Break started 8 mins ago)
    const usmanOutTs = isoAgo(8);
    addLog('emp-105', 'OUT', 'Namaz Break', null, usmanOutTs, todayDateKey, todayMonth);
    insertBreak.run(
      crypto.randomUUID(),
      'emp-105',
      'Namaz Break',
      null,
      usmanOutTs,
      null,
      null,
      'in_progress',
      todayDateKey,
      todayMonth
    );

    // Yesterday's completed shifts & breaks
    const buildHistTs = (dKey: string, hhmm: string): string => {
      const [y, m, d] = dKey.split('-').map(Number);
      const [hh, mm] = hhmm.split(':').map(Number);
      return new Date(y, m - 1, d, hh, mm, 0).toISOString();
    };

    for (const empId of ['emp-101', 'emp-102', 'emp-103', 'emp-104', 'emp-105', 'emp-106']) {
      addLog(empId, 'IN', 'Shift Start', null, buildHistTs(yesterday, '09:00'), yesterday, yesterdayMonth);
      addLog(empId, 'OUT', 'Shift End', null, buildHistTs(yesterday, '18:00'), yesterday, yesterdayMonth);
    }
    addCompletedBreak(
      'emp-101',
      'Launch Break',
      null,
      buildHistTs(yesterday, '13:05'),
      buildHistTs(yesterday, '13:40'),
      2100,
      yesterday,
      yesterdayMonth
    );
    addCompletedBreak(
      'emp-101',
      'Namaz Break',
      null,
      buildHistTs(yesterday, '16:10'),
      buildHistTs(yesterday, '16:22'),
      720,
      yesterday,
      yesterdayMonth
    );
    addCompletedBreak(
      'emp-102',
      'Launch Break',
      null,
      buildHistTs(yesterday, '13:15'),
      buildHistTs(yesterday, '13:48'),
      1980,
      yesterday,
      yesterdayMonth
    );
    addCompletedBreak(
      'emp-103',
      'Rest Room Break',
      null,
      buildHistTs(yesterday, '11:20'),
      buildHistTs(yesterday, '11:27'),
      420,
      yesterday,
      yesterdayMonth
    );
    addCompletedBreak(
      'emp-104',
      'Other',
      'Bank cash deposit verification',
      buildHistTs(yesterday, '15:00'),
      buildHistTs(yesterday, '15:24'),
      1440,
      yesterday,
      yesterdayMonth
    );
    addCompletedBreak(
      'emp-106',
      'Namaz Break',
      null,
      buildHistTs(yesterday, '13:45'),
      buildHistTs(yesterday, '13:58'),
      780,
      yesterday,
      yesterdayMonth
    );

    // Three days ago records
    for (const empId of ['emp-101', 'emp-102', 'emp-103', 'emp-105']) {
      addLog(empId, 'IN', 'Shift Start', null, buildHistTs(threeDaysAgo, '09:02'), threeDaysAgo, threeDaysAgoMonth);
      addLog(empId, 'OUT', 'Shift End', null, buildHistTs(threeDaysAgo, '17:58'), threeDaysAgo, threeDaysAgoMonth);
    }
    addCompletedBreak(
      'emp-101',
      'Launch Break',
      null,
      buildHistTs(threeDaysAgo, '13:10'),
      buildHistTs(threeDaysAgo, '13:44'),
      2040,
      threeDaysAgo,
      threeDaysAgoMonth
    );
    addCompletedBreak(
      'emp-102',
      'Rest Room Break',
      null,
      buildHistTs(threeDaysAgo, '11:40'),
      buildHistTs(threeDaysAgo, '11:46'),
      360,
      threeDaysAgo,
      threeDaysAgoMonth
    );
    addCompletedBreak(
      'emp-103',
      'Launch Break',
      null,
      buildHistTs(threeDaysAgo, '13:30'),
      buildHistTs(threeDaysAgo, '14:02'),
      1920,
      threeDaysAgo,
      threeDaysAgoMonth
    );
    addCompletedBreak(
      'emp-105',
      'Namaz Break',
      null,
      buildHistTs(threeDaysAgo, '16:15'),
      buildHistTs(threeDaysAgo, '16:28'),
      780,
      threeDaysAgo,
      threeDaysAgoMonth
    );

    // Previous month sample records so month-wise navigation shows multi-month history
    for (const empId of ['emp-101', 'emp-102', 'emp-104']) {
      addLog(empId, 'IN', 'Shift Start', null, buildHistTs(prevMonthDay1, '09:00'), prevMonthDay1, prevMonthDay1Month);
      addLog(empId, 'OUT', 'Shift End', null, buildHistTs(prevMonthDay1, '18:00'), prevMonthDay1, prevMonthDay1Month);
      addLog(empId, 'IN', 'Shift Start', null, buildHistTs(prevMonthDay2, '09:05'), prevMonthDay2, prevMonthDay2Month);
      addLog(empId, 'OUT', 'Shift End', null, buildHistTs(prevMonthDay2, '18:02'), prevMonthDay2, prevMonthDay2Month);
    }
    addCompletedBreak(
      'emp-101',
      'Launch Break',
      null,
      buildHistTs(prevMonthDay1, '13:00'),
      buildHistTs(prevMonthDay1, '13:35'),
      2100,
      prevMonthDay1,
      prevMonthDay1Month
    );
    addCompletedBreak(
      'emp-102',
      'Namaz Break',
      null,
      buildHistTs(prevMonthDay1, '16:05'),
      buildHistTs(prevMonthDay1, '16:17'),
      720,
      prevMonthDay1,
      prevMonthDay1Month
    );
    addCompletedBreak(
      'emp-104',
      'Other',
      'Branch supply replenishment',
      buildHistTs(prevMonthDay2, '14:20'),
      buildHistTs(prevMonthDay2, '14:42'),
      1320,
      prevMonthDay2,
      prevMonthDay2Month
    );

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('Failed to seed initial data:', err);
  }
}

function mapEmployee(row: Record<string, unknown>, includeSecret = false): Employee {
  const emp: Employee = {
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
    role: String(row.role),
    active: Number(row.active) === 1,
    createdAt: String(row.created_at),
  };
  if (includeSecret && row.secret_code) {
    emp.secretCode = String(row.secret_code);
  }
  return emp;
}

function mapLog(row: Record<string, unknown>): AttendanceLog {
  return {
    id: String(row.id),
    employeeId: String(row.employee_id),
    employeeName: String(row.employee_name),
    employeeCode: String(row.employee_code),
    employeeRole: String(row.employee_role),
    direction: row.direction as PunchDirection,
    reasonCategory: row.reason_category as ReasonCategory,
    customReason: row.custom_reason ? String(row.custom_reason) : null,
    timestamp: String(row.timestamp),
    dateKey: String(row.date_key),
    monthKey: String(row.month_key),
  };
}

function mapBreak(row: Record<string, unknown>): BreakSession {
  return {
    id: String(row.id),
    employeeId: String(row.employee_id),
    employeeName: String(row.employee_name),
    employeeCode: String(row.employee_code),
    employeeRole: String(row.employee_role),
    reasonCategory: row.reason_category as ReasonCategory,
    customReason: row.custom_reason ? String(row.custom_reason) : null,
    outTime: String(row.out_time),
    inTime: row.in_time ? String(row.in_time) : null,
    durationSeconds: row.duration_seconds !== null && row.duration_seconds !== undefined
      ? Number(row.duration_seconds)
      : null,
    status: row.status as 'in_progress' | 'completed',
    dateKey: String(row.date_key),
    monthKey: String(row.month_key),
  };
}

function computeStaffStatesForDate(
  dateKey: string,
  branchId = DEFAULT_BRANCH_ID,
  includeInactive = false,
  includeSecrets = false
): StaffMemberState[] {
  const empSql = includeInactive
    ? 'SELECT * FROM employees WHERE branch_id = ? ORDER BY code ASC'
    : 'SELECT * FROM employees WHERE branch_id = ? AND active = 1 ORDER BY code ASC';
  const empRows = db.prepare(empSql).all(branchId);

  const logRows = db
    .prepare(
      `SELECT l.*, e.name as employee_name, e.code as employee_code, e.role as employee_role
       FROM attendance_logs l
       JOIN employees e ON e.id = l.employee_id
       WHERE l.branch_id = ? AND l.date_key = ?
       ORDER BY l.timestamp ASC`
    )
    .all(branchId, dateKey);

  const breakRows = db
    .prepare(
      `SELECT b.*, e.name as employee_name, e.code as employee_code, e.role as employee_role
       FROM break_sessions b
       JOIN employees e ON e.id = b.employee_id
       WHERE b.branch_id = ? AND b.date_key = ?
       ORDER BY b.out_time ASC`
    )
    .all(branchId, dateKey);

  // Also check if an employee has an open in-progress break (today)
  const openBreakRows = db
    .prepare(
      `SELECT b.*, e.name as employee_name, e.code as employee_code, e.role as employee_role
       FROM break_sessions b
       JOIN employees e ON e.id = b.employee_id
       WHERE b.branch_id = ? AND b.status = 'in_progress'
       ORDER BY b.out_time DESC`
    )
    .all(branchId);

  const logsByEmp = new Map<string, AttendanceLog[]>();
  for (const r of logRows) {
    const log = mapLog(r);
    const list = logsByEmp.get(log.employeeId) || [];
    list.push(log);
    logsByEmp.set(log.employeeId, list);
  }

  const breaksByEmp = new Map<string, BreakSession[]>();
  for (const r of breakRows) {
    const br = mapBreak(r);
    const list = breaksByEmp.get(br.employeeId) || [];
    list.push(br);
    breaksByEmp.set(br.employeeId, list);
  }

  const openBreakByEmp = new Map<string, BreakSession>();
  for (const r of openBreakRows) {
    const br = mapBreak(r);
    if (!openBreakByEmp.has(br.employeeId)) {
      openBreakByEmp.set(br.employeeId, br);
    }
  }

  // Prior-day logs to detect any unclosed shift on the employee's most recent previous date
  const priorLogRows = db
    .prepare(
      `SELECT l.*, e.name as employee_name, e.code as employee_code, e.role as employee_role
       FROM attendance_logs l
       JOIN employees e ON e.id = l.employee_id
       WHERE l.branch_id = ? AND l.date_key < ?
       ORDER BY l.date_key DESC, l.timestamp ASC, l.id ASC`
    )
    .all(branchId, dateKey);

  const priorLatestDayLogsByEmp = new Map<string, { dateKey: string; logs: AttendanceLog[] }>();
  for (const r of priorLogRows) {
    const log = mapLog(r);
    const existing = priorLatestDayLogsByEmp.get(log.employeeId);
    if (!existing) {
      priorLatestDayLogsByEmp.set(log.employeeId, { dateKey: log.dateKey, logs: [log] });
    } else if (existing.dateKey === log.dateKey) {
      existing.logs.push(log);
    }
  }

  return empRows.map((row) => {
    const emp = mapEmployee(row, includeSecrets);
    const empLogs = logsByEmp.get(emp.id) || [];
    const empBreaks = breaksByEmp.get(emp.id) || [];
    const activeBr = openBreakByEmp.get(emp.id) || null;

    let status: EmployeeStatus = 'off_shift';
    const lastLog = empLogs.length > 0 ? empLogs[empLogs.length - 1] : null;

    if (activeBr) {
      status = 'on_break';
    } else if (lastLog) {
      if (lastLog.direction === 'IN') {
        status = 'in_branch';
      } else if (lastLog.reasonCategory === 'Shift End') {
        status = 'off_shift';
      } else {
        status = 'on_break';
      }
    }

    const hasShiftStartToday = empLogs.some((l) => l.direction === 'IN');

    const shiftStartLog =
      empLogs.find(
        (l) =>
          l.direction === 'IN' &&
          (l.reasonCategory === 'Shift Start' || l.reasonCategory === 'Forgot Shift Start')
      ) || empLogs.find((l) => l.direction === 'IN');

    const shiftEndLog = [...empLogs]
      .reverse()
      .find((l) => l.direction === 'OUT' && l.reasonCategory === 'Shift End');

    const lastOut = [...empLogs].reverse().find((l) => l.direction === 'OUT') ?? null;

    let unclosedPreviousShift: UnclosedShiftInfo | null = null;
    const prevRecord = priorLatestDayLogsByEmp.get(emp.id);
    if (prevRecord && prevRecord.logs.length > 0) {
      const hasInPrev = prevRecord.logs.some((l) => l.direction === 'IN');
      const lastPrevLog = prevRecord.logs[prevRecord.logs.length - 1];
      if (
        hasInPrev &&
        lastPrevLog &&
        !(lastPrevLog.direction === 'OUT' && lastPrevLog.reasonCategory === 'Shift End')
      ) {
        const firstInPrev = prevRecord.logs.find((l) => l.direction === 'IN')!;
        unclosedPreviousShift = {
          dateKey: prevRecord.dateKey,
          shiftStartTime: firstInPrev.timestamp,
          lastLogTime: lastPrevLog.timestamp,
          lastLogDirection: lastPrevLog.direction,
          lastLogReason: lastPrevLog.reasonCategory,
        };
      }
    }

    const completedBreaks = empBreaks.filter((b) => b.status === 'completed');
    const collectiveCompletedSeconds = completedBreaks.reduce(
      (acc, b) => acc + (b.durationSeconds ?? 0),
      0
    );

    return {
      employee: emp,
      status,
      hasShiftStartToday,
      shiftStartTime: shiftStartLog ? shiftStartLog.timestamp : null,
      shiftEndTime: shiftEndLog ? shiftEndLog.timestamp : null,
      activeBreak: activeBr
        ? {
            id: activeBr.id,
            reasonCategory: activeBr.reasonCategory,
            customReason: activeBr.customReason,
            outTime: activeBr.outTime,
          }
        : null,
      lastOutLog: lastOut
        ? {
            reasonCategory: lastOut.reasonCategory,
            customReason: lastOut.customReason,
            timestamp: lastOut.timestamp,
          }
        : null,
      unclosedPreviousShift,
      todayBreaksCount: empBreaks.length,
      todayCompletedBreakSeconds: collectiveCompletedSeconds,
      lastPunchAt: lastLog ? lastLog.timestamp : null,
    };
  });
}

function getUnclosedPreviousShift(
  employeeId: string,
  currentDateKey: string,
  branchId = DEFAULT_BRANCH_ID
): UnclosedShiftInfo | null {
  const prevDayRow = db
    .prepare(
      `SELECT date_key
       FROM attendance_logs
       WHERE branch_id = ? AND employee_id = ? AND date_key < ?
       ORDER BY date_key DESC
       LIMIT 1`
    )
    .get(branchId, employeeId, currentDateKey) as { date_key: string } | undefined;

  if (!prevDayRow) return null;
  const prevDateKey = String(prevDayRow.date_key);

  const prevRows = db
    .prepare(
      `SELECT l.*, e.name as employee_name, e.code as employee_code, e.role as employee_role
       FROM attendance_logs l
       JOIN employees e ON e.id = l.employee_id
       WHERE l.branch_id = ? AND l.employee_id = ? AND l.date_key = ?
       ORDER BY l.timestamp ASC, l.id ASC`
    )
    .all(branchId, employeeId, prevDateKey);

  const prevLogs = prevRows.map(mapLog);
  if (prevLogs.length === 0) return null;

  const hasInPrev = prevLogs.some((l) => l.direction === 'IN');
  const lastPrevLog = prevLogs[prevLogs.length - 1];
  if (
    hasInPrev &&
    lastPrevLog &&
    !(lastPrevLog.direction === 'OUT' && lastPrevLog.reasonCategory === 'Shift End')
  ) {
    const firstInPrev = prevLogs.find((l) => l.direction === 'IN')!;
    return {
      dateKey: prevDateKey,
      shiftStartTime: firstInPrev.timestamp,
      lastLogTime: lastPrevLog.timestamp,
      lastLogDirection: lastPrevLog.direction,
      lastLogReason: lastPrevLog.reasonCategory,
    };
  }

  return null;
}

function buildEmployeeBreakSummaries(
  employees: Employee[],
  breaks: BreakSession[],
  logs: AttendanceLog[],
  todayStates?: StaffMemberState[]
): EmployeeBreakSummary[] {
  const stateMap = new Map<string, StaffMemberState>();
  if (todayStates) {
    for (const s of todayStates) {
      stateMap.set(s.employee.id, s);
    }
  }

  return employees.map((emp) => {
    const empBreaks = breaks.filter((b) => b.employeeId === emp.id);
    const empLogs = logs.filter((l) => l.employeeId === emp.id);
    const completed = empBreaks.filter((b) => b.status === 'completed');
    const inProgress = empBreaks.filter((b) => b.status === 'in_progress');
    const collectiveCompletedSeconds = completed.reduce(
      (sum, b) => sum + (b.durationSeconds ?? 0),
      0
    );

    const reasonBreakdown: Record<string, { count: number; seconds: number }> = {};
    for (const br of empBreaks) {
      const key = br.reasonCategory;
      if (!reasonBreakdown[key]) {
        reasonBreakdown[key] = { count: 0, seconds: 0 };
      }
      reasonBreakdown[key].count += 1;
      if (br.status === 'completed' && br.durationSeconds) {
        reasonBreakdown[key].seconds += br.durationSeconds;
      }
    }

    const daysSet = new Set<string>();
    for (const l of empLogs) daysSet.add(l.dateKey);
    for (const b of empBreaks) daysSet.add(b.dateKey);

    const state = stateMap.get(emp.id);

    const shiftStartLog =
      empLogs.find(
        (l) =>
          l.direction === 'IN' &&
          (l.reasonCategory === 'Shift Start' || l.reasonCategory === 'Forgot Shift Start')
      ) || empLogs.find((l) => l.direction === 'IN');
    const shiftEndLog = [...empLogs]
      .reverse()
      .find((l) => l.direction === 'OUT' && l.reasonCategory === 'Shift End');

    return {
      employeeId: emp.id,
      employeeCode: emp.code,
      employeeName: emp.name,
      employeeRole: emp.role,
      ...(emp.secretCode ? { secretCode: emp.secretCode } : {}),
      currentStatus: state?.status,
      shiftStartTime: state ? state.shiftStartTime : shiftStartLog?.timestamp ?? null,
      shiftEndTime: state ? state.shiftEndTime : shiftEndLog?.timestamp ?? null,
      daysLogged: daysSet.size,
      totalBreaks: empBreaks.length,
      completedBreaks: completed.length,
      inProgressBreaks: inProgress.length,
      collectiveCompletedSeconds,
      activeBreakOutTime: inProgress[0]?.outTime ?? state?.activeBreak?.outTime ?? null,
      reasonBreakdown,
    };
  });
}

interface BranchRequest extends Request {
  managerBranchId?: string;
}

function getRequestedBranchCandidate(req: Request): string {
  const headerId =
    typeof req.headers['x-branch-id'] === 'string' ? req.headers['x-branch-id'].trim() : '';
  const queryId =
    typeof req.query.branchId === 'string' ? req.query.branchId.trim() : '';
  return headerId || queryId || DEFAULT_BRANCH_ID;
}

function resolveBranchId(req: Request, res: Response): string | null {
  const candidate = getRequestedBranchCandidate(req);
  const row = db.prepare('SELECT id FROM branches WHERE id = ?').get(candidate);
  if (!row) {
    res.status(404).json({ error: 'Branch not found. Please set up or open a valid branch.' });
    return null;
  }
  return candidate;
}

function getTokenFromRequest(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return null;
}

function getSessionBranchId(token: string | null): string | null {
  if (!token) return null;
  const row = db
    .prepare('SELECT branch_id, expires_at FROM manager_sessions WHERE token = ?')
    .get(token) as { branch_id: string; expires_at: string } | undefined;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare('DELETE FROM manager_sessions WHERE token = ?').run(token);
    return null;
  }
  return String(row.branch_id || DEFAULT_BRANCH_ID);
}

function requireManagerAuth(req: BranchRequest, res: Response, next: NextFunction): void {
  const token = getTokenFromRequest(req);
  const sessionBranchId = getSessionBranchId(token);
  if (!sessionBranchId) {
    res.status(401).json({ error: 'Manager authentication required.' });
    return;
  }
  const headerBranch =
    typeof req.headers['x-branch-id'] === 'string' ? req.headers['x-branch-id'].trim() : '';
  if (headerBranch && headerBranch !== sessionBranchId) {
    res.status(401).json({ error: 'Manager session does not match the active branch.' });
    return;
  }
  req.managerBranchId = sessionBranchId;
  next();
}

function isDefaultPasswordActive(branchId = DEFAULT_BRANCH_ID): boolean {
  return getBranchSetting(branchId, 'is_default_password') === '1';
}

const DEFAULT_ALERT_RULES: AlertRulesConfig = {
  lunchBreakLimitMinutes: 30,
  otherBreakLimitMinutes: 15,
  clockInCutoffTime: '09:15',
  alertOnOtherBreak: true,
  maxConcurrentBreaks: null,
  peakBreakRules: [],
};

function sanitizePeakBreakRules(raw: unknown): PeakBreakRule[] {
  if (!Array.isArray(raw)) return [];
  const clean: PeakBreakRule[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const startTime = typeof obj.startTime === 'string' ? obj.startTime.trim() : '';
    const endTime = typeof obj.endTime === 'string' ? obj.endTime.trim() : '';
    if (!/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime) || startTime === endTime) {
      continue;
    }
    const maxRaw = Number(obj.maxConcurrentBreaks);
    if (!Number.isFinite(maxRaw) || maxRaw < 0 || maxRaw > 100) continue;
    const rawLabel = typeof obj.label === 'string' ? obj.label.trim() : '';
    clean.push({
      id:
        typeof obj.id === 'string' && obj.id.trim().length > 0
          ? obj.id.trim()
          : crypto.randomUUID(),
      label: rawLabel ? rawLabel.slice(0, 60) : 'Peak Hours',
      startTime,
      endTime,
      maxConcurrentBreaks: Math.round(maxRaw),
      enabled: typeof obj.enabled === 'boolean' ? obj.enabled : true,
    });
  }
  return clean;
}

function isTimeWithinPeakWindow(currentHHMM: string, startTime: string, endTime: string): boolean {
  if (startTime < endTime) {
    return currentHHMM >= startTime && currentHHMM < endTime;
  }
  if (startTime > endTime) {
    return currentHHMM >= startTime || currentHHMM < endTime;
  }
  return false;
}

function resolveEffectiveBreakPolicy(
  rules: AlertRulesConfig,
  localTimeHHMM?: unknown
): EffectiveBreakPolicy {
  const currentHHMM =
    typeof localTimeHHMM === 'string' && /^\d{2}:\d{2}$/.test(localTimeHHMM)
      ? localTimeHHMM
      : getServerLocalHHMM();

  const activeMatches = (rules.peakBreakRules ?? []).filter(
    (rule) => rule.enabled && isTimeWithinPeakWindow(currentHHMM, rule.startTime, rule.endTime)
  );

  if (activeMatches.length > 0) {
    const strictest = activeMatches.reduce((best, curr) =>
      curr.maxConcurrentBreaks < best.maxConcurrentBreaks ? curr : best
    );
    return {
      activeMode: 'peak',
      maxConcurrentBreaks: strictest.maxConcurrentBreaks,
      standardLimit: rules.maxConcurrentBreaks,
      activePeakRule: strictest,
    };
  }

  return {
    activeMode: 'standard',
    maxConcurrentBreaks: rules.maxConcurrentBreaks,
    standardLimit: rules.maxConcurrentBreaks,
    activePeakRule: null,
  };
}

function getAlertRules(branchId = DEFAULT_BRANCH_ID): AlertRulesConfig {
  const raw = getBranchSetting(branchId, 'alert_rules_json');
  if (!raw) return { ...DEFAULT_ALERT_RULES, peakBreakRules: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<AlertRulesConfig>;
    return {
      lunchBreakLimitMinutes:
        typeof parsed.lunchBreakLimitMinutes === 'number' && parsed.lunchBreakLimitMinutes >= 1
          ? parsed.lunchBreakLimitMinutes
          : DEFAULT_ALERT_RULES.lunchBreakLimitMinutes,
      otherBreakLimitMinutes:
        typeof parsed.otherBreakLimitMinutes === 'number' && parsed.otherBreakLimitMinutes >= 1
          ? parsed.otherBreakLimitMinutes
          : DEFAULT_ALERT_RULES.otherBreakLimitMinutes,
      clockInCutoffTime:
        typeof parsed.clockInCutoffTime === 'string' && /^\d{2}:\d{2}$/.test(parsed.clockInCutoffTime)
          ? parsed.clockInCutoffTime
          : DEFAULT_ALERT_RULES.clockInCutoffTime,
      alertOnOtherBreak:
        typeof parsed.alertOnOtherBreak === 'boolean'
          ? parsed.alertOnOtherBreak
          : DEFAULT_ALERT_RULES.alertOnOtherBreak,
      maxConcurrentBreaks:
        typeof parsed.maxConcurrentBreaks === 'number' &&
        Number.isFinite(parsed.maxConcurrentBreaks) &&
        parsed.maxConcurrentBreaks >= 1
          ? Math.round(parsed.maxConcurrentBreaks)
          : null,
      peakBreakRules: sanitizePeakBreakRules(parsed.peakBreakRules),
    };
  } catch {
    return { ...DEFAULT_ALERT_RULES, peakBreakRules: [] };
  }
}

function saveAlertRules(branchId: string, rules: AlertRulesConfig): void {
  setBranchSetting(branchId, 'alert_rules_json', JSON.stringify(rules));
}

function mapNotification(row: Record<string, unknown>): ManagerNotification {
  return {
    id: String(row.id),
    eventType: row.event_type as NotificationEventType,
    severity: row.severity as NotificationSeverity,
    employeeId: String(row.employee_id),
    employeeName: String(row.employee_name),
    employeeCode: String(row.employee_code),
    title: String(row.title),
    message: String(row.message),
    dateKey: String(row.date_key),
    createdAt: String(row.created_at),
    readAt: row.read_at ? String(row.read_at) : null,
  };
}

interface BranchSocketClient {
  ws: WebSocket;
  branchId: string;
}

const connectedManagers = new Set<BranchSocketClient>();
const connectedStaffTerminals = new Set<BranchSocketClient>();
const activeBranchDates = new Map<string, string>();
activeBranchDates.set(DEFAULT_BRANCH_ID, getServerLocalDateKey());

function broadcastToManagers(branchId: string, event: string, payload: unknown): void {
  const message = JSON.stringify({ event, payload });
  for (const client of connectedManagers) {
    if (client.branchId === branchId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(message);
    }
  }
}

function broadcastToStaffTerminals(branchId: string, event: string, payload: unknown): void {
  const message = JSON.stringify({ event, payload });
  for (const client of connectedStaffTerminals) {
    if (client.branchId === branchId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(message);
    }
  }
}

function createNotificationIfNew(params: {
  branchId: string;
  dedupeKey: string;
  eventType: NotificationEventType;
  severity: NotificationSeverity;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  title: string;
  message: string;
  dateKey: string;
}): ManagerNotification | null {
  const scopedDedupeKey = `${params.branchId}:${params.dedupeKey}`;
  const existing = db
    .prepare('SELECT id FROM manager_notifications WHERE dedupe_key = ?')
    .get(scopedDedupeKey);
  if (existing) return null;

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO manager_notifications
     (id, branch_id, dedupe_key, event_type, severity, employee_id, employee_name, employee_code, title, message, date_key, created_at, read_at, dismissed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)`
  ).run(
    id,
    params.branchId,
    scopedDedupeKey,
    params.eventType,
    params.severity,
    params.employeeId,
    params.employeeName,
    params.employeeCode,
    params.title,
    params.message,
    params.dateKey,
    createdAt
  );

  const notification: ManagerNotification = {
    id,
    eventType: params.eventType,
    severity: params.severity,
    employeeId: params.employeeId,
    employeeName: params.employeeName,
    employeeCode: params.employeeCode,
    title: params.title,
    message: params.message,
    dateKey: params.dateKey,
    createdAt,
    readAt: null,
  };

  broadcastToManagers(params.branchId, 'notification:created', notification);
  return notification;
}

function getServerLocalHHMM(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

function evaluateRealtimeAlerts(
  dateKey: string,
  branchId = DEFAULT_BRANCH_ID,
  localTimeHHMM?: string
): ManagerNotification[] {
  const rules = getAlertRules(branchId);
  const created: ManagerNotification[] = [];
  const nowMs = Date.now();

  // 1. Evaluate 'Other' breaks recorded today
  if (rules.alertOnOtherBreak) {
    const otherBreaks = db
      .prepare(
        `SELECT b.*, e.name as employee_name, e.code as employee_code
         FROM break_sessions b
         JOIN employees e ON e.id = b.employee_id
         WHERE b.branch_id = ? AND b.date_key = ? AND b.reason_category = 'Other'`
      )
      .all(branchId, dateKey);

    for (const row of otherBreaks) {
      const id = String(row.id);
      const custom = row.custom_reason ? String(row.custom_reason) : 'No custom note';
      const notif = createNotificationIfNew({
        branchId,
        dedupeKey: `other_break:${id}`,
        eventType: 'other_break',
        severity: 'info',
        employeeId: String(row.employee_id),
        employeeName: String(row.employee_name),
        employeeCode: String(row.employee_code),
        title: `Other break: ${String(row.employee_name)}`,
        message: `${String(row.employee_name)} (${String(row.employee_code)}) logged an Other break: "${custom}".`,
        dateKey,
      });
      if (notif) created.push(notif);
    }
  }

  // 2. Evaluate breaks exceeding predefined duration (in-progress or completed today)
  const todayBreaks = db
    .prepare(
      `SELECT b.*, e.name as employee_name, e.code as employee_code
       FROM break_sessions b
       JOIN employees e ON e.id = b.employee_id
       WHERE b.branch_id = ? AND (b.date_key = ? OR b.status = 'in_progress')`
    )
    .all(branchId, dateKey);

  for (const row of todayBreaks) {
    const reason = String(row.reason_category);
    const limitMinutes =
      reason === 'Launch Break' ? rules.lunchBreakLimitMinutes : rules.otherBreakLimitMinutes;
    const limitSeconds = limitMinutes * 60;

    let elapsedSeconds = 0;
    if (row.status === 'completed' && row.duration_seconds !== null && row.duration_seconds !== undefined) {
      elapsedSeconds = Number(row.duration_seconds);
    } else {
      const outMs = new Date(String(row.out_time)).getTime();
      elapsedSeconds = Math.max(0, Math.floor((nowMs - outMs) / 1000));
    }

    if (elapsedSeconds > limitSeconds) {
      const mins = Math.floor(elapsedSeconds / 60);
      const empName = String(row.employee_name);
      const empCode = String(row.employee_code);
      const isLive = row.status === 'in_progress';
      const notif = createNotificationIfNew({
        branchId,
        dedupeKey: `break_exceeded:${String(row.id)}`,
        eventType: 'break_exceeded',
        severity: 'alert',
        employeeId: String(row.employee_id),
        employeeName: empName,
        employeeCode: empCode,
        title: `Break limit exceeded: ${empName}`,
        message: `${empName} (${empCode}) ${isLive ? 'is currently at' : 'completed'} ${mins}m on ${reason} (limit: ${limitMinutes}m).`,
        dateKey: String(row.date_key),
      });
      if (notif) created.push(notif);
    }
  }

  // 3. Evaluate missed clock-ins past the specified cutoff time
  const currentHHMM =
    localTimeHHMM && /^\d{2}:\d{2}$/.test(localTimeHHMM) ? localTimeHHMM : getServerLocalHHMM();

  if (currentHHMM >= rules.clockInCutoffTime) {
    const missingRows = db
      .prepare(
        `SELECT e.id, e.name, e.code
         FROM employees e
         WHERE e.branch_id = ? AND e.active = 1
           AND NOT EXISTS (
             SELECT 1 FROM attendance_logs l
             WHERE l.branch_id = ? AND l.employee_id = e.id AND l.date_key = ? AND l.direction = 'IN'
           )`
      )
      .all(branchId, branchId, dateKey);

    for (const emp of missingRows) {
      const empId = String(emp.id);
      const empName = String(emp.name);
      const empCode = String(emp.code);
      const notif = createNotificationIfNew({
        branchId,
        dedupeKey: `missed_clock_in:${empId}:${dateKey}`,
        eventType: 'missed_clock_in',
        severity: 'warning',
        employeeId: empId,
        employeeName: empName,
        employeeCode: empCode,
        title: `Missed clock-in: ${empName}`,
        message: `${empName} (${empCode}) has not clocked in by the ${rules.clockInCutoffTime} branch cutoff.`,
        dateKey,
      });
      if (notif) created.push(notif);
    }
  }

  return created;
}

function getMonthRangeKeys(endMonthKey: string, count: number): string[] {
  const [y, m] = endMonthKey.split('-').map(Number);
  const result: string[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const dt = new Date(Date.UTC(y, m - 1 - i, 1));
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    result.push(`${yy}-${mm}`);
  }
  return result;
}

function formatDateBucketLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatMonthBucketLabel(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number);
  const dt = new Date(y, m - 1, 1);
  return dt.toLocaleDateString([], { month: 'short', year: '2-digit' });
}

async function startServer() {
  const app = express();
  app.use(express.json());

  // 0. Branch Setup & Sign Up (1 Email ID = 1 Branch / Setup ID)
  app.get('/api/branches/current', (req: Request, res: Response) => {
    const rawId =
      (typeof req.headers['x-branch-id'] === 'string' && req.headers['x-branch-id'].trim()) ||
      (typeof req.query.branchId === 'string' && req.query.branchId.trim()) ||
      '';
    if (!rawId) {
      res.json({ branch: null });
      return;
    }
    const row = db.prepare('SELECT * FROM branches WHERE id = ?').get(rawId) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      res.status(404).json({ error: 'Branch not found.' });
      return;
    }
    res.json({ branch: mapBranch(row) });
  });

  app.post('/api/branches/signup', (req: Request, res: Response) => {
    const { email: rawEmail, branchName: rawBranchName } = req.body ?? {};
    const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: 'Please enter a valid email address for your branch setup.' });
      return;
    }

    const existing = db
      .prepare('SELECT id FROM branches WHERE LOWER(email) = LOWER(?)')
      .get(email);
    if (existing) {
      res.status(409).json({
        error:
          'A branch is already registered with this email. Switch to Open Existing Branch to access it.',
      });
      return;
    }

    const cleanNameInput = typeof rawBranchName === 'string' ? rawBranchName.trim().slice(0, 80) : '';
    const emailPrefix = email.split('@')[0]?.replace(/[._-]+/g, ' ').trim() || 'Main';
    const titlePrefix = emailPrefix.replace(/\b\w/g, (c) => c.toUpperCase());
    const branchName = cleanNameInput.length >= 2 ? cleanNameInput : `${titlePrefix} Branch`;

    const branchId = `br-${crypto.randomUUID().slice(0, 8)}`;
    const setupCode = generateUniqueSetupCode();
    const nowIso = new Date().toISOString();
    const todayKey = getServerLocalDateKey();

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    db.exec('BEGIN');
    try {
      db.prepare(
        'INSERT INTO branches (id, setup_code, email, branch_name, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(branchId, setupCode, email, branchName, nowIso);

      initializeManagerPassword(branchId);
      saveAlertRules(branchId, { ...DEFAULT_ALERT_RULES, peakBreakRules: [] });

      db.prepare(
        'INSERT INTO manager_sessions (token, branch_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
      ).run(token, branchId, nowIso, expiresAt);

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      console.error('Branch signup failed:', err);
      res.status(500).json({ error: 'Unable to complete branch setup.' });
      return;
    }

    activeBranchDates.set(branchId, todayKey);

    createNotificationIfNew({
      branchId,
      dedupeKey: 'setup_password',
      eventType: 'setup_password',
      severity: 'warning',
      employeeId: 'branch-setup',
      employeeName: branchName,
      employeeCode: setupCode,
      title: 'Create New Manager Portal Password',
      message: `Branch ${setupCode} (${email}) is ready. Create a private password for your Manager Portal to replace the temporary setup access.`,
      dateKey: todayKey,
    });

    createNotificationIfNew({
      branchId,
      dedupeKey: 'setup_staff',
      eventType: 'setup_staff',
      severity: 'info',
      employeeId: 'branch-setup',
      employeeName: branchName,
      employeeCode: setupCode,
      title: 'Add Branch Staff Members',
      message:
        'No staff members have been added yet. Add your branch employees in Staff & Settings to auto-assign their 4-digit secret codes.',
      dateKey: todayKey,
    });

    const branch: BranchInfo = {
      id: branchId,
      setupCode,
      email,
      branchName,
      createdAt: nowIso,
    };

    res.status(201).json({
      branch,
      token,
      expiresAt,
      isDefaultPassword: true,
    });
  });

  app.post('/api/branches/open', (req: Request, res: Response) => {
    const { identifier: rawIdentifier } = req.body ?? {};
    const identifier = typeof rawIdentifier === 'string' ? rawIdentifier.trim() : '';
    if (!identifier) {
      res.status(400).json({ error: 'Please enter your registered email address or Setup ID.' });
      return;
    }

    const row = db
      .prepare('SELECT * FROM branches WHERE LOWER(email) = LOWER(?) OR UPPER(setup_code) = UPPER(?)')
      .get(identifier, identifier) as Record<string, unknown> | undefined;

    if (!row) {
      res.status(404).json({
        error: 'No branch found for that Email ID or Setup ID. Please verify or sign up as a new branch.',
      });
      return;
    }

    const branch = mapBranch(row);
    initializeManagerPassword(branch.id);
    activeBranchDates.set(branch.id, getServerLocalDateKey());
    res.json({ branch });
  });

  // 1. Staff Kiosk State
  app.get('/api/staff/state', (req: Request, res: Response) => {
    const branchId = resolveBranchId(req, res);
    if (!branchId) return;

    const dateKey = normalizeDateKey(req.query.date);
    activeBranchDates.set(branchId, dateKey);
    ensureSeeded(dateKey, branchId);
    evaluateRealtimeAlerts(dateKey, branchId);

    const staff = computeStaffStatesForDate(dateKey, branchId, false);
    const recentRows = db
      .prepare(
        `SELECT l.*, e.name as employee_name, e.code as employee_code, e.role as employee_role
         FROM attendance_logs l
         JOIN employees e ON e.id = l.employee_id
         WHERE l.branch_id = ? AND l.date_key = ?
         ORDER BY l.timestamp DESC
         LIMIT 20`
      )
      .all(branchId, dateKey);

    const localTime = typeof req.query.localTime === 'string' ? req.query.localTime : undefined;
    const effectiveBreakPolicy = resolveEffectiveBreakPolicy(getAlertRules(branchId), localTime);

    res.json({
      dateKey,
      maxConcurrentBreaks: effectiveBreakPolicy.maxConcurrentBreaks,
      effectiveBreakPolicy,
      staff,
      recentLogs: recentRows.map(mapLog),
    });
  });

  // 2. Staff Mark IN / OUT Punch
  app.post('/api/staff/punch', (req: Request, res: Response) => {
    const branchId = resolveBranchId(req, res);
    if (!branchId) return;

    const {
      employeeId,
      secretCode,
      direction,
      reasonCategory,
      customReason,
      forgotShiftStart,
      manualTime,
      timezoneOffsetMinutes,
      localTime,
      dateKey: rawDateKey,
    } = req.body ?? {};
    const dateKey = normalizeDateKey(rawDateKey);
    const monthKey = dateKey.slice(0, 7);
    ensureSeeded(dateKey, branchId);

    if (typeof employeeId !== 'string' || !employeeId.trim()) {
      res.status(400).json({ error: 'Please select a staff member.' });
      return;
    }

    const cleanedSecret = typeof secretCode === 'string' ? secretCode.trim() : '';
    if (!/^\d{1,4}$/.test(cleanedSecret)) {
      res.status(400).json({ error: 'Please enter your secret code (up to 4 digits).' });
      return;
    }

    if (direction !== 'IN' && direction !== 'OUT') {
      res.status(400).json({ error: 'Direction must be IN or OUT.' });
      return;
    }

    const empRow = db
      .prepare('SELECT * FROM employees WHERE id = ? AND branch_id = ? AND active = 1')
      .get(employeeId, branchId) as Record<string, unknown> | undefined;

    if (!empRow) {
      res.status(404).json({ error: 'Employee not found or inactive.' });
      return;
    }

    const storedSecret = empRow.secret_code ? String(empRow.secret_code) : '';
    if (!storedSecret || cleanedSecret !== storedSecret) {
      res.status(403).json({
        error: `Incorrect secret code for ${String(empRow.name)}. Please verify and try again.`,
      });
      return;
    }

    const cleanedCustom = typeof customReason === 'string' ? customReason.trim() : '';
    if (cleanedCustom.length > 200) {
      res.status(400).json({ error: 'Reason must be 200 characters or less.' });
      return;
    }

    const nowMs = Date.now();
    let punchIso = new Date(nowMs).toISOString();
    let resolvedReason: string = '';
    let resolvedCustom: string | null = null;

    if (direction === 'IN') {
      const existingInToday = db
        .prepare(
          `SELECT id FROM attendance_logs
           WHERE branch_id = ? AND employee_id = ? AND date_key = ? AND direction = 'IN'
           LIMIT 1`
        )
        .get(branchId, employeeId, dateKey);

      const openBreak = db
        .prepare(
          `SELECT * FROM break_sessions
           WHERE branch_id = ? AND employee_id = ? AND status = 'in_progress'
           ORDER BY out_time DESC LIMIT 1`
        )
        .get(branchId, employeeId) as Record<string, unknown> | undefined;

      const lastOutToday = db
        .prepare(
          `SELECT * FROM attendance_logs
           WHERE branch_id = ? AND employee_id = ? AND date_key = ? AND direction = 'OUT'
           ORDER BY timestamp DESC LIMIT 1`
        )
        .get(branchId, employeeId, dateKey) as Record<string, unknown> | undefined;

      if (!existingInToday) {
        // Block starting today's shift if previous logged day's shift was not ended
        const unclosed = getUnclosedPreviousShift(employeeId, dateKey, branchId);
        if (unclosed) {
          res.status(409).json({
            error: `Please end your shift from ${unclosed.dateKey} first and enter the reason for not ending your shift on the last day.`,
          });
          return;
        }

        // First Mark IN of the day = Shift Start (or Forgot Shift Start with back time & reason)
        if (forgotShiftStart === true) {
          if (typeof manualTime !== 'string' || !/^\d{2}:\d{2}$/.test(manualTime)) {
            res.status(400).json({ error: 'Please enter a valid shift start time (HH:MM).' });
            return;
          }
          if (cleanedCustom.length < 2) {
            res.status(400).json({
              error: 'Please enter the reason for forgetting to mark Shift Start.',
            });
            return;
          }

          const [y, m, d] = dateKey.split('-').map(Number);
          const [hh, mm] = manualTime.split(':').map(Number);
          const offsetMin =
            typeof timezoneOffsetMinutes === 'number' && Number.isFinite(timezoneOffsetMinutes)
              ? timezoneOffsetMinutes
              : new Date().getTimezoneOffset();
          const backMs = Date.UTC(y, m - 1, d, hh, mm, 0) + offsetMin * 60_000;

          if (backMs > nowMs + 60_000) {
            res.status(400).json({
              error: 'Entered shift start time cannot be in the future.',
            });
            return;
          }

          punchIso = new Date(backMs).toISOString();
          resolvedReason = 'Forgot Shift Start';
          resolvedCustom = cleanedCustom;
        } else {
          resolvedReason = 'Shift Start';
          resolvedCustom = null;
        }
      } else {
        // Subsequent Mark IN: automatically detect against last Mark OUT
        if (forgotShiftStart === true) {
          res.status(400).json({
            error: 'Shift start has already been marked for today.',
          });
          return;
        }
        if (openBreak) {
          resolvedReason = String(openBreak.reason_category);
          resolvedCustom = openBreak.custom_reason ? String(openBreak.custom_reason) : null;
        } else if (lastOutToday) {
          const lastOutReason = String(lastOutToday.reason_category);
          resolvedReason = lastOutReason === 'Shift End' ? 'Shift Resume' : lastOutReason;
          resolvedCustom = lastOutToday.custom_reason ? String(lastOutToday.custom_reason) : null;
        } else {
          resolvedReason = 'Shift Resume';
          resolvedCustom = null;
        }
      }
    } else {
      // direction === 'OUT'
      const existingInToday = db
        .prepare(
          `SELECT id FROM attendance_logs
           WHERE branch_id = ? AND employee_id = ? AND date_key = ? AND direction = 'IN'
           LIMIT 1`
        )
        .get(branchId, employeeId, dateKey);
      if (!existingInToday) {
        res.status(400).json({
          error:
            'Please enter your arrival time in the Forgot Shift Start option first (or mark IN for Shift Start) before marking Out.',
        });
        return;
      }

      if (!OUT_REASONS.includes(reasonCategory)) {
        res.status(400).json({ error: 'Please select a valid Mark OUT reason.' });
        return;
      }
      if (reasonCategory === 'Other' && cleanedCustom.length < 2) {
        res.status(400).json({
          error: 'Please enter a manual reason when selecting Other.',
        });
        return;
      }
      resolvedReason = reasonCategory;
      resolvedCustom = reasonCategory === 'Other' ? cleanedCustom : cleanedCustom || null;

      if (resolvedReason !== 'Shift End') {
        const policy = resolveEffectiveBreakPolicy(getAlertRules(branchId), localTime);
        if (policy.maxConcurrentBreaks !== null) {
          const activeRow = db
            .prepare(
              `SELECT COUNT(DISTINCT b.employee_id) as cnt
               FROM break_sessions b
               JOIN employees e ON e.id = b.employee_id
               WHERE b.branch_id = ? AND b.status = 'in_progress' AND e.active = 1 AND b.employee_id != ?`
            )
            .get(branchId, employeeId) as { cnt: number };
          const currentlyOut = Number(activeRow?.cnt ?? 0);
          if (currentlyOut >= policy.maxConcurrentBreaks) {
            if (policy.activeMode === 'peak' && policy.activePeakRule) {
              const pr = policy.activePeakRule;
              const message =
                policy.maxConcurrentBreaks === 0
                  ? `Peak hours (${pr.label}: ${pr.startTime}–${pr.endTime}): breaks are paused right now (0 allowed). Please wait until peak hours end.`
                  : `Peak hours threshold reached (${pr.label}: ${pr.startTime}–${pr.endTime}): ${currentlyOut} of ${policy.maxConcurrentBreaks} staff ${
                      currentlyOut === 1 ? 'is' : 'are'
                    } already outside or on break. Please wait for your turn.`;
              res.status(409).json({ error: message });
              return;
            }
            res.status(409).json({
              error: `Break limit reached: ${currentlyOut} of ${policy.maxConcurrentBreaks} staff ${
                currentlyOut === 1 ? 'is' : 'are'
              } already outside or on break. Please wait for your turn.`,
            });
            return;
          }
        }
      }
    }

    const logId = crypto.randomUUID();

    db.exec('BEGIN');
    try {
      db.prepare(
        `INSERT INTO attendance_logs
         (id, branch_id, employee_id, direction, reason_category, custom_reason, timestamp, date_key, month_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        logId,
        branchId,
        employeeId,
        direction,
        resolvedReason,
        resolvedCustom,
        punchIso,
        dateKey,
        monthKey
      );

      // Check for any open break session for this employee
      const openBreak = db
        .prepare(
          `SELECT * FROM break_sessions
           WHERE branch_id = ? AND employee_id = ? AND status = 'in_progress'
           ORDER BY out_time DESC LIMIT 1`
        )
        .get(branchId, employeeId) as Record<string, unknown> | undefined;

      if (direction === 'IN') {
        if (openBreak) {
          const outMs = new Date(String(openBreak.out_time)).getTime();
          const durationSec = Math.max(1, Math.round((nowMs - outMs) / 1000));
          db.prepare(
            `UPDATE break_sessions
             SET in_time = ?, duration_seconds = ?, status = 'completed'
             WHERE id = ?`
          ).run(punchIso, durationSec, String(openBreak.id));
        }
      } else {
        // direction === 'OUT'
        if (openBreak) {
          const outMs = new Date(String(openBreak.out_time)).getTime();
          const durationSec = Math.max(1, Math.round((nowMs - outMs) / 1000));
          db.prepare(
            `UPDATE break_sessions
             SET in_time = ?, duration_seconds = ?, status = 'completed'
             WHERE id = ?`
          ).run(punchIso, durationSec, String(openBreak.id));
        }

        if (resolvedReason !== 'Shift End') {
          db.prepare(
            `INSERT INTO break_sessions
             (id, branch_id, employee_id, reason_category, custom_reason, out_time, in_time, duration_seconds, status, date_key, month_key)
             VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'in_progress', ?, ?)`
          ).run(
            crypto.randomUUID(),
            branchId,
            employeeId,
            resolvedReason,
            resolvedCustom,
            punchIso,
            dateKey,
            monthKey
          );
        }
      }

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      console.error('Punch error:', err);
      res.status(500).json({ error: 'Failed to record attendance mark.' });
      return;
    }

    const staff = computeStaffStatesForDate(dateKey, branchId, false);
    const updatedMember = staff.find((s) => s.employee.id === employeeId) ?? null;

    activeBranchDates.set(branchId, dateKey);
    evaluateRealtimeAlerts(dateKey, branchId);
    broadcastToManagers(branchId, 'dashboard:updated', {
      dateKey,
      employeeId,
      direction,
      reasonCategory: resolvedReason,
    });
    broadcastToStaffTerminals(branchId, 'staff:updated', { dateKey });

    res.status(201).json({
      success: true,
      dateKey,
      resolvedReason,
      resolvedCustom,
      timestamp: punchIso,
      member: updatedMember,
      staff,
    });
  });

  // 2b. Close Unclosed Previous-Day Shift (Required before starting next day's shift)
  app.post('/api/staff/close-previous-shift', (req: Request, res: Response) => {
    const branchId = resolveBranchId(req, res);
    if (!branchId) return;

    const {
      employeeId,
      secretCode,
      previousDateKey,
      endTime,
      reason,
      timezoneOffsetMinutes,
      dateKey: rawDateKey,
    } = req.body ?? {};
    const dateKey = normalizeDateKey(rawDateKey);

    if (typeof employeeId !== 'string' || !employeeId.trim()) {
      res.status(400).json({ error: 'Please select a staff member.' });
      return;
    }

    const cleanedSecret = typeof secretCode === 'string' ? secretCode.trim() : '';
    if (!/^\d{1,4}$/.test(cleanedSecret)) {
      res.status(400).json({ error: 'Please enter your secret code (up to 4 digits).' });
      return;
    }

    const empRow = db
      .prepare('SELECT * FROM employees WHERE id = ? AND branch_id = ? AND active = 1')
      .get(employeeId, branchId) as Record<string, unknown> | undefined;

    if (!empRow) {
      res.status(404).json({ error: 'Employee not found or inactive.' });
      return;
    }

    const storedSecret = empRow.secret_code ? String(empRow.secret_code) : '';
    if (!storedSecret || cleanedSecret !== storedSecret) {
      res.status(403).json({
        error: `Incorrect secret code for ${String(empRow.name)}. Please verify and try again.`,
      });
      return;
    }

    const unclosed = getUnclosedPreviousShift(employeeId, dateKey, branchId);
    if (!unclosed) {
      res.status(400).json({ error: 'No unclosed previous-day shift found for this staff member.' });
      return;
    }

    const targetDateKey =
      typeof previousDateKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(previousDateKey)
        ? previousDateKey
        : unclosed.dateKey;

    if (targetDateKey !== unclosed.dateKey) {
      res.status(400).json({
        error: `Please close your most recent unclosed shift from ${unclosed.dateKey}.`,
      });
      return;
    }

    if (typeof endTime !== 'string' || !/^\d{2}:\d{2}$/.test(endTime)) {
      res.status(400).json({ error: 'Please enter a valid shift end time (HH:MM) for the last day.' });
      return;
    }

    const cleanedReason = typeof reason === 'string' ? reason.trim() : '';
    if (cleanedReason.length < 2) {
      res.status(400).json({
        error: 'Please enter the reason for not ending your shift on the last day.',
      });
      return;
    }
    if (cleanedReason.length > 200) {
      res.status(400).json({ error: 'Reason must be 200 characters or less.' });
      return;
    }

    const [y, m, d] = targetDateKey.split('-').map(Number);
    const [hh, mm] = endTime.split(':').map(Number);
    const offsetMin =
      typeof timezoneOffsetMinutes === 'number' && Number.isFinite(timezoneOffsetMinutes)
        ? timezoneOffsetMinutes
        : new Date().getTimezoneOffset();
    const shiftEndMs = Date.UTC(y, m - 1, d, hh, mm, 0) + offsetMin * 60_000;
    const lastLogMs = new Date(unclosed.lastLogTime).getTime();

    if (shiftEndMs < lastLogMs) {
      res.status(400).json({
        error: `Shift end time on ${targetDateKey} cannot be earlier than your last recorded mark on that day.`,
      });
      return;
    }
    if (shiftEndMs > Date.now() + 60_000) {
      res.status(400).json({ error: 'Shift end time cannot be in the future.' });
      return;
    }

    const shiftEndIso = new Date(shiftEndMs).toISOString();
    const prevMonthKey = targetDateKey.slice(0, 7);

    db.exec('BEGIN');
    try {
      const openBreaks = db
        .prepare(
          `SELECT * FROM break_sessions
           WHERE branch_id = ? AND employee_id = ? AND status = 'in_progress' AND date_key <= ?`
        )
        .all(branchId, employeeId, targetDateKey) as Record<string, unknown>[];

      for (const ob of openBreaks) {
        const outMs = new Date(String(ob.out_time)).getTime();
        const durationSec = Math.max(1, Math.round((shiftEndMs - outMs) / 1000));
        db.prepare(
          `UPDATE break_sessions
           SET in_time = ?, duration_seconds = ?, status = 'completed'
           WHERE id = ?`
        ).run(shiftEndIso, durationSec, String(ob.id));
      }

      db.prepare(
        `INSERT INTO attendance_logs
         (id, branch_id, employee_id, direction, reason_category, custom_reason, timestamp, date_key, month_key)
         VALUES (?, ?, ?, 'OUT', 'Shift End', ?, ?, ?, ?)`
      ).run(
        crypto.randomUUID(),
        branchId,
        employeeId,
        cleanedReason,
        shiftEndIso,
        targetDateKey,
        prevMonthKey
      );

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      console.error('Close previous shift error:', err);
      res.status(500).json({ error: 'Failed to close previous shift.' });
      return;
    }

    const staff = computeStaffStatesForDate(dateKey, branchId, false);
    const updatedMember = staff.find((s) => s.employee.id === employeeId) ?? null;

    broadcastToManagers(branchId, 'dashboard:updated', { dateKey, employeeId });
    broadcastToStaffTerminals(branchId, 'staff:updated', { dateKey });

    res.status(201).json({
      success: true,
      previousDateKey: targetDateKey,
      timestamp: shiftEndIso,
      member: updatedMember,
      staff,
    });
  });

  // 3. Manager Session & Authentication
  app.get('/api/manager/session', (req: Request, res: Response) => {
    const branchId = resolveBranchId(req, res);
    if (!branchId) return;

    initializeManagerPassword(branchId);
    const token = getTokenFromRequest(req);
    const sessionBranchId = getSessionBranchId(token);
    const authenticated = sessionBranchId !== null && sessionBranchId === branchId;
    res.json({
      authenticated,
      isDefaultPassword: isDefaultPasswordActive(branchId),
    });
  });

  app.post('/api/manager/login', (req: Request, res: Response) => {
    const branchId = resolveBranchId(req, res);
    if (!branchId) return;

    initializeManagerPassword(branchId);
    const { password } = req.body ?? {};
    if (typeof password !== 'string' || !password) {
      res.status(400).json({ error: 'Password is required.' });
      return;
    }

    const storedHash = getBranchSetting(branchId, 'manager_password_hash');
    if (!storedHash || !verifyPassword(password, storedHash)) {
      res.status(401).json({ error: 'Incorrect manager password.' });
      return;
    }

    const token = crypto.randomBytes(32).toString('hex');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    db.prepare(
      'INSERT INTO manager_sessions (token, branch_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
    ).run(token, branchId, now.toISOString(), expiresAt.toISOString());

    res.json({
      token,
      expiresAt: expiresAt.toISOString(),
      isDefaultPassword: isDefaultPasswordActive(branchId),
    });
  });

  app.post('/api/manager/logout', (req: Request, res: Response) => {
    const token = getTokenFromRequest(req);
    if (token) {
      db.prepare('DELETE FROM manager_sessions WHERE token = ?').run(token);
    }
    res.json({ success: true });
  });

  app.post('/api/manager/change-password', requireManagerAuth, (req: BranchRequest, res: Response) => {
    const branchId = req.managerBranchId!;
    const { currentPassword, newPassword, isInitialSetup } = req.body ?? {};
    if (typeof newPassword !== 'string') {
      res.status(400).json({ error: 'New password is required.' });
      return;
    }
    if (newPassword.trim().length < 4) {
      res.status(400).json({ error: 'New password must be at least 4 characters.' });
      return;
    }

    const skipCurrentCheck = isInitialSetup === true && isDefaultPasswordActive(branchId);
    if (!skipCurrentCheck) {
      if (typeof currentPassword !== 'string') {
        res.status(400).json({ error: 'Current password is required.' });
        return;
      }
      const storedHash = getBranchSetting(branchId, 'manager_password_hash');
      if (!storedHash || !verifyPassword(currentPassword, storedHash)) {
        res.status(401).json({ error: 'Current password is incorrect.' });
        return;
      }
    }

    const newHash = hashPassword(newPassword.trim());
    setBranchSetting(branchId, 'manager_password_hash', newHash);
    setBranchSetting(branchId, 'is_default_password', '0');

    db.prepare(
      `UPDATE manager_notifications
       SET read_at = COALESCE(read_at, ?), dismissed = 1
       WHERE branch_id = ? AND event_type = 'setup_password'`
    ).run(new Date().toISOString(), branchId);

    broadcastToManagers(branchId, 'notifications:synced', { action: 'setup_password_done' });
    res.json({ success: true });
  });

  // 4. Manager Dashboard — Today Heading
  app.get('/api/manager/dashboard/today', requireManagerAuth, (req: BranchRequest, res: Response) => {
    const branchId = req.managerBranchId!;
    const dateKey = normalizeDateKey(req.query.date);
    ensureSeeded(dateKey, branchId);

    const activeStaffStates = computeStaffStatesForDate(dateKey, branchId, false, true);
    const activeEmployees = activeStaffStates.map((s) => s.employee);

    const inProcessRows = db
      .prepare(
        `SELECT b.*, e.name as employee_name, e.code as employee_code, e.role as employee_role
         FROM break_sessions b
         JOIN employees e ON e.id = b.employee_id
         WHERE b.branch_id = ? AND b.status = 'in_progress'
         ORDER BY b.out_time ASC`
      )
      .all(branchId);

    const doneRows = db
      .prepare(
        `SELECT b.*, e.name as employee_name, e.code as employee_code, e.role as employee_role
         FROM break_sessions b
         JOIN employees e ON e.id = b.employee_id
         WHERE b.branch_id = ? AND b.date_key = ? AND b.status = 'completed'
         ORDER BY b.in_time DESC`
      )
      .all(branchId, dateKey);

    const todayBreakRows = db
      .prepare(
        `SELECT b.*, e.name as employee_name, e.code as employee_code, e.role as employee_role
         FROM break_sessions b
         JOIN employees e ON e.id = b.employee_id
         WHERE b.branch_id = ? AND (b.date_key = ? OR b.status = 'in_progress')
         ORDER BY b.out_time DESC`
      )
      .all(branchId, dateKey);

    const todayLogRows = db
      .prepare(
        `SELECT l.*, e.name as employee_name, e.code as employee_code, e.role as employee_role
         FROM attendance_logs l
         JOIN employees e ON e.id = l.employee_id
         WHERE l.branch_id = ? AND l.date_key = ?
         ORDER BY l.timestamp DESC`
      )
      .all(branchId, dateKey);

    const breaksInProcess = inProcessRows.map(mapBreak);
    const breaksDone = doneRows.map(mapBreak);
    const allTodayBreaks = todayBreakRows.map(mapBreak);
    const todayLogs = todayLogRows.map(mapLog);

    const employeeSummaries = buildEmployeeBreakSummaries(
      activeEmployees,
      allTodayBreaks,
      todayLogs,
      activeStaffStates
    );

    const activeStaffCount = activeStaffStates.filter((s) => s.status === 'in_branch').length;
    const offShiftCount = activeStaffStates.filter((s) => s.status === 'off_shift').length;

    const localTime = typeof req.query.localTime === 'string' ? req.query.localTime : undefined;
    const effectiveBreakPolicy = resolveEffectiveBreakPolicy(getAlertRules(branchId), localTime);

    res.json({
      dateKey,
      maxConcurrentBreaks: effectiveBreakPolicy.maxConcurrentBreaks,
      effectiveBreakPolicy,
      breaksInProcess,
      breaksDone,
      employeeSummaries,
      todayLogs,
      activeStaffCount,
      offShiftCount,
    });
  });

  // 5. Manager History — Date-wise or Month-wise
  app.get('/api/manager/history', requireManagerAuth, (req: BranchRequest, res: Response) => {
    const branchId = req.managerBranchId!;
    const fallbackDate = getServerLocalDateKey();
    ensureSeeded(fallbackDate, branchId);

    const mode = req.query.mode === 'month' ? 'month' : 'date';
    const dateFilter = normalizeDateKey(req.query.date);
    const monthFilter = normalizeMonthKey(req.query.month, dateFilter);
    const filterValue = mode === 'month' ? monthFilter : dateFilter;
    const employeeId = typeof req.query.employeeId === 'string' && req.query.employeeId.trim()
      ? req.query.employeeId.trim()
      : null;

    const allEmpRows = db
      .prepare('SELECT * FROM employees WHERE branch_id = ? ORDER BY code ASC')
      .all(branchId);
    const allEmployees = allEmpRows.map((r) => mapEmployee(r, true));

    const whereColumn = mode === 'month' ? 'month_key' : 'date_key';
    const params: string[] = [branchId, filterValue];
    let empClause = '';
    if (employeeId) {
      empClause = ' AND b.employee_id = ?';
      params.push(employeeId);
    }

    const breakRows = db
      .prepare(
        `SELECT b.*, e.name as employee_name, e.code as employee_code, e.role as employee_role
         FROM break_sessions b
         JOIN employees e ON e.id = b.employee_id
         WHERE b.branch_id = ? AND b.${whereColumn} = ?${empClause}
         ORDER BY b.out_time DESC`
      )
      .all(...params);

    const logParams: string[] = [branchId, filterValue];
    let logEmpClause = '';
    if (employeeId) {
      logEmpClause = ' AND l.employee_id = ?';
      logParams.push(employeeId);
    }

    const logRows = db
      .prepare(
        `SELECT l.*, e.name as employee_name, e.code as employee_code, e.role as employee_role
         FROM attendance_logs l
         JOIN employees e ON e.id = l.employee_id
         WHERE l.branch_id = ? AND l.${whereColumn} = ?${logEmpClause}
         ORDER BY l.timestamp DESC`
      )
      .all(...logParams);

    const breaks = breakRows.map(mapBreak);
    const logs = logRows.map(mapLog);

    const targetEmployees = employeeId
      ? allEmployees.filter((e) => e.id === employeeId)
      : allEmployees;

    const employeeSummaries = buildEmployeeBreakSummaries(targetEmployees, breaks, logs);

    const dateListRows = db
      .prepare(
        `SELECT DISTINCT date_key FROM (
           SELECT date_key FROM attendance_logs WHERE branch_id = ?
           UNION
           SELECT date_key FROM break_sessions WHERE branch_id = ?
         ) ORDER BY date_key DESC`
      )
      .all(branchId, branchId);
    const monthListRows = db
      .prepare(
        `SELECT DISTINCT month_key FROM (
           SELECT month_key FROM attendance_logs WHERE branch_id = ?
           UNION
           SELECT month_key FROM break_sessions WHERE branch_id = ?
         ) ORDER BY month_key DESC`
      )
      .all(branchId, branchId);

    res.json({
      mode,
      filterValue,
      employeeSummaries,
      breaks,
      logs,
      availableDates: dateListRows.map((r) => String(r.date_key)),
      availableMonths: monthListRows.map((r) => String(r.month_key)),
      employees: allEmployees,
    });
  });

  // 6. Manager Staff Roster Management
  app.post('/api/manager/employees', requireManagerAuth, (req: BranchRequest, res: Response) => {
    const branchId = req.managerBranchId!;
    const { name, role, code } = req.body ?? {};
    if (typeof name !== 'string' || name.trim().length < 2) {
      res.status(400).json({ error: 'Employee name must be at least 2 characters.' });
      return;
    }
    if (typeof role !== 'string' || role.trim().length < 2) {
      res.status(400).json({ error: 'Employee role is required.' });
      return;
    }

    const cleanName = name.trim().slice(0, 80);
    const cleanRole = role.trim().slice(0, 60);
    const cleanCode =
      typeof code === 'string' && code.trim().length >= 2
        ? code.trim().toUpperCase().slice(0, 20)
        : `BR-${Math.floor(200 + Math.random() * 799)}`;

    const existingCode = db
      .prepare('SELECT id FROM employees WHERE branch_id = ? AND code = ?')
      .get(branchId, cleanCode);
    if (existingCode) {
      res.status(409).json({ error: `Employee code ${cleanCode} already exists.` });
      return;
    }

    const id = `emp-${crypto.randomUUID().slice(0, 8)}`;
    const nowIso = new Date().toISOString();
    const secretCode = generateUniqueSecretCode(branchId);
    db.prepare(
      'INSERT INTO employees (id, branch_id, code, name, role, active, created_at, secret_code) VALUES (?, ?, ?, ?, ?, 1, ?, ?)'
    ).run(id, branchId, cleanCode, cleanName, cleanRole, nowIso, secretCode);

    db.prepare(
      `UPDATE manager_notifications
       SET read_at = COALESCE(read_at, ?), dismissed = 1
       WHERE branch_id = ? AND event_type = 'setup_staff'`
    ).run(nowIso, branchId);

    const dateKey = activeBranchDates.get(branchId) ?? getServerLocalDateKey();
    broadcastToManagers(branchId, 'notifications:synced', { action: 'setup_staff_done' });
    broadcastToManagers(branchId, 'dashboard:updated', { dateKey });
    broadcastToStaffTerminals(branchId, 'staff:updated', { dateKey });

    res.status(201).json({
      employee: {
        id,
        code: cleanCode,
        name: cleanName,
        role: cleanRole,
        active: true,
        createdAt: nowIso,
        secretCode,
      },
    });
  });

  app.post('/api/manager/employees/:id/regenerate-code', requireManagerAuth, (req: BranchRequest, res: Response) => {
    const branchId = req.managerBranchId!;
    const { id } = req.params;
    const empRow = db
      .prepare('SELECT * FROM employees WHERE id = ? AND branch_id = ?')
      .get(id, branchId) as Record<string, unknown> | undefined;
    if (!empRow) {
      res.status(404).json({ error: 'Employee not found.' });
      return;
    }

    const newSecret = generateUniqueSecretCode(branchId);
    db.prepare('UPDATE employees SET secret_code = ? WHERE id = ? AND branch_id = ?').run(
      newSecret,
      id,
      branchId
    );
    const updated = mapEmployee({ ...empRow, secret_code: newSecret }, true);
    res.json({ employee: updated });
  });

  app.delete('/api/manager/employees/:id', requireManagerAuth, (req: BranchRequest, res: Response) => {
    const branchId = req.managerBranchId!;
    const { id } = req.params;
    const result = db
      .prepare('UPDATE employees SET active = 0 WHERE id = ? AND branch_id = ?')
      .run(id, branchId);
    if (Number(result.changes) === 0) {
      res.status(404).json({ error: 'Employee not found.' });
      return;
    }
    const dateKey = activeBranchDates.get(branchId) ?? getServerLocalDateKey();
    broadcastToManagers(branchId, 'dashboard:updated', { dateKey });
    broadcastToStaffTerminals(branchId, 'staff:updated', { dateKey });
    res.json({ success: true });
  });

  // 7. Employee Performance Analytics (weekly, monthly, yearly + individual employee filter)
  app.get('/api/manager/analytics', requireManagerAuth, (req: BranchRequest, res: Response) => {
    const branchId = req.managerBranchId!;
    const endDateKey = normalizeDateKey(req.query.date);
    ensureSeeded(endDateKey, branchId);

    const rawRange = req.query.range;
    const range: AnalyticsRange =
      rawRange === 'yearly' ? 'yearly' : rawRange === 'monthly' ? 'monthly' : 'weekly';

    const employeeId =
      typeof req.query.employeeId === 'string' && req.query.employeeId.trim()
        ? req.query.employeeId.trim()
        : null;

    const allEmpRows = db
      .prepare('SELECT * FROM employees WHERE branch_id = ? ORDER BY code ASC')
      .all(branchId);
    const allEmployees = allEmpRows.map((r) => mapEmployee(r, false));

    let startDateKey = endDateKey;
    let bucketKeys: string[] = [];

    if (range === 'weekly') {
      startDateKey = shiftDateKey(endDateKey, -6);
      for (let i = 6; i >= 0; i -= 1) {
        bucketKeys.push(shiftDateKey(endDateKey, -i));
      }
    } else if (range === 'monthly') {
      startDateKey = shiftDateKey(endDateKey, -29);
      for (let i = 29; i >= 0; i -= 1) {
        bucketKeys.push(shiftDateKey(endDateKey, -i));
      }
    } else {
      const endMonth = endDateKey.slice(0, 7);
      const months = getMonthRangeKeys(endMonth, 12);
      startDateKey = `${months[0]}-01`;
      bucketKeys = months;
    }

    const breakRows = db
      .prepare(
        `SELECT b.*, e.name as employee_name, e.code as employee_code, e.role as employee_role
         FROM break_sessions b
         JOIN employees e ON e.id = b.employee_id
         WHERE b.branch_id = ? AND b.date_key >= ? AND b.date_key <= ?
         ORDER BY b.out_time ASC`
      )
      .all(branchId, startDateKey, endDateKey);

    const logRows = db
      .prepare(
        `SELECT l.*, e.name as employee_name, e.code as employee_code, e.role as employee_role
         FROM attendance_logs l
         JOIN employees e ON e.id = l.employee_id
         WHERE l.branch_id = ? AND l.date_key >= ? AND l.date_key <= ?
         ORDER BY l.timestamp ASC`
      )
      .all(branchId, startDateKey, endDateKey);

    const allBreaksInRange = breakRows.map(mapBreak);
    const allLogsInRange = logRows.map(mapLog);

    const rules = getAlertRules(branchId);
    const nowMs = Date.now();

    const getBreakDurationMinutes = (br: BreakSession): number => {
      if (br.status === 'completed' && br.durationSeconds !== null) {
        return br.durationSeconds / 60;
      }
      const elapsedSec = Math.max(0, (nowMs - new Date(br.outTime).getTime()) / 1000);
      return elapsedSec / 60;
    };

    const getLocalHHMMFromIso = (iso: string): string => {
      const dt = new Date(iso);
      return `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
    };

    const employeeMetrics: EmployeeAnalyticsMetric[] = allEmployees.map((emp) => {
      const empBreaks = allBreaksInRange.filter((b) => b.employeeId === emp.id);
      const empLogs = allLogsInRange.filter((l) => l.employeeId === emp.id);

      const totalBreakMinutes = empBreaks.reduce((acc, b) => acc + getBreakDurationMinutes(b), 0);
      const completedBreaks = empBreaks.filter((b) => b.status === 'completed').length;
      const avgBreakMinutes = empBreaks.length > 0 ? totalBreakMinutes / empBreaks.length : 0;

      const shiftStartByDay = new Map<string, string>();
      for (const lg of empLogs) {
        if (lg.direction === 'IN' && !shiftStartByDay.has(lg.dateKey)) {
          shiftStartByDay.set(lg.dateKey, lg.timestamp);
        }
      }

      let onTimeClockIns = 0;
      let lateClockIns = 0;
      for (const ts of shiftStartByDay.values()) {
        const hhmm = getLocalHHMMFromIso(ts);
        if (hhmm <= rules.clockInCutoffTime) {
          onTimeClockIns += 1;
        } else {
          lateClockIns += 1;
        }
      }

      const categoryCounts: Record<string, number> = {
        'Launch Break': 0,
        'Namaz Break': 0,
        'Rest Room Break': 0,
        Other: 0,
      };
      for (const br of empBreaks) {
        categoryCounts[br.reasonCategory] = (categoryCounts[br.reasonCategory] ?? 0) + 1;
      }

      return {
        employeeId: emp.id,
        employeeCode: emp.code,
        employeeName: emp.name,
        employeeRole: emp.role,
        totalBreaks: empBreaks.length,
        completedBreaks,
        totalBreakMinutes: Math.round(totalBreakMinutes * 10) / 10,
        avgBreakMinutes: Math.round(avgBreakMinutes * 10) / 10,
        daysClockedIn: shiftStartByDay.size,
        onTimeClockIns,
        lateClockIns,
        categoryCounts,
      };
    });

    const filteredBreaks = employeeId
      ? allBreaksInRange.filter((b) => b.employeeId === employeeId)
      : allBreaksInRange;

    const bucketAcc = new Map<string, { totalMinutes: number; breakCount: number }>();
    for (const bk of bucketKeys) {
      bucketAcc.set(bk, { totalMinutes: 0, breakCount: 0 });
    }

    for (const br of filteredBreaks) {
      const bKey = range === 'yearly' ? br.monthKey : br.dateKey;
      const entry = bucketAcc.get(bKey);
      if (entry) {
        entry.totalMinutes += getBreakDurationMinutes(br);
        entry.breakCount += 1;
      }
    }

    const trendSeries: AnalyticsTrendPoint[] = bucketKeys.map((bk) => {
      const entry = bucketAcc.get(bk) ?? { totalMinutes: 0, breakCount: 0 };
      const totalMins = Math.round(entry.totalMinutes * 10) / 10;
      const avgMins =
        entry.breakCount > 0 ? Math.round((entry.totalMinutes / entry.breakCount) * 10) / 10 : 0;
      return {
        bucketKey: bk,
        label: range === 'yearly' ? formatMonthBucketLabel(bk) : formatDateBucketLabel(bk),
        totalMinutes: totalMins,
        breakCount: entry.breakCount,
        avgMinutes: avgMins,
      };
    });

    const targetMetrics = employeeId
      ? employeeMetrics.filter((m) => m.employeeId === employeeId)
      : employeeMetrics;

    const totalBreaks = targetMetrics.reduce((s, m) => s + m.totalBreaks, 0);
    const totalBreakMinutes = Math.round(
      targetMetrics.reduce((s, m) => s + m.totalBreakMinutes, 0) * 10
    ) / 10;
    const avgBreakMinutes =
      totalBreaks > 0 ? Math.round((totalBreakMinutes / totalBreaks) * 10) / 10 : 0;

    const teamTotalBreaks = employeeMetrics.reduce((s, m) => s + m.totalBreaks, 0);
    const teamTotalMinutes = employeeMetrics.reduce((s, m) => s + m.totalBreakMinutes, 0);
    const teamAvgBreakMinutes =
      teamTotalBreaks > 0 ? Math.round((teamTotalMinutes / teamTotalBreaks) * 10) / 10 : 0;

    const totalShiftDays = targetMetrics.reduce((s, m) => s + m.daysClockedIn, 0);
    const totalOnTime = targetMetrics.reduce((s, m) => s + m.onTimeClockIns, 0);
    const onTimeRatePercent =
      totalShiftDays > 0 ? Math.round((totalOnTime / totalShiftDays) * 100) : 100;

    res.json({
      range,
      startDateKey,
      endDateKey,
      employeeId,
      employees: allEmployees,
      kpis: {
        totalBreaks,
        totalBreakMinutes,
        avgBreakMinutes,
        teamAvgBreakMinutes,
        onTimeRatePercent,
        totalShiftDays,
      },
      trendSeries,
      employeeMetrics,
    });
  });

  // 8. Real-Time Manager Notifications & Alert Rules
  app.get('/api/manager/notifications', requireManagerAuth, (req: BranchRequest, res: Response) => {
    const branchId = req.managerBranchId!;
    const dateKey = normalizeDateKey(req.query.date);
    const localTime = typeof req.query.localTime === 'string' ? req.query.localTime : undefined;
    activeBranchDates.set(branchId, dateKey);
    ensureSeeded(dateKey, branchId);
    evaluateRealtimeAlerts(dateKey, branchId, localTime);

    const rows = db
      .prepare(
        `SELECT * FROM manager_notifications
         WHERE branch_id = ? AND dismissed = 0
         ORDER BY created_at DESC
         LIMIT 50`
      )
      .all(branchId);

    const notifications = rows.map(mapNotification);
    const unreadCount = notifications.filter((n) => n.readAt === null).length;

    res.json({
      notifications,
      unreadCount,
      rules: getAlertRules(branchId),
    });
  });

  app.post('/api/manager/notifications/read-all', requireManagerAuth, (req: BranchRequest, res: Response) => {
    const branchId = req.managerBranchId!;
    const nowIso = new Date().toISOString();
    db.prepare(
      'UPDATE manager_notifications SET read_at = ? WHERE branch_id = ? AND read_at IS NULL AND dismissed = 0'
    ).run(nowIso, branchId);
    broadcastToManagers(branchId, 'notifications:synced', { action: 'read_all' });
    res.json({ success: true });
  });

  app.post('/api/manager/notifications/:id/read', requireManagerAuth, (req: BranchRequest, res: Response) => {
    const branchId = req.managerBranchId!;
    const { id } = req.params;
    const nowIso = new Date().toISOString();
    db.prepare(
      'UPDATE manager_notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND branch_id = ?'
    ).run(nowIso, id, branchId);
    broadcastToManagers(branchId, 'notifications:synced', { action: 'read_one', id });
    res.json({ success: true });
  });

  app.delete('/api/manager/notifications/:id', requireManagerAuth, (req: BranchRequest, res: Response) => {
    const branchId = req.managerBranchId!;
    const { id } = req.params;
    db.prepare('UPDATE manager_notifications SET dismissed = 1 WHERE id = ? AND branch_id = ?').run(
      id,
      branchId
    );
    broadcastToManagers(branchId, 'notifications:synced', { action: 'dismiss', id });
    res.json({ success: true });
  });

  app.get('/api/manager/alert-rules', requireManagerAuth, (req: BranchRequest, res: Response) => {
    const branchId = req.managerBranchId!;
    res.json({ rules: getAlertRules(branchId) });
  });

  app.put('/api/manager/alert-rules', requireManagerAuth, (req: BranchRequest, res: Response) => {
    const branchId = req.managerBranchId!;
    const {
      lunchBreakLimitMinutes,
      otherBreakLimitMinutes,
      clockInCutoffTime,
      alertOnOtherBreak,
      maxConcurrentBreaks,
      peakBreakRules,
      dateKey: rawDateKey,
      localTime,
    } = req.body ?? {};

    const current = getAlertRules(branchId);
    let nextMaxConcurrent = current.maxConcurrentBreaks;
    if (maxConcurrentBreaks !== undefined) {
      if (maxConcurrentBreaks === null || maxConcurrentBreaks === '' || maxConcurrentBreaks === 0) {
        nextMaxConcurrent = null;
      } else if (
        typeof maxConcurrentBreaks === 'number' &&
        Number.isFinite(maxConcurrentBreaks) &&
        maxConcurrentBreaks >= 1 &&
        maxConcurrentBreaks <= 100
      ) {
        nextMaxConcurrent = Math.round(maxConcurrentBreaks);
      }
    }

    const nextPeakRules =
      peakBreakRules !== undefined ? sanitizePeakBreakRules(peakBreakRules) : current.peakBreakRules;

    const updated: AlertRulesConfig = {
      lunchBreakLimitMinutes:
        typeof lunchBreakLimitMinutes === 'number' && lunchBreakLimitMinutes >= 1 && lunchBreakLimitMinutes <= 240
          ? Math.round(lunchBreakLimitMinutes)
          : current.lunchBreakLimitMinutes,
      otherBreakLimitMinutes:
        typeof otherBreakLimitMinutes === 'number' && otherBreakLimitMinutes >= 1 && otherBreakLimitMinutes <= 240
          ? Math.round(otherBreakLimitMinutes)
          : current.otherBreakLimitMinutes,
      clockInCutoffTime:
        typeof clockInCutoffTime === 'string' && /^\d{2}:\d{2}$/.test(clockInCutoffTime)
          ? clockInCutoffTime
          : current.clockInCutoffTime,
      alertOnOtherBreak:
        typeof alertOnOtherBreak === 'boolean' ? alertOnOtherBreak : current.alertOnOtherBreak,
      maxConcurrentBreaks: nextMaxConcurrent,
      peakBreakRules: nextPeakRules,
    };

    saveAlertRules(branchId, updated);
    const dateKey = normalizeDateKey(
      rawDateKey ?? activeBranchDates.get(branchId) ?? getServerLocalDateKey()
    );
    evaluateRealtimeAlerts(dateKey, branchId, typeof localTime === 'string' ? localTime : undefined);
    broadcastToManagers(branchId, 'notifications:synced', { action: 'rules_updated' });
    broadcastToManagers(branchId, 'dashboard:updated', { dateKey });
    broadcastToStaffTerminals(branchId, 'staff:updated', { dateKey });

    res.json({ rules: updated });
  });

  // Vite middleware in development, static assets in production
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const httpServer = http.createServer(app);
  const wssManager = new WebSocketServer({ noServer: true });
  const wssStaff = new WebSocketServer({ noServer: true });

  wssManager.on('connection', (ws: WebSocket, _req: http.IncomingMessage, branchId: string) => {
    const client: BranchSocketClient = { ws, branchId };
    connectedManagers.add(client);
    ws.send(JSON.stringify({ event: 'ws:connected', payload: { ok: true, branchId } }));

    ws.on('close', () => {
      connectedManagers.delete(client);
    });
    ws.on('error', () => {
      connectedManagers.delete(client);
    });
  });

  wssStaff.on('connection', (ws: WebSocket, _req: http.IncomingMessage, branchId: string) => {
    const client: BranchSocketClient = { ws, branchId };
    connectedStaffTerminals.add(client);
    ws.send(JSON.stringify({ event: 'ws:connected', payload: { ok: true, branchId } }));

    ws.on('close', () => {
      connectedStaffTerminals.delete(client);
    });
    ws.on('error', () => {
      connectedStaffTerminals.delete(client);
    });
  });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname === '/ws/staff') {
      const requestedBranch = url.searchParams.get('branchId')?.trim() || DEFAULT_BRANCH_ID;
      wssStaff.handleUpgrade(req, socket, head, (ws) => {
        wssStaff.emit('connection', ws, req, requestedBranch);
      });
      return;
    }

    if (url.pathname !== '/ws/manager') {
      return;
    }

    const token = url.searchParams.get('token');
    const sessionBranchId = getSessionBranchId(token);
    if (!sessionBranchId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wssManager.handleUpgrade(req, socket, head, (ws) => {
      wssManager.emit('connection', ws, req, sessionBranchId);
    });
  });

  // Background real-time alert evaluator (checks break duration overages & missed clock-ins every 15s)
  setInterval(() => {
    try {
      for (const [bId, dKey] of activeBranchDates.entries()) {
        evaluateRealtimeAlerts(dKey, bId);
      }
    } catch (err) {
      console.error('Background alert evaluation error:', err);
    }
  }, 15_000);

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`BranchLedger server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
