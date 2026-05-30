import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  ArrowLeft,
  BarChart3,
  RefreshCw,
  Activity,
  AlertTriangle,
} from 'lucide-react';
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
import { PageHeader } from '../components/layout/PageHeader';
import { PageContainer } from '../components/layout/PageContainer';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Disclosure } from '../components/ui/Disclosure';
import { Skeleton } from '../components/ui/Skeleton';
import { ResponsiveTable, type ResponsiveTableColumn } from '../components/ui/ResponsiveTable';
import {
  fetchModelInsights,
  TIMELINE_OPTIONS,
  DEFAULT_RANGE_KEY,
  type ModelInsightRangeKey,
  type ModelInsightsResponse,
  type ModelInsightSeriesBucket,
  type ModelInsightProvider,
  type ModelInsightProviderModel,
} from '../lib/model-insights';
import { api } from '../lib/api';
import {
  formatNumber,
  formatInteger,
  formatCost,
  formatMs,
  formatPercent,
  formatTPS,
  formatDateTimeLabel,
  niceCountAxisMax,
  niceCountAxisTicks,
} from '../lib/format';

// ---------------------------------------------------------------------------
// Chart configuration
// ---------------------------------------------------------------------------

const CHART_COLORS = {
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

/**
 * Wrapper that defers rendering ResponsiveContainer children until the
 * container div has been measured with positive dimensions. This prevents
 * Recharts from logging repeated width/height warnings on mount when the
 * container hasn't been laid out yet (e.g. during loading → data transition
 * inside a Card with padding).
 *
 * The wrapper preserves full responsive behavior: once measured, it renders
 * ResponsiveContainer normally and ResizeObserver keeps dimensions in sync.
 *
 * Measured dimensions are also provided via ChartPanelContext so that nested
 * ResponsiveContainer instances can receive a positive initialDimension prop,
 * avoiding Recharts' default {-1,-1} initial dimension that triggers
 * width(-1)/height(-1) console warnings.
 */
const CHART_CONTAINER_HEIGHT = 280;

const ChartPanelContext = React.createContext<{ width: number; height: number } | null>(null);

const ChartPanel: React.FC<{ children: React.ReactNode }> = ({ children }) => {
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

    // Check immediately — most common path
    if (measure()) return;

    // If not ready yet, observe until dimensions become positive
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

/**
 * Recharts ResponsiveContainer wrapper that reads measured dimensions from
 * the nearest ChartPanelContext and passes them as initialDimension. This
 * prevents Recharts' default {-1,-1} initialDimension from triggering
 * width(-1)/height(-1) console warnings.
 */
const ChartResponsiveContainer: React.FC<
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

/** Shared tooltip style for all charts. */
const TOOLTIP_STYLE = {
  backgroundColor: 'var(--color-bg-card)',
  borderColor: 'var(--color-border)',
  color: 'var(--color-text)',
  borderRadius: '8px',
};

// ---------------------------------------------------------------------------
// Helper: format bucket timestamp for chart axes based on range duration
// ---------------------------------------------------------------------------

function formatBucketLabel(bucketStartMs: number, rangeKey: ModelInsightRangeKey): string {
  const date = new Date(bucketStartMs);
  // For ranges >= 7d, show date; for shorter ranges show time
  if (rangeKey === '7d' || rangeKey === '30d') {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatBucketTooltipLabel(bucketStartMs: number): string {
  return formatDateTimeLabel(String(bucketStartMs));
}

/**
 * Custom Recharts tooltip that reads `bucketStartMs` directly from the
 * active payload entry so the timestamp is always a real epoch-ms value
 * (never NaN). The built-in `labelFormatter` receives the formatted axis
 * label string (e.g. "10:30 AM"), and `Number(label)` on that string
 * produces NaN — which is why we need this custom component.
 */
const BucketTooltip: React.FC<{
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

  // Extract bucketStartMs from the first payload entry's payload property
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

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export const ModelInsights: React.FC = () => {
  const { modelId } = useParams<{ modelId: string }>();
  const navigate = useNavigate();

  // Decode the model id from the route param
  const decodedModelId = modelId ?? '';

  const [activeRange, setActiveRange] = useState<ModelInsightRangeKey>(DEFAULT_RANGE_KEY);

  // ---- Alias-keyed state ----
  // Each piece of state tracks which alias it was resolved/loaded for.
  // We only use the value when the stored alias matches the current decodedModelId.

  // Which alias is the data for? null = no data loaded yet.
  const [dataAlias, setDataAlias] = useState<string | null>(null);
  const [data, setData] = useState<ModelInsightsResponse | null>(null);

  // Which alias is the error for? null = no error.
  const [errorAlias, setErrorAlias] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Which alias is loading?
  const [loadingAlias, setLoadingAlias] = useState<string | null>(decodedModelId || null);

  // Which alias was the config check resolved for?
  // null = config check still pending for this alias
  const [configAlias, setConfigAlias] = useState<string | null>(null);
  // null = still checking, true = configured, false = not configured
  // Only meaningful when configAlias === decodedModelId
  const [isModelConfigured, setIsModelConfigured] = useState<boolean | null>(null);

  // Track in-flight request to avoid stale responses on rapid timeline switching
  const fetchIdRef = useRef(0);
  // Track the current decodedModelId so async callbacks can detect stale alias
  const decodedModelIdRef = useRef(decodedModelId);

  // Synchronously reset all alias-keyed state when the route param changes.
  // This prevents stale previous-alias metrics/config from rendering under the
  // new alias while configuration and insights fetches are in-flight.
  useEffect(() => {
    decodedModelIdRef.current = decodedModelId;
    // Invalidate any in-flight insights fetch from the previous alias
    ++fetchIdRef.current;
    // Set loading for the new alias
    setLoadingAlias(decodedModelId || null);
  }, [decodedModelId]);

  // Fetch current alias configuration to detect unconfigured/removed models
  useEffect(() => {
    let cancelled = false;
    const aliasForThisCall = decodedModelId;
    (async () => {
      try {
        const aliases = await api.getAliases();
        // Check both primary id and additional aliases
        const allIds = new Set<string>();
        for (const alias of aliases) {
          allIds.add(alias.id);
          if (alias.aliases) {
            for (const a of alias.aliases) {
              if (a) allIds.add(a);
            }
          }
        }
        if (!cancelled && decodedModelIdRef.current === aliasForThisCall) {
          setConfigAlias(aliasForThisCall);
          setIsModelConfigured(allIds.has(aliasForThisCall));
        }
      } catch {
        // If alias check fails, proceed with insights fetch anyway.
        // Treat as configured so we don't block on null (which means "pending").
        if (!cancelled && decodedModelIdRef.current === aliasForThisCall) {
          setConfigAlias(aliasForThisCall);
          setIsModelConfigured(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [decodedModelId]);

  const loadData = useCallback(
    async (range: ModelInsightRangeKey) => {
      if (!decodedModelId) return;

      const fetchId = ++fetchIdRef.current;
      const aliasForThisCall = decodedModelId;
      setLoadingAlias(aliasForThisCall);
      setErrorAlias(null);
      setError(null);

      try {
        const result = await fetchModelInsights(aliasForThisCall, range);
        // Only apply if this is still the latest request AND the alias hasn't changed
        if (fetchId === fetchIdRef.current && decodedModelIdRef.current === aliasForThisCall) {
          setDataAlias(aliasForThisCall);
          setData(result);
        }
      } catch (err) {
        if (fetchId === fetchIdRef.current && decodedModelIdRef.current === aliasForThisCall) {
          setErrorAlias(aliasForThisCall);
          setError(err instanceof Error ? err.message : 'Failed to load insights');
          setDataAlias(null);
          setData(null);
        }
      } finally {
        if (fetchId === fetchIdRef.current && decodedModelIdRef.current === aliasForThisCall) {
          setLoadingAlias(null);
        }
      }
    },
    [decodedModelId]
  );

  // Derive effective state: only use stored values when the alias matches
  const isConfiguredForCurrentAlias = configAlias === decodedModelId ? isModelConfigured : null;
  const isLoadingCurrentAlias = loadingAlias === decodedModelId;
  const errorForCurrentAlias = errorAlias === decodedModelId ? error : null;
  const dataForCurrentAlias = dataAlias === decodedModelId ? data : null;

  // Initial load + range changes — only fetch after config check resolves true
  // for the current decodedModelId
  useEffect(() => {
    // Guard: only proceed if the config check is for the current alias
    if (decodedModelIdRef.current !== decodedModelId) return;

    if (isConfiguredForCurrentAlias === null) {
      // Configuration check still in progress; do not fetch insights yet
      return;
    }
    if (isConfiguredForCurrentAlias === false) {
      setLoadingAlias(null);
      setDataAlias(null);
      setData(null);
      return;
    }
    // isConfiguredForCurrentAlias === true — safe to fetch insights
    loadData(activeRange);
  }, [activeRange, loadData, isConfiguredForCurrentAlias, decodedModelId]);

  const handleRangeSelect = (key: ModelInsightRangeKey) => {
    setActiveRange(key);
  };

  const handleRetry = () => {
    loadData(activeRange);
  };

  const handleBackToModels = () => {
    navigate('/models');
  };

  const isEmpty =
    dataForCurrentAlias !== null &&
    dataForCurrentAlias.metrics.requests === 0 &&
    dataForCurrentAlias.providers.length === 0;

  // Prepare chart data from series buckets
  const chartData = useMemo(() => {
    if (!dataForCurrentAlias || !dataForCurrentAlias.series.length) return [];
    return dataForCurrentAlias.series.map((bucket: ModelInsightSeriesBucket) => ({
      bucketStartMs: bucket.bucketStartMs,
      label: formatBucketLabel(bucket.bucketStartMs, dataForCurrentAlias.range.key),
      requests: bucket.metrics.requests,
      totalTokens: bucket.metrics.totalTokens,
      inputTokens: bucket.metrics.inputTokens,
      outputTokens: bucket.metrics.outputTokens,
      cachedTokens: bucket.metrics.cachedTokens,
      cacheWriteTokens: bucket.metrics.cacheWriteTokens,
      totalCost: bucket.metrics.totalCost,
      avgLatencyMs: bucket.metrics.avgLatencyMs,
      avgTtftMs: bucket.metrics.avgTtftMs,
      avgThroughputTps: bucket.metrics.avgThroughputTps,
      avgE2eTps: bucket.metrics.avgE2eTps,
      cacheHitRate: bucket.metrics.cacheHitRate,
    }));
  }, [dataForCurrentAlias]);

  const requestsChartAxis = useMemo(() => {
    const max = chartData.reduce((m, d) => Math.max(m, d.requests), 0);
    return { max: niceCountAxisMax(max), ticks: niceCountAxisTicks(max) };
  }, [chartData]);

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader
        title={
          <div className="flex items-center gap-2">
            <BarChart3 size={20} className="text-primary" />
            <span>Model Insights</span>
          </div>
        }
        subtitle={decodedModelId}
        actions={
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<ArrowLeft size={14} />}
            onClick={handleBackToModels}
          >
            Models
          </Button>
        }
      >
        {/* Timeline selector — hidden during config check and for unconfigured models */}
        {isConfiguredForCurrentAlias === true && (
          <div className="flex flex-wrap items-center gap-1.5">
            {TIMELINE_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => handleRangeSelect(opt.key)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors duration-150 ${
                  activeRange === opt.key
                    ? 'bg-primary/20 text-primary border border-primary/30'
                    : 'bg-bg-glass text-text-secondary border border-border-glass hover:bg-bg-hover'
                }`}
                aria-pressed={activeRange === opt.key}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}
      </PageHeader>

      <PageContainer>
        {/* ---- Loading state ---- */}
        {isLoadingCurrentAlias && <LoadingSkeleton />}

        {/* ---- Missing / no-longer-configured model state ---- */}
        {!isLoadingCurrentAlias && isConfiguredForCurrentAlias === false && (
          <Card className="mb-6">
            <div className="flex flex-col items-center justify-center py-16 gap-4">
              <AlertTriangle size={32} className="text-warning opacity-60" />
              <div className="text-sm text-text-secondary text-center max-w-md">
                <strong className="text-text">{decodedModelId}</strong> is not currently configured
                as a model alias. It may have been removed or the URL may be incorrect.
              </div>
              <Link
                to="/models"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-primary/20 text-primary border border-primary/30 hover:bg-primary/30 transition-colors duration-150"
              >
                <ArrowLeft size={14} />
                Back to Models
              </Link>
            </div>
          </Card>
        )}

        {/* ---- Error state ---- */}
        {!isLoadingCurrentAlias && errorForCurrentAlias && isConfiguredForCurrentAlias === true && (
          <Card className="mb-6">
            <div className="flex flex-col items-center justify-center py-16 gap-4">
              <Activity size={32} className="text-danger opacity-60" />
              <div className="text-sm text-text-secondary text-center max-w-md">
                {errorForCurrentAlias}
              </div>
              <Button
                variant="secondary"
                size="sm"
                leftIcon={<RefreshCw size={14} />}
                onClick={handleRetry}
              >
                Retry
              </Button>
            </div>
          </Card>
        )}

        {/* ---- Empty state (configured model with no data) ---- */}
        {!isLoadingCurrentAlias &&
          !errorForCurrentAlias &&
          isConfiguredForCurrentAlias === true &&
          isEmpty && (
            <Card className="mb-6">
              <div className="flex flex-col items-center justify-center py-16 gap-3">
                <BarChart3 size={32} className="text-text-muted opacity-40" />
                <div className="text-sm text-text-muted text-center">
                  No usage data found for <strong className="text-text">{decodedModelId}</strong> in
                  the selected time range.
                </div>
                <div className="text-xs text-text-muted">
                  Try selecting a different time range, or check back after this model has been
                  used.
                </div>
              </div>
            </Card>
          )}

        {/* ---- Data loaded ---- */}
        {!isLoadingCurrentAlias &&
          !errorForCurrentAlias &&
          dataForCurrentAlias &&
          !isEmpty &&
          isConfiguredForCurrentAlias === true && (
            <>
              {/* Hero metrics — top 3 numbers at a glance */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
                <HeroMetric
                  label="Requests"
                  value={formatInteger(dataForCurrentAlias.metrics.requests)}
                  accentColor="var(--color-primary)"
                />
                <HeroMetric
                  label="Total Cost"
                  value={formatCost(dataForCurrentAlias.metrics.totalCost)}
                  accentColor="var(--color-success)"
                />
                <HeroMetric
                  label="Avg Latency"
                  value={formatMs(dataForCurrentAlias.metrics.avgLatencyMs)}
                  accentColor="var(--color-info)"
                />
              </div>

              {/* Performance section */}
              <Card title="Performance" className="mb-4" dense>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3">
                  <SectionMetric label="Success Rate" value={formatPercent(dataForCurrentAlias.metrics.successRate * 100)} />
                  <SectionMetric label="Avg TTFT" value={formatMs(dataForCurrentAlias.metrics.avgTtftMs)} />
                  <SectionMetric label="Throughput" value={`${formatTPS(dataForCurrentAlias.metrics.avgThroughputTps)} tok/s`} />
                  <SectionMetric label="E2E TPS" value={`${formatTPS(dataForCurrentAlias.metrics.avgE2eTps)} tok/s`} />
                  <SectionMetric label="Cache Hit Rate" value={formatPercent(dataForCurrentAlias.metrics.cacheHitRate * 100)} />
                </div>
              </Card>

              {/* Token breakdown section */}
              <Card title="Tokens" className="mb-4" dense>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3">
                  <SectionMetric label="Total" value={formatNumber(dataForCurrentAlias.metrics.totalTokens, 1)} />
                  <SectionMetric label="Input" value={formatNumber(dataForCurrentAlias.metrics.inputTokens, 1)} />
                  <SectionMetric label="Output" value={formatNumber(dataForCurrentAlias.metrics.outputTokens, 1)} />
                  <SectionMetric label="Reasoning" value={formatNumber(dataForCurrentAlias.metrics.reasoningTokens, 1)} />
                  <SectionMetric label="Cached" value={formatNumber(dataForCurrentAlias.metrics.cachedTokens, 1)} />
                  <SectionMetric label="Cache Write" value={formatNumber(dataForCurrentAlias.metrics.cacheWriteTokens, 1)} />
                </div>
              </Card>

              {/* Cost details section */}
              <Card title="Cost Details" className="mb-6" dense>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3">
                  <SectionMetric label="Cost per Request" value={formatCost(dataForCurrentAlias.metrics.costPerRequest)} />
                  <SectionMetric label="Cost per 1M Tokens" value={formatCost(dataForCurrentAlias.metrics.costPerMillionTokens)} />
                  <SectionMetric label="Streamed Requests" value={formatNumber(dataForCurrentAlias.metrics.streamedRequests, 0)} />
                  <SectionMetric label="Non-Streamed" value={formatNumber(dataForCurrentAlias.metrics.nonStreamedRequests, 0)} />
                </div>
              </Card>

              {/* ---- Time-series charts ---- */}
              {chartData.length > 0 && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
                  {/* Requests chart */}
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
                              <BucketTooltip
                                formatters={{ requests: (v) => [formatInteger(v), 'Requests'] }}
                              />
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

                  {/* Token breakdown chart */}
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
                                  inputTokens: (v) => [formatNumber(v, 0), 'Input'],
                                  outputTokens: (v) => [formatNumber(v, 0), 'Output'],
                                  cachedTokens: (v) => [formatNumber(v, 0), 'Cached'],
                                  cacheWriteTokens: (v) => [formatNumber(v, 0), 'Cache Write'],
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

                  {/* Cost chart */}
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
                              <BucketTooltip
                                formatters={{ totalCost: (v) => [formatCost(v), 'Cost'] }}
                              />
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

                  {/* Latency / TTFT chart */}
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

                  {/* E2E TPS chart */}
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

                  {/* Cache Hit Rate chart */}
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
              )}

              {/* ---- Provider collapsible sections ---- */}
              {dataForCurrentAlias.providers.length > 0 && (
                <div className="space-y-3 mb-6">
                  <h3 className="font-heading text-sm font-semibold text-text px-1">Providers</h3>
                  {dataForCurrentAlias.providers.map((provider, pIdx) => (
                    <ProviderSection
                      key={`${provider.provider}:${pIdx}`}
                      provider={provider}
                      rangeKey={dataForCurrentAlias.range.key}
                    />
                  ))}
                </div>
              )}
            </>
          )}
      </PageContainer>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Prominent hero metric card with colored left-border accent. */
const HeroMetric: React.FC<{
  label: string;
  value: string;
  accentColor: string;
}> = ({ label, value, accentColor }) => (
  <div
    className="rounded-lg border border-border bg-bg-card px-4 py-3"
    style={{ borderLeftWidth: 3, borderLeftColor: accentColor }}
  >
    <div className="text-xs text-text-muted font-medium mb-1">{label}</div>
    <div className="text-xl font-semibold text-text truncate" title={value}>
      {value}
    </div>
  </div>
);

/** Compact label-value pair for use inside section grids. */
const SectionMetric: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <div className="text-[11px] text-text-muted font-medium mb-0.5">{label}</div>
    <div className="text-sm font-semibold text-text truncate" title={value}>
      {value}
    </div>
  </div>
);

/** Loading skeleton for the entire insights page. */
const LoadingSkeleton: React.FC = () => (
  <>
    {/* Hero metric skeletons */}
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="rounded-lg border border-border bg-bg-card px-4 py-3">
          <Skeleton height={10} width="40%" className="mb-2" />
          <Skeleton height={24} width="60%" />
        </div>
      ))}
    </div>
    {/* Section card skeletons */}
    {Array.from({ length: 3 }).map((_, i) => (
      <Card key={i} className="mb-4" dense>
        <Skeleton height={14} width="30%" className="mb-3" />
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3">
          {Array.from({ length: i === 2 ? 4 : 6 }).map((_, j) => (
            <div key={j}>
              <Skeleton height={10} width="50%" className="mb-1.5" />
              <Skeleton height={14} width="70%" />
            </div>
          ))}
        </div>
      </Card>
    ))}
    {/* Chart skeletons */}
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
      {Array.from({ length: 4 }).map((_, i) => (
        <Card key={i}>
          <Skeleton height={16} width="40%" className="mb-3" />
          <Skeleton height={280} />
        </Card>
      ))}
    </div>
    {/* Provider section skeleton */}
    <Card>
      <Skeleton height={16} width="30%" className="mb-3" />
      <Skeleton height={60} className="mb-2" />
      <Skeleton height={60} />
    </Card>
  </>
);

/** Collapsible provider section with summary header and detailed model table. */
const ProviderSection: React.FC<{
  provider: ModelInsightProvider;
  rangeKey: ModelInsightRangeKey;
}> = ({ provider }) => {
  const summaryText = [
    `${formatInteger(provider.metrics.requests)} requests`,
    `${formatNumber(provider.metrics.totalTokens, 1)} tokens`,
    formatCost(provider.metrics.totalCost),
  ].join(' \u00b7 ');

  const extra = (
    <span className="text-xs text-text-muted">
      {formatPercent(provider.metrics.successRate * 100)} success
    </span>
  );

  return (
    <Disclosure
      title={
        <span className="flex items-center gap-2">
          <span className="font-medium">{provider.provider}</span>
          <span className="text-xs text-text-muted font-normal">{summaryText}</span>
        </span>
      }
      extra={extra}
      defaultOpen={false}
    >
      {/* Provider summary metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3 mb-4">
        <ProviderMetric label="Requests" value={formatInteger(provider.metrics.requests)} />
        <ProviderMetric
          label="Total Tokens"
          value={formatNumber(provider.metrics.totalTokens, 1)}
        />
        <ProviderMetric label="Cost" value={formatCost(provider.metrics.totalCost)} />
        <ProviderMetric label="Avg TTFT" value={formatMs(provider.metrics.avgTtftMs)} />
        <ProviderMetric
          label="Throughput"
          value={`${formatTPS(provider.metrics.avgThroughputTps)} tok/s`}
        />
        <ProviderMetric label="E2E TPS" value={`${formatTPS(provider.metrics.avgE2eTps)} tok/s`} />
      </div>

      {/* Provider model table */}
      {provider.models.length > 0 && (
        <ProviderModelTable models={provider.models} providerName={provider.provider} />
      )}
    </Disclosure>
  );
};

/** Small provider metric display. */
const ProviderMetric: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <div className="text-[10px] uppercase tracking-wider text-text-muted font-medium mb-0.5">
      {label}
    </div>
    <div className="text-xs font-semibold text-text truncate" title={value}>
      {value}
    </div>
  </div>
);

/** Table of models within a provider section. */
const ProviderModelTable: React.FC<{
  models: ModelInsightProviderModel[];
  providerName: string;
}> = ({ models, providerName }) => {
  const columns: ResponsiveTableColumn<ModelInsightProviderModel>[] = useMemo(
    () => [
      {
        key: 'provider',
        header: 'Provider',
        mobileTitle: true,
        priority: 'high',
        render: (row) => {
          const display = row.finalAttemptProvider ?? providerName;
          return (
            <span className="truncate max-w-[200px] inline-block" title={display}>
              {display}
            </span>
          );
        },
      },
      {
        key: 'model',
        header: 'Model',
        priority: 'high',
        render: (row) => {
          const displayName = row.canonicalModelName ?? row.selectedModelName ?? 'Unknown';
          const titleParts = [displayName];
          if (row.finalAttemptModel) titleParts.push(`(${row.finalAttemptModel})`);
          return (
            <span className="truncate max-w-[200px] inline-block" title={titleParts.join(' ')}>
              {displayName}
            </span>
          );
        },
      },
      {
        key: 'finalAttempt',
        header: 'Final Attempt',
        priority: 'high',
        render: (row) => {
          const parts: string[] = [];
          if (row.finalAttemptProvider) parts.push(row.finalAttemptProvider);
          if (row.finalAttemptModel) parts.push(row.finalAttemptModel);
          const display = parts.length > 0 ? parts.join(' / ') : '—';
          return (
            <span className="truncate max-w-[200px] inline-block" title={display}>
              {display}
            </span>
          );
        },
      },
      {
        key: 'requests',
        header: 'Requests',
        priority: 'high',
        align: 'right',
        render: (row) => formatInteger(row.metrics.requests),
      },
      {
        key: 'totalTokens',
        header: 'Tokens',
        priority: 'medium',
        align: 'right',
        render: (row) => formatNumber(row.metrics.totalTokens, 1),
      },
      {
        key: 'cost',
        header: 'Cost',
        priority: 'medium',
        align: 'right',
        render: (row) => formatCost(row.metrics.totalCost),
      },
      {
        key: 'throughputTps',
        header: 'Avg TPS',
        priority: 'medium',
        align: 'right',
        render: (row) => `${formatTPS(row.metrics.avgThroughputTps)} tok/s`,
      },
      {
        key: 'e2eTps',
        header: 'E2E TPS',
        priority: 'medium',
        align: 'right',
        render: (row) => `${formatTPS(row.metrics.avgE2eTps)} tok/s`,
      },
      {
        key: 'ttft',
        header: 'Avg TTFT',
        priority: 'low',
        align: 'right',
        render: (row) => formatMs(row.metrics.avgTtftMs),
      },
      {
        key: 'latency',
        header: 'Avg Latency',
        priority: 'low',
        align: 'right',
        render: (row) => formatMs(row.metrics.avgLatencyMs),
      },
      {
        key: 'successRate',
        header: 'Success',
        priority: 'low',
        align: 'right',
        render: (row) => formatPercent(row.metrics.successRate * 100),
      },
      {
        key: 'cacheHitRate',
        header: 'Cache Hit',
        priority: 'low',
        align: 'right',
        render: (row) => formatPercent(row.metrics.cacheHitRate * 100),
      },
    ],
    [providerName]
  );

  return (
    <ResponsiveTable
      columns={columns}
      data={models}
      getRowKey={(row, idx) =>
        `${row.finalAttemptProvider ?? ''}:${row.finalAttemptModel ?? ''}:${row.canonicalModelName ?? ''}:${row.selectedModelName ?? ''}:${idx}`
      }
    />
  );
};
