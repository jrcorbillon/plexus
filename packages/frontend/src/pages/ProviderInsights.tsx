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
  fetchProviderInsights,
  TIMELINE_OPTIONS,
  DEFAULT_RANGE_KEY,
  modelDisplayName,
  type ProviderInsightRangeKey,
  type ProviderInsightsResponse,
  type ProviderInsightSeriesBucket,
  type ProviderInsightModel,
  type ProviderInsightModelAlias,
} from '../lib/provider-insights';
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

function formatBucketLabel(bucketStartMs: number, rangeKey: ProviderInsightRangeKey): string {
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

export const ProviderInsights: React.FC = () => {
  const { providerId } = useParams<{ providerId: string }>();
  const navigate = useNavigate();

  const decodedProviderId = providerId ?? '';

  const [activeRange, setActiveRange] = useState<ProviderInsightRangeKey>(DEFAULT_RANGE_KEY);

  const [dataProvider, setDataProvider] = useState<string | null>(null);
  const [data, setData] = useState<ProviderInsightsResponse | null>(null);

  const [errorProvider, setErrorProvider] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [loadingProvider, setLoadingProvider] = useState<string | null>(decodedProviderId || null);

  const [configProvider, setConfigProvider] = useState<string | null>(null);
  const [isProviderConfigured, setIsProviderConfigured] = useState<boolean | null>(null);

  const fetchIdRef = useRef(0);
  const decodedProviderIdRef = useRef(decodedProviderId);

  useEffect(() => {
    decodedProviderIdRef.current = decodedProviderId;
    ++fetchIdRef.current;
    setLoadingProvider(decodedProviderId || null);
  }, [decodedProviderId]);

  useEffect(() => {
    let cancelled = false;
    const providerForThisCall = decodedProviderId;
    (async () => {
      try {
        const providers = await api.getProviders();
        const allIds = new Set(providers.map((p) => p.id));
        if (!cancelled && decodedProviderIdRef.current === providerForThisCall) {
          setConfigProvider(providerForThisCall);
          setIsProviderConfigured(allIds.has(providerForThisCall));
        }
      } catch {
        if (!cancelled && decodedProviderIdRef.current === providerForThisCall) {
          setConfigProvider(providerForThisCall);
          setIsProviderConfigured(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [decodedProviderId]);

  const loadData = useCallback(
    async (range: ProviderInsightRangeKey) => {
      if (!decodedProviderId) return;

      const fetchId = ++fetchIdRef.current;
      const providerForThisCall = decodedProviderId;
      setLoadingProvider(providerForThisCall);
      setErrorProvider(null);
      setError(null);

      try {
        const result = await fetchProviderInsights(providerForThisCall, range);
        if (fetchId === fetchIdRef.current && decodedProviderIdRef.current === providerForThisCall) {
          setDataProvider(providerForThisCall);
          setData(result);
        }
      } catch (err) {
        if (fetchId === fetchIdRef.current && decodedProviderIdRef.current === providerForThisCall) {
          setErrorProvider(providerForThisCall);
          setError(err instanceof Error ? err.message : 'Failed to load insights');
          setDataProvider(null);
          setData(null);
        }
      } finally {
        if (fetchId === fetchIdRef.current && decodedProviderIdRef.current === providerForThisCall) {
          setLoadingProvider(null);
        }
      }
    },
    [decodedProviderId]
  );

  const isConfiguredForCurrentProvider =
    configProvider === decodedProviderId ? isProviderConfigured : null;
  const isLoadingCurrentProvider = loadingProvider === decodedProviderId;
  const errorForCurrentProvider = errorProvider === decodedProviderId ? error : null;
  const dataForCurrentProvider = dataProvider === decodedProviderId ? data : null;

  useEffect(() => {
    if (decodedProviderIdRef.current !== decodedProviderId) return;

    if (isConfiguredForCurrentProvider === null) {
      return;
    }
    if (isConfiguredForCurrentProvider === false) {
      setLoadingProvider(null);
      setDataProvider(null);
      setData(null);
      return;
    }
    loadData(activeRange);
  }, [activeRange, loadData, isConfiguredForCurrentProvider, decodedProviderId]);

  const handleRangeSelect = (key: ProviderInsightRangeKey) => {
    setActiveRange(key);
  };

  const handleRetry = () => {
    loadData(activeRange);
  };

  const handleBackToProviders = () => {
    navigate('/providers');
  };

  const isEmpty =
    dataForCurrentProvider !== null &&
    dataForCurrentProvider.metrics.requests === 0 &&
    dataForCurrentProvider.models.length === 0;

  const chartData = useMemo(() => {
    if (!dataForCurrentProvider || !dataForCurrentProvider.series.length) return [];
    return dataForCurrentProvider.series.map((bucket: ProviderInsightSeriesBucket) => ({
      bucketStartMs: bucket.bucketStartMs,
      label: formatBucketLabel(bucket.bucketStartMs, dataForCurrentProvider.range.key),
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
  }, [dataForCurrentProvider]);

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
            <span>Provider Insights</span>
          </div>
        }
        subtitle={decodedProviderId}
        actions={
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<ArrowLeft size={14} />}
            onClick={handleBackToProviders}
          >
            Providers
          </Button>
        }
      >
        {/* Timeline selector — hidden during config check and for unconfigured models */}
        {isConfiguredForCurrentProvider === true && (
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
        {isLoadingCurrentProvider && <LoadingSkeleton />}

        {/* ---- Missing / no-longer-configured model state ---- */}
        {!isLoadingCurrentProvider && isConfiguredForCurrentProvider === false && (
          <Card className="mb-6">
            <div className="flex flex-col items-center justify-center py-16 gap-4">
              <AlertTriangle size={32} className="text-warning opacity-60" />
              <div className="text-sm text-text-secondary text-center max-w-md">
                <strong className="text-text">{decodedProviderId}</strong> is not currently configured
                as a provider. It may have been removed or the URL may be incorrect.
              </div>
              <Link
                to="/providers"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-primary/20 text-primary border border-primary/30 hover:bg-primary/30 transition-colors duration-150"
              >
                <ArrowLeft size={14} />
                Back to Providers
              </Link>
            </div>
          </Card>
        )}

        {/* ---- Error state ---- */}
        {!isLoadingCurrentProvider && errorForCurrentProvider && isConfiguredForCurrentProvider === true && (
          <Card className="mb-6">
            <div className="flex flex-col items-center justify-center py-16 gap-4">
              <Activity size={32} className="text-danger opacity-60" />
              <div className="text-sm text-text-secondary text-center max-w-md">
                {errorForCurrentProvider}
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
        {!isLoadingCurrentProvider &&
          !errorForCurrentProvider &&
          isConfiguredForCurrentProvider === true &&
          isEmpty && (
            <Card className="mb-6">
              <div className="flex flex-col items-center justify-center py-16 gap-3">
                <BarChart3 size={32} className="text-text-muted opacity-40" />
                <div className="text-sm text-text-muted text-center">
                  No usage data found for <strong className="text-text">{decodedProviderId}</strong> in
                  the selected time range.
                </div>
                <div className="text-xs text-text-muted">
                  Try selecting a different time range, or check back after this provider has been
                  used.
                </div>
              </div>
            </Card>
          )}

        {/* ---- Data loaded ---- */}
        {!isLoadingCurrentProvider &&
          !errorForCurrentProvider &&
          dataForCurrentProvider &&
          !isEmpty &&
          isConfiguredForCurrentProvider === true && (
            <>
              {/* Hero metrics — top 3 numbers at a glance */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
                <HeroMetric
                  label="Requests"
                  value={formatInteger(dataForCurrentProvider.metrics.requests)}
                  accentColor="var(--color-primary)"
                />
                <HeroMetric
                  label="Total Cost"
                  value={formatCost(dataForCurrentProvider.metrics.totalCost)}
                  accentColor="var(--color-success)"
                />
                <HeroMetric
                  label="Success Rate"
                  value={formatPercent(dataForCurrentProvider.metrics.successRate * 100)}
                  accentColor="var(--color-info)"
                />
              </div>

              {/* Performance section */}
              <Card title="Performance" className="mb-4" dense>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3">
                  <SectionMetric label="Avg Latency" value={formatMs(dataForCurrentProvider.metrics.avgLatencyMs)} />
                  <SectionMetric label="Avg TTFT" value={formatMs(dataForCurrentProvider.metrics.avgTtftMs)} />
                  <SectionMetric label="Throughput" value={`${formatTPS(dataForCurrentProvider.metrics.avgThroughputTps)} tok/s`} />
                  <SectionMetric label="E2E TPS" value={`${formatTPS(dataForCurrentProvider.metrics.avgE2eTps)} tok/s`} />
                  <SectionMetric label="Cache Hit Rate" value={formatPercent(dataForCurrentProvider.metrics.cacheHitRate * 100)} />
                </div>
              </Card>

              {/* Token breakdown section */}
              <Card title="Tokens" className="mb-4" dense>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3">
                  <SectionMetric label="Total" value={formatNumber(dataForCurrentProvider.metrics.totalTokens, 1)} />
                  <SectionMetric label="Input" value={formatNumber(dataForCurrentProvider.metrics.inputTokens, 1)} />
                  <SectionMetric label="Output" value={formatNumber(dataForCurrentProvider.metrics.outputTokens, 1)} />
                  <SectionMetric label="Reasoning" value={formatNumber(dataForCurrentProvider.metrics.reasoningTokens, 1)} />
                  <SectionMetric label="Cached" value={formatNumber(dataForCurrentProvider.metrics.cachedTokens, 1)} />
                  <SectionMetric label="Cache Write" value={formatNumber(dataForCurrentProvider.metrics.cacheWriteTokens, 1)} />
                </div>
              </Card>

              {/* Cost details section */}
              <Card title="Cost Details" className="mb-6" dense>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3">
                  <SectionMetric label="Cost per Request" value={formatCost(dataForCurrentProvider.metrics.costPerRequest)} />
                  <SectionMetric label="Cost per 1M Tokens" value={formatCost(dataForCurrentProvider.metrics.costPerMillionTokens)} />
                  <SectionMetric label="Provider-Reported Cost" value={formatCost(dataForCurrentProvider.metrics.providerReportedCost)} />
                  <SectionMetric label="Calculated Cost" value={formatCost(dataForCurrentProvider.metrics.calculatedCost)} />
                  <SectionMetric label="Failover Requests" value={formatInteger(dataForCurrentProvider.metrics.failoverRequests)} />
                  <SectionMetric label="Streamed Requests" value={formatNumber(dataForCurrentProvider.metrics.streamedRequests, 0)} />
                  <SectionMetric label="Non-Streamed" value={formatNumber(dataForCurrentProvider.metrics.nonStreamedRequests, 0)} />
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

              {/* ---- Model collapsible sections ---- */}
              {dataForCurrentProvider.models.length > 0 && (
                <div className="space-y-3 mb-6">
                  <h3 className="font-heading text-sm font-semibold text-text px-1">Models</h3>
                  {dataForCurrentProvider.models.map((model, mIdx) => (
                    <ModelSection
                      key={`${model.canonicalModelName ?? ''}:${model.selectedModelName ?? ''}:${mIdx}`}
                      model={model}
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
    {/* Model section skeleton */}
    <Card>
      <Skeleton height={16} width="30%" className="mb-3" />
      <Skeleton height={60} className="mb-2" />
      <Skeleton height={60} />
    </Card>
  </>
);

/** Collapsible model section with summary header and per-alias table. */
const ModelSection: React.FC<{
  model: ProviderInsightModel;
}> = ({ model }) => {
  const displayName = modelDisplayName(model.canonicalModelName, model.selectedModelName);
  const summaryText = [
    `${formatInteger(model.metrics.requests)} requests`,
    `${formatNumber(model.metrics.totalTokens, 1)} tokens`,
    formatCost(model.metrics.totalCost),
  ].join(' \u00b7 ');

  const extra = (
    <span className="text-xs text-text-muted">
      {formatPercent(model.metrics.successRate * 100)} success
    </span>
  );

  return (
    <Disclosure
      title={
        <span className="flex items-center gap-2">
          <span className="font-medium">{displayName}</span>
          <span className="text-xs text-text-muted font-normal">{summaryText}</span>
        </span>
      }
      extra={extra}
      defaultOpen={false}
    >
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3 mb-4">
        <ModelMetric label="Requests" value={formatInteger(model.metrics.requests)} />
        <ModelMetric label="Total Tokens" value={formatNumber(model.metrics.totalTokens, 1)} />
        <ModelMetric label="Cost" value={formatCost(model.metrics.totalCost)} />
        <ModelMetric label="Avg TTFT" value={formatMs(model.metrics.avgTtftMs)} />
        <ModelMetric
          label="Throughput"
          value={`${formatTPS(model.metrics.avgThroughputTps)} tok/s`}
        />
        <ModelMetric label="E2E TPS" value={`${formatTPS(model.metrics.avgE2eTps)} tok/s`} />
      </div>

      {model.aliases.length > 0 && <ModelAliasTable aliases={model.aliases} />}
    </Disclosure>
  );
};

const ModelMetric: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <div className="text-[10px] uppercase tracking-wider text-text-muted font-medium mb-0.5">
      {label}
    </div>
    <div className="text-xs font-semibold text-text truncate" title={value}>
      {value}
    </div>
  </div>
);

const ModelAliasTable: React.FC<{
  aliases: ProviderInsightModelAlias[];
}> = ({ aliases }) => {
  const columns: ResponsiveTableColumn<ProviderInsightModelAlias>[] = useMemo(
    () => [
      {
        key: 'alias',
        header: 'Incoming Alias',
        mobileTitle: true,
        priority: 'high',
        render: (row) => {
          const display = row.incomingModelAlias ?? '—';
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
    []
  );

  return (
    <ResponsiveTable
      columns={columns}
      data={aliases}
      getRowKey={(row, idx) => `${row.incomingModelAlias ?? ''}:${idx}`}
    />
  );
};
