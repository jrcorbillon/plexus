import React, { useRef, useState, useEffect } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { Card } from '../ui/Card';
import type { ModelInsightRangeMetaKey } from '../../lib/model-insights';
import {
  formatNumber,
  formatInteger,
  formatCost,
  formatMs,
  formatPercent,
  formatTPS,
  formatDateTimeLabel,
} from '../../lib/format';

export const CHART_COLORS = {
  requests: '#8b5cf6',
  tokens: '#06b6d4',
  inputTokens: '#82ca9d',
  outputTokens: '#ffc658',
  cachedTokens: '#ff7300',
  cacheWriteTokens: '#a855f7',
  cost: '#10b981',
  latency: '#f59e0b',
  ttft: '#ef4444',
  throughput: '#6366f1',
};

const CHART_CONTAINER_HEIGHT = 280;

const ChartPanelContext = React.createContext<{ width: number; height: number } | null>(null);

export const ChartPanel: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      if (width > 0 && height > 0) {
        setDimensions({ width, height });
        return true;
      }
      return false;
    };

    if (measure()) return;

    const observer = new ResizeObserver(() => {
      if (measure()) {
        observer.disconnect();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <ChartPanelContext.Provider value={dimensions}>
      <div ref={containerRef} style={{ height: CHART_CONTAINER_HEIGHT, width: '100%', marginTop: '12px' }}>
        {dimensions ? children : null}
      </div>
    </ChartPanelContext.Provider>
  );
};

export const ChartResponsiveContainer: React.FC<
  React.ComponentProps<typeof ResponsiveContainer>
> = ({ children, ...props }) => {
  const dims = React.useContext(ChartPanelContext);
  const initialDimension =
    dims && dims.width > 0 && dims.height > 0
      ? { width: dims.width, height: dims.height }
      : undefined;
  return (
    <ResponsiveContainer {...props} initialDimension={initialDimension}>
      {children}
    </ResponsiveContainer>
  );
};

const TOOLTIP_STYLE = {
  backgroundColor: 'var(--color-bg-card)',
  borderColor: 'var(--color-border)',
  color: 'var(--color-text)',
  borderRadius: '8px',
};

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

export function formatBucketLabel(
  bucketStartMs: number,
  rangeKey: ModelInsightRangeMetaKey,
  rangeSpanMs?: number
): string {
  const date = new Date(bucketStartMs);
  const useDateLabel =
    rangeKey === '7d' ||
    rangeKey === '30d' ||
    (rangeKey === 'custom' &&
      rangeSpanMs != null &&
      Number.isFinite(rangeSpanMs) &&
      rangeSpanMs > TWO_DAYS_MS);
  if (useDateLabel) {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatBucketTooltipLabel(bucketStartMs: number): string {
  return formatDateTimeLabel(String(bucketStartMs));
}

export const BucketTooltip: React.FC<{
  active?: boolean;
  payload?: Array<{
    dataKey?: string | number;
    value?: number;
    name?: string;
    color?: string;
    payload?: Record<string, unknown>;
  }>;
  formatters: Record<string, (v: number) => string | [string, string]>;
}> = ({ active, payload, formatters }) => {
  if (!active || !payload || !payload.length) return null;

  const rawPayload = payload[0]?.payload;
  const bucketStartMs = (rawPayload?.bucketStartMs as number) ?? 0;
  const timestampLabel = bucketStartMs
    ? formatBucketTooltipLabel(bucketStartMs)
    : String(rawPayload?.label ?? '');

  return (
    <div style={TOOLTIP_STYLE} className="text-xs">
      <div className="font-medium mb-1" style={{ color: 'var(--color-text-secondary)' }}>
        {timestampLabel}
      </div>
      {payload.map((entry, idx) => {
        const dataKey = String(entry.dataKey ?? '');
        const fmt = formatters[dataKey];
        const raw = entry.value as number;
        const formatted = fmt ? fmt(raw) : formatNumber(raw, 0);
        const display = Array.isArray(formatted) ? formatted : [formatted, entry.name ?? dataKey];
        return (
          <div key={`${dataKey}-${idx}`} className="flex items-center gap-1.5">
            <span
              style={{
                display: 'inline-block',
                width: 8,
                height: 8,
                borderRadius: '50%',
                backgroundColor: entry.color,
              }}
            />
            <span style={{ color: 'var(--color-text-secondary)' }}>{display[1]}:</span>
            <span className="font-medium" style={{ color: 'var(--color-text)' }}>
              {display[0]}
            </span>
          </div>
        );
      })}
    </div>
  );
};

export interface InsightsChartDataPoint {
  bucketStartMs: number;
  label: string;
  requests: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  totalCost: number;
  avgLatencyMs: number;
  avgTtftMs: number;
  avgThroughputTps: number;
  avgE2eTps: number;
  cacheHitRate: number;
}

export interface InsightsRequestsChartAxis {
  max: number;
  ticks: number[];
}

export const InsightsTimeSeriesCharts: React.FC<{
  chartData: InsightsChartDataPoint[];
  requestsChartAxis: InsightsRequestsChartAxis;
  rangeKey: ModelInsightRangeMetaKey;
}> = ({ chartData, requestsChartAxis }) => (
  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
    <Card title="Requests over Time">
      <ChartPanel>
        <ChartResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-glass)" />
            <XAxis
              dataKey="label"
              stroke="var(--color-text-secondary)"
              tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              stroke="var(--color-text-secondary)"
              tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
              domain={[0, requestsChartAxis.max]}
              ticks={requestsChartAxis.ticks}
              allowDecimals={false}
              tickFormatter={(v: number) => formatInteger(v)}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              content={
                <BucketTooltip formatters={{ requests: (v) => [formatInteger(v), 'Requests'] }} />
              }
            />
            <Area
              type="monotone"
              dataKey="requests"
              stroke={CHART_COLORS.requests}
              fill={CHART_COLORS.requests}
              fillOpacity={0.15}
              name="Requests"
            />
          </AreaChart>
        </ChartResponsiveContainer>
      </ChartPanel>
    </Card>

    <Card title="Token Usage over Time">
      <ChartPanel>
        <ChartResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-glass)" />
            <XAxis
              dataKey="label"
              stroke="var(--color-text-secondary)"
              tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              stroke="var(--color-text-secondary)"
              tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
              tickFormatter={(v: number) => formatNumber(v, 0)}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              content={
                <BucketTooltip
                  formatters={{
                    inputTokens: (v) => [formatInteger(v), 'Input'],
                    outputTokens: (v) => [formatInteger(v), 'Output'],
                    cachedTokens: (v) => [formatInteger(v), 'Cached'],
                    cacheWriteTokens: (v) => [formatInteger(v), 'Cache Write'],
                  }}
                />
              }
            />
            <Legend />
            <Area
              type="monotone"
              dataKey="inputTokens"
              name="Input"
              stroke={CHART_COLORS.inputTokens}
              fill={CHART_COLORS.inputTokens}
              fillOpacity={0.3}
            />
            <Area
              type="monotone"
              dataKey="outputTokens"
              name="Output"
              stroke={CHART_COLORS.outputTokens}
              fill={CHART_COLORS.outputTokens}
              fillOpacity={0.3}
            />
            <Area
              type="monotone"
              dataKey="cachedTokens"
              name="Cached"
              stroke={CHART_COLORS.cachedTokens}
              fill={CHART_COLORS.cachedTokens}
              fillOpacity={0.3}
            />
            <Area
              type="monotone"
              dataKey="cacheWriteTokens"
              name="Cache Write"
              stroke={CHART_COLORS.cacheWriteTokens}
              fill={CHART_COLORS.cacheWriteTokens}
              fillOpacity={0.3}
            />
          </AreaChart>
        </ChartResponsiveContainer>
      </ChartPanel>
    </Card>

    <Card title="Cost over Time">
      <ChartPanel>
        <ChartResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-glass)" />
            <XAxis
              dataKey="label"
              stroke="var(--color-text-secondary)"
              tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              stroke="var(--color-text-secondary)"
              tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
              tickFormatter={(v: number) => formatCost(v)}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              content={
                <BucketTooltip formatters={{ totalCost: (v) => [formatCost(v), 'Cost'] }} />
              }
            />
            <Area
              type="monotone"
              dataKey="totalCost"
              stroke={CHART_COLORS.cost}
              fill={CHART_COLORS.cost}
              fillOpacity={0.15}
              name="Cost"
            />
          </AreaChart>
        </ChartResponsiveContainer>
      </ChartPanel>
    </Card>

    <Card title="Latency & TTFT over Time">
      <ChartPanel>
        <ChartResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-glass)" />
            <XAxis
              dataKey="label"
              stroke="var(--color-text-secondary)"
              tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              stroke="var(--color-text-secondary)"
              tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
              tickFormatter={(v: number) => formatMs(v)}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              content={
                <BucketTooltip
                  formatters={{
                    avgLatencyMs: (v) => [formatMs(v), 'Avg Latency'],
                    avgTtftMs: (v) => [formatMs(v), 'Avg TTFT'],
                  }}
                />
              }
            />
            <Legend />
            <Area
              type="monotone"
              dataKey="avgLatencyMs"
              name="Avg Latency"
              stroke={CHART_COLORS.latency}
              fill={CHART_COLORS.latency}
              fillOpacity={0.15}
            />
            <Area
              type="monotone"
              dataKey="avgTtftMs"
              name="Avg TTFT"
              stroke={CHART_COLORS.ttft}
              fill={CHART_COLORS.ttft}
              fillOpacity={0.15}
            />
          </AreaChart>
        </ChartResponsiveContainer>
      </ChartPanel>
    </Card>

    <Card title="E2E TPS over Time">
      <ChartPanel>
        <ChartResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-glass)" />
            <XAxis
              dataKey="label"
              stroke="var(--color-text-secondary)"
              tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              stroke="var(--color-text-secondary)"
              tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
              tickFormatter={(v: number) => formatTPS(v)}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              content={
                <BucketTooltip
                  formatters={{
                    avgE2eTps: (v) => [`${formatTPS(v)} tok/s`, 'E2E TPS'],
                  }}
                />
              }
            />
            <Area
              type="monotone"
              dataKey="avgE2eTps"
              stroke={CHART_COLORS.throughput}
              fill={CHART_COLORS.throughput}
              fillOpacity={0.15}
              name="E2E TPS"
            />
          </AreaChart>
        </ChartResponsiveContainer>
      </ChartPanel>
    </Card>

    <Card title="Cache Hit Rate over Time">
      <ChartPanel>
        <ChartResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-glass)" />
            <XAxis
              dataKey="label"
              stroke="var(--color-text-secondary)"
              tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              stroke="var(--color-text-secondary)"
              tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
              tickFormatter={(v: number) => formatPercent(v * 100)}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              content={
                <BucketTooltip
                  formatters={{
                    cacheHitRate: (v) => [formatPercent(v * 100), 'Cache Hit Rate'],
                  }}
                />
              }
            />
            <Area
              type="monotone"
              dataKey="cacheHitRate"
              stroke={CHART_COLORS.cachedTokens}
              fill={CHART_COLORS.cachedTokens}
              fillOpacity={0.15}
              name="Cache Hit Rate"
            />
          </AreaChart>
        </ChartResponsiveContainer>
      </ChartPanel>
    </Card>
  </div>
);
