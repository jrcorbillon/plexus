import React, { useCallback, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  ArrowLeft,
  BarChart3,
  RefreshCw,
  Activity,
  AlertTriangle,
} from 'lucide-react';
import { PageHeader } from '../components/layout/PageHeader';
import { PageContainer } from '../components/layout/PageContainer';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Disclosure } from '../components/ui/Disclosure';
import { ResponsiveTable, type ResponsiveTableColumn } from '../components/ui/ResponsiveTable';
import {
  formatBucketLabel,
  InsightsTimeSeriesCharts,
} from '../components/insights/insights-charts';
import { HeroMetric, SectionMetric, LoadingSkeleton } from '../components/insights/insights-metrics';
import { useInsightsPage } from '../hooks/useInsightsPage';
import {
  fetchProviderInsights,
  TIMELINE_OPTIONS,
  DEFAULT_RANGE_KEY,
  modelDisplayName,
  type ProviderInsightSeriesBucket,
  type ProviderInsightsResponse,
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
  niceCountAxisMax,
  niceCountAxisTicks,
} from '../lib/format';

export const ProviderInsights: React.FC = () => {
  const { providerId } = useParams<{ providerId: string }>();
  const navigate = useNavigate();

  const decodedProviderId = providerId ?? '';

  const checkIsConfigured = useCallback(async (id: string) => {
    const providers = await api.getProviders();
    return new Set(providers.map((p) => p.id)).has(id);
  }, []);

  const fetchInsights = useCallback(
    (id: string, range: Parameters<typeof fetchProviderInsights>[1]) =>
      fetchProviderInsights(id, range),
    []
  );

  const {
    activeRange,
    handleRangeSelect,
    isConfiguredForCurrentEntity: isConfiguredForCurrentProvider,
    isLoadingCurrentEntity: isLoadingCurrentProvider,
    errorForCurrentEntity: errorForCurrentProvider,
    dataForCurrentEntity: dataForCurrentProvider,
    handleRetry,
  } = useInsightsPage<ProviderInsightsResponse>({
    entityId: decodedProviderId,
    defaultRangeKey: DEFAULT_RANGE_KEY,
    checkIsConfigured,
    fetchInsights,
  });

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
        {isLoadingCurrentProvider && <LoadingSkeleton />}

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

        {!isLoadingCurrentProvider &&
          !errorForCurrentProvider &&
          dataForCurrentProvider &&
          !isEmpty &&
          isConfiguredForCurrentProvider === true && (
            <>
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

              <Card title="Performance" className="mb-4" dense>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3">
                  <SectionMetric label="Avg Latency" value={formatMs(dataForCurrentProvider.metrics.avgLatencyMs)} />
                  <SectionMetric label="Avg TTFT" value={formatMs(dataForCurrentProvider.metrics.avgTtftMs)} />
                  <SectionMetric label="Throughput" value={`${formatTPS(dataForCurrentProvider.metrics.avgThroughputTps)} tok/s`} />
                  <SectionMetric label="E2E TPS" value={`${formatTPS(dataForCurrentProvider.metrics.avgE2eTps)} tok/s`} />
                  <SectionMetric label="Cache Hit Rate" value={formatPercent(dataForCurrentProvider.metrics.cacheHitRate * 100)} />
                </div>
              </Card>

              <Card title="Tokens" className="mb-4" dense>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3">
                  <SectionMetric label="Total" value={formatInteger(dataForCurrentProvider.metrics.totalTokens)} />
                  <SectionMetric label="Input" value={formatInteger(dataForCurrentProvider.metrics.inputTokens)} />
                  <SectionMetric label="Output" value={formatInteger(dataForCurrentProvider.metrics.outputTokens)} />
                  <SectionMetric label="Reasoning" value={formatInteger(dataForCurrentProvider.metrics.reasoningTokens)} />
                  <SectionMetric label="Cached" value={formatInteger(dataForCurrentProvider.metrics.cachedTokens)} />
                  <SectionMetric label="Cache Write" value={formatInteger(dataForCurrentProvider.metrics.cacheWriteTokens)} />
                </div>
              </Card>

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

              {chartData.length > 0 && (
                <InsightsTimeSeriesCharts
                  chartData={chartData}
                  requestsChartAxis={requestsChartAxis}
                  rangeKey={dataForCurrentProvider.range.key}
                />
              )}

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

const ModelSection: React.FC<{
  model: ProviderInsightModel;
}> = ({ model }) => {
  const displayName = modelDisplayName(model.canonicalModelName, model.selectedModelName);
  const summaryText = [
    `${formatInteger(model.metrics.requests)} requests`,
    `${formatInteger(model.metrics.totalTokens)} tokens`,
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
        <ModelMetric label="Total Tokens" value={formatInteger(model.metrics.totalTokens)} />
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
