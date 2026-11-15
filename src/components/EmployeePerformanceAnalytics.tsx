import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { fetchManagerAnalytics } from '../api';
import type {
  AnalyticsRange,
  AnalyticsTrendPoint,
  EmployeeAnalyticsMetric,
  ManagerAnalyticsResponse,
} from '../types';
import { getLocalDateKey } from '../utils/format';

interface EmployeePerformanceAnalyticsProps {
  refreshSignal: number;
  onAuthError: () => void;
}

const REASON_COLORS: Record<string, string> = {
  'Launch Break': '#0f766e',
  'Namaz Break': '#1e293b',
  'Rest Room Break': '#0284c7',
  Other: '#d97706',
};

const REASON_KEYS = ['Launch Break', 'Namaz Break', 'Rest Room Break', 'Other'] as const;

export function EmployeePerformanceAnalytics({
  refreshSignal,
  onAuthError,
}: EmployeePerformanceAnalyticsProps) {
  const [range, setRange] = useState<AnalyticsRange>('weekly');
  const [employeeId, setEmployeeId] = useState<string>('');
  const [data, setData] = useState<ManagerAnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [hoveredTrendIdx, setHoveredTrendIdx] = useState<number | null>(null);
  const [hoveredEmpAvgId, setHoveredEmpAvgId] = useState<string | null>(null);
  const [hoveredEmpFreqId, setHoveredEmpFreqId] = useState<string | null>(null);

  const loadAnalytics = useCallback(async () => {
    try {
      setError(null);
      const res = await fetchManagerAnalytics({
        range,
        date: getLocalDateKey(),
        employeeId: employeeId || undefined,
      });
      setData(res);
    } catch (err) {
      if (
        typeof err === 'object' &&
        err !== null &&
        'status' in err &&
        (err as { status?: number }).status === 401
      ) {
        onAuthError();
        return;
      }
      setError(err instanceof Error ? err.message : 'Unable to load performance analytics.');
    } finally {
      setLoading(false);
    }
  }, [range, employeeId, onAuthError]);

  useEffect(() => {
    setLoading(true);
    loadAnalytics();
  }, [loadAnalytics]);

  useEffect(() => {
    if (refreshSignal > 0) {
      loadAnalytics();
    }
  }, [refreshSignal, loadAnalytics]);

  const trendSeries = data?.trendSeries ?? [];
  const employeeMetrics = data?.employeeMetrics ?? [];

  const maxTrendMinutes = useMemo(() => {
    const maxVal = Math.max(10, ...trendSeries.map((p) => p.totalMinutes));
    return Math.ceil(maxVal / 10) * 10;
  }, [trendSeries]);

  const maxAvgMinutes = useMemo(() => {
    const maxVal = Math.max(
      15,
      data?.kpis.teamAvgBreakMinutes ?? 0,
      ...employeeMetrics.map((m) => m.avgBreakMinutes)
    );
    return Math.ceil(maxVal / 10) * 10;
  }, [employeeMetrics, data?.kpis.teamAvgBreakMinutes]);

  const maxBreakFreq = useMemo(() => {
    const maxVal = Math.max(4, ...employeeMetrics.map((m) => m.totalBreaks));
    return maxVal;
  }, [employeeMetrics]);

  // SVG Geometry for Break Time Trends chart
  const chartW = 760;
  const chartH = 220;
  const padL = 44;
  const padR = 16;
  const padT = 18;
  const padB = 34;
  const plotW = chartW - padL - padR;
  const plotH = chartH - padT - padB;

  const trendPoints = useMemo(() => {
    if (trendSeries.length === 0) return [];
    const denom = Math.max(1, trendSeries.length - 1);
    return trendSeries.map((pt, idx) => {
      const x = padL + (trendSeries.length === 1 ? plotW / 2 : (idx / denom) * plotW);
      const y = padT + plotH - (pt.totalMinutes / maxTrendMinutes) * plotH;
      return { ...pt, x, y, idx };
    });
  }, [trendSeries, maxTrendMinutes, plotW, plotH]);

  const linePath = useMemo(() => {
    if (trendPoints.length === 0) return '';
    return trendPoints
      .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
      .join(' ');
  }, [trendPoints]);

  const areaPath = useMemo(() => {
    if (trendPoints.length === 0) return '';
    const baseY = padT + plotH;
    const first = trendPoints[0];
    const last = trendPoints[trendPoints.length - 1];
    return `${linePath} L ${last.x.toFixed(1)} ${baseY} L ${first.x.toFixed(1)} ${baseY} Z`;
  }, [linePath, trendPoints, plotH]);

  const xLabelStep = trendPoints.length > 14 ? 5 : trendPoints.length > 8 ? 2 : 1;

  const hoveredTrendPoint: (AnalyticsTrendPoint & { x: number; y: number; idx: number }) | null =
    hoveredTrendIdx !== null && trendPoints[hoveredTrendIdx] ? trendPoints[hoveredTrendIdx] : null;

  const selectedEmployeeName = useMemo(() => {
    if (!employeeId || !data) return null;
    return data.employees.find((e) => e.id === employeeId)?.name ?? null;
  }, [employeeId, data]);

  const hoveredAvgEmp: EmployeeAnalyticsMetric | null = useMemo(
    () => employeeMetrics.find((m) => m.employeeId === hoveredEmpAvgId) ?? null,
    [employeeMetrics, hoveredEmpAvgId]
  );

  const hoveredFreqEmp: EmployeeAnalyticsMetric | null = useMemo(
    () => employeeMetrics.find((m) => m.employeeId === hoveredEmpFreqId) ?? null,
    [employeeMetrics, hoveredEmpFreqId]
  );

  return (
    <section
      aria-labelledby="analytics-heading"
      className="space-y-6 border-t border-slate-200 pt-8"
    >
      {/* Header + Filters */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 id="analytics-heading" className="text-xl font-semibold text-slate-900">
            Employee Performance Analytics
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Attendance punctuality, break duration averages, and team-wide break frequency trends
            {data ? ` · ${data.startDateKey} to ${data.endDateKey}` : ''}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Date Range Filter (Weekly / Monthly / Yearly) */}
          <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
            {(
              [
                { id: 'weekly', label: 'Weekly' },
                { id: 'monthly', label: 'Monthly' },
                { id: 'yearly', label: 'Yearly' },
              ] as { id: AnalyticsRange; label: string }[]
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setRange(opt.id)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  range === opt.id
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Individual Employee Filter */}
          <select
            aria-label="Filter analytics by employee"
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-800 focus:border-teal-700 focus:outline-none"
          >
            <option value="">All Employees (Team)</option>
            {(data?.employees ?? []).map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.name} ({emp.code})
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Key Metrics Strip */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
          <div className="text-xs font-medium text-slate-500">
            {selectedEmployeeName ? `${selectedEmployeeName} · Break Time` : 'Total Break Time'}
          </div>
          <div className="mt-2 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            {loading ? '—' : `${data?.kpis.totalBreakMinutes ?? 0}m`}
          </div>
          <div className="mt-1 text-xs text-slate-500 tabular-nums">
            Across {data?.kpis.totalBreaks ?? 0} recorded breaks
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
          <div className="text-xs font-medium text-slate-500">Average Break Duration</div>
          <div className="mt-2 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            {loading ? '—' : `${data?.kpis.avgBreakMinutes ?? 0}m`}
          </div>
          <div className="mt-1 text-xs text-slate-500 tabular-nums">
            Team avg: {data?.kpis.teamAvgBreakMinutes ?? 0}m per break
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
          <div className="text-xs font-medium text-slate-500">Break Frequency</div>
          <div className="mt-2 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            {loading ? '—' : data?.kpis.totalBreaks ?? 0}
          </div>
          <div className="mt-1 text-xs text-slate-500 tabular-nums">
            {data && data.kpis.totalShiftDays > 0
              ? `${(data.kpis.totalBreaks / data.kpis.totalShiftDays).toFixed(1)} breaks / shift-day`
              : 'No shifts in range'}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
          <div className="text-xs font-medium text-slate-500">On-Time Clock-In Rate</div>
          <div className="mt-2 font-mono text-2xl font-semibold text-teal-700 tabular-nums">
            {loading ? '—' : `${data?.kpis.onTimeRatePercent ?? 100}%`}
          </div>
          <div className="mt-1 text-xs text-slate-500 tabular-nums">
            Based on {data?.kpis.totalShiftDays ?? 0} clocked shift days
          </div>
        </div>
      </div>

      {/* Chart 1: Break Time Trends */}
      <div className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
        <div className="flex flex-col gap-2 border-b border-slate-100 pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-base font-semibold text-slate-900">
              Break Time Trends
              {selectedEmployeeName ? ` · ${selectedEmployeeName}` : ' · Branch Total'}
            </h3>
            <p className="text-xs text-slate-500">
              Total break minutes per {range === 'yearly' ? 'month' : 'day'} over the selected{' '}
              {range} window
            </p>
          </div>

          <div className="h-5 text-xs text-slate-600 tabular-nums">
            {hoveredTrendPoint ? (
              <span className="font-mono font-medium text-slate-900">
                {hoveredTrendPoint.label}: {hoveredTrendPoint.totalMinutes}m ({hoveredTrendPoint.breakCount}{' '}
                {hoveredTrendPoint.breakCount === 1 ? 'break' : 'breaks'} · avg{' '}
                {hoveredTrendPoint.avgMinutes}m)
              </span>
            ) : (
              <span>Hover over any point for exact break volume</span>
            )}
          </div>
        </div>

        {loading ? (
          <div className="mt-4 h-56 animate-pulse rounded-lg bg-slate-100" />
        ) : trendSeries.length === 0 ? (
          <div className="py-12 text-center text-sm text-slate-500">
            No break trend data available for this period.
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <svg
              viewBox={`0 0 ${chartW} ${chartH}`}
              className="h-56 w-full min-w-[540px]"
              role="img"
              aria-label="Break Time Trends Chart"
            >
              <defs>
                <linearGradient id="trendAreaFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#0f766e" stopOpacity="0.18" />
                  <stop offset="100%" stopColor="#0f766e" stopOpacity="0.01" />
                </linearGradient>
              </defs>

              {/* Y-axis gridlines */}
              {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
                const y = padT + plotH * (1 - ratio);
                const val = Math.round(maxTrendMinutes * ratio);
                return (
                  <g key={ratio}>
                    <line
                      x1={padL}
                      y1={y}
                      x2={chartW - padR}
                      y2={y}
                      stroke="#e2e8f0"
                      strokeWidth="1"
                    />
                    <text
                      x={padL - 8}
                      y={y + 4}
                      textAnchor="end"
                      className="fill-slate-400 font-mono text-[10px]"
                    >
                      {val}m
                    </text>
                  </g>
                );
              })}

              {/* Area and Line */}
              <path d={areaPath} fill="url(#trendAreaFill)" />
              <path
                d={linePath}
                fill="none"
                stroke="#0f766e"
                strokeWidth="2.25"
                strokeLinejoin="round"
                strokeLinecap="round"
              />

              {/* Hover crosshair */}
              {hoveredTrendPoint && (
                <line
                  x1={hoveredTrendPoint.x}
                  y1={padT}
                  x2={hoveredTrendPoint.x}
                  y2={padT + plotH}
                  stroke="#94a3b8"
                  strokeDasharray="3 3"
                  strokeWidth="1"
                />
              )}

              {/* Data Points + Invisible Wide Hover Targets */}
              {trendPoints.map((pt) => {
                const isHovered = hoveredTrendIdx === pt.idx;
                const showLabel = pt.idx % xLabelStep === 0 || pt.idx === trendPoints.length - 1;
                return (
                  <g key={pt.bucketKey}>
                    {showLabel && (
                      <text
                        x={pt.x}
                        y={chartH - 10}
                        textAnchor="middle"
                        className="fill-slate-500 font-mono text-[10px]"
                      >
                        {pt.label}
                      </text>
                    )}

                    {(pt.totalMinutes > 0 || isHovered) && (
                      <circle
                        cx={pt.x}
                        cy={pt.y}
                        r={isHovered ? 5 : 3}
                        fill={isHovered ? '#0f766e' : '#ffffff'}
                        stroke="#0f766e"
                        strokeWidth="2"
                      />
                    )}

                    <rect
                      x={pt.x - Math.max(8, plotW / Math.max(1, trendPoints.length) / 2)}
                      y={padT}
                      width={Math.max(16, plotW / Math.max(1, trendPoints.length))}
                      height={plotH}
                      fill="transparent"
                      className="cursor-pointer"
                      onMouseEnter={() => setHoveredTrendIdx(pt.idx)}
                      onMouseLeave={() => setHoveredTrendIdx(null)}
                    />
                  </g>
                );
              })}
            </svg>
          </div>
        )}
      </div>

      {/* Two-Column Charts: Average Break Duration per Employee + Team Break Frequency */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Chart 2: Average Break Duration per Employee */}
        <div className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 lg:col-span-6">
          <div className="flex flex-col gap-1 border-b border-slate-100 pb-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-base font-semibold text-slate-900">
                Average Break Duration per Employee
              </h3>
              <p className="text-xs text-slate-500">
                Mean minutes per break vs team benchmark ({data?.kpis.teamAvgBreakMinutes ?? 0}m)
              </p>
            </div>
            {hoveredAvgEmp && (
              <span className="font-mono text-xs font-medium text-slate-800 tabular-nums">
                {hoveredAvgEmp.employeeName}: {hoveredAvgEmp.avgBreakMinutes}m avg
              </span>
            )}
          </div>

          {loading ? (
            <div className="mt-4 space-y-3">
              {[1, 2, 3, 4].map((n) => (
                <div key={n} className="h-8 animate-pulse rounded bg-slate-100" />
              ))}
            </div>
          ) : employeeMetrics.length === 0 ? (
            <div className="py-12 text-center text-sm text-slate-500">
              No employee duration metrics available.
            </div>
          ) : (
            <div className="relative mt-5 space-y-3.5">
              {employeeMetrics.map((m) => {
                const isHighlighted = !employeeId || m.employeeId === employeeId;
                const widthPct = Math.min(100, (m.avgBreakMinutes / maxAvgMinutes) * 100);
                const teamAvgPct = Math.min(
                  100,
                  ((data?.kpis.teamAvgBreakMinutes ?? 0) / maxAvgMinutes) * 100
                );
                const aboveBenchmark =
                  m.avgBreakMinutes > (data?.kpis.teamAvgBreakMinutes ?? 0) && m.totalBreaks > 0;

                return (
                  <div
                    key={m.employeeId}
                    onMouseEnter={() => setHoveredEmpAvgId(m.employeeId)}
                    onMouseLeave={() => setHoveredEmpAvgId(null)}
                    className={`group transition-opacity ${
                      isHighlighted ? 'opacity-100' : 'opacity-40'
                    }`}
                  >
                    <div className="mb-1 flex items-baseline justify-between text-xs">
                      <div className="font-medium text-slate-800">
                        {m.employeeName}
                        <span className="ml-1.5 font-mono text-slate-400">{m.employeeCode}</span>
                      </div>
                      <div className="font-mono text-slate-700 tabular-nums">
                        {m.avgBreakMinutes}m
                        <span className="ml-1.5 text-slate-400">
                          ({m.totalBreaks} {m.totalBreaks === 1 ? 'break' : 'breaks'})
                        </span>
                      </div>
                    </div>

                    <div className="relative h-5 w-full overflow-hidden rounded bg-slate-100">
                      <div
                        style={{ width: `${widthPct}%` }}
                        className={`h-full rounded transition-all duration-300 ${
                          aboveBenchmark ? 'bg-amber-600' : 'bg-teal-700'
                        }`}
                      />
                      {/* Team Average Reference Marker */}
                      {(data?.kpis.teamAvgBreakMinutes ?? 0) > 0 && (
                        <div
                          style={{ left: `${teamAvgPct}%` }}
                          title={`Team Average: ${data?.kpis.teamAvgBreakMinutes}m`}
                          className="absolute top-0 bottom-0 w-px border-l border-dashed border-slate-900/60"
                        />
                      )}
                    </div>
                  </div>
                );
              })}

              <div className="flex items-center justify-between border-t border-slate-100 pt-3 text-xs text-slate-500">
                <span>Teal: At or below team avg · Amber: Above team avg</span>
                <span className="font-mono tabular-nums">
                  Dashed line = {data?.kpis.teamAvgBreakMinutes ?? 0}m avg
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Chart 3: Team Break Frequency Comparison */}
        <div className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 lg:col-span-6">
          <div className="flex flex-col gap-1 border-b border-slate-100 pb-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-base font-semibold text-slate-900">
                Team Break Frequency Comparison
              </h3>
              <p className="text-xs text-slate-500">
                Break count per employee stacked by break category
              </p>
            </div>
            {hoveredFreqEmp && (
              <span className="font-mono text-xs font-medium text-slate-800 tabular-nums">
                {hoveredFreqEmp.employeeName}: {hoveredFreqEmp.totalBreaks} total
              </span>
            )}
          </div>

          {loading ? (
            <div className="mt-4 space-y-3">
              {[1, 2, 3, 4].map((n) => (
                <div key={n} className="h-8 animate-pulse rounded bg-slate-100" />
              ))}
            </div>
          ) : employeeMetrics.length === 0 ? (
            <div className="py-12 text-center text-sm text-slate-500">
              No break frequency data available.
            </div>
          ) : (
            <div className="mt-5 space-y-3.5">
              {employeeMetrics.map((m) => {
                const isHighlighted = !employeeId || m.employeeId === employeeId;
                return (
                  <div
                    key={m.employeeId}
                    onMouseEnter={() => setHoveredEmpFreqId(m.employeeId)}
                    onMouseLeave={() => setHoveredEmpFreqId(null)}
                    className={`transition-opacity ${isHighlighted ? 'opacity-100' : 'opacity-40'}`}
                  >
                    <div className="mb-1 flex items-baseline justify-between text-xs">
                      <div className="font-medium text-slate-800">
                        {m.employeeName}
                        <span className="ml-1.5 text-slate-400">
                          {m.daysClockedIn > 0
                            ? `· ${m.onTimeClockIns}/${m.daysClockedIn} on time`
                            : ''}
                        </span>
                      </div>
                      <div className="font-mono font-semibold text-slate-800 tabular-nums">
                        {m.totalBreaks} {m.totalBreaks === 1 ? 'break' : 'breaks'}
                      </div>
                    </div>

                    <div className="flex h-5 w-full overflow-hidden rounded bg-slate-100">
                      {REASON_KEYS.map((reason) => {
                        const cnt = m.categoryCounts[reason] ?? 0;
                        if (cnt === 0) return null;
                        const pct = (cnt / maxBreakFreq) * 100;
                        return (
                          <div
                            key={reason}
                            style={{
                              width: `${pct}%`,
                              backgroundColor: REASON_COLORS[reason],
                            }}
                            title={`${reason}: ${cnt}`}
                            className="h-full border-r border-white/40 last:border-r-0 transition-all duration-300"
                          />
                        );
                      })}
                    </div>
                  </div>
                );
              })}

              {/* Interactive Category Legend */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-slate-100 pt-3 text-xs text-slate-600">
                {REASON_KEYS.map((reason) => (
                  <div key={reason} className="flex items-center gap-1.5 whitespace-nowrap">
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-xs"
                      style={{ backgroundColor: REASON_COLORS[reason] }}
                    />
                    <span>{reason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
