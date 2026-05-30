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
  fetchModelInsights,
  TIMELINE_OPTIONS,
  DEFAULT_RANGE_KEY,
  type ModelInsightSeriesBucket,
  type ModelInsightsResponse,
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
  niceCountAxisMax,
  niceCountAxisTicks,
} from '../lib/format';

export const ModelInsights: React.FC = () => {
  const { modelId } = useParams<{ modelId: string }>();
  const navigate = useNavigate();

  const decodedModelId = modelId ?? '';

  const checkIsConfigured = useCallback(async (alias: string) => {
    const aliases = await api.getAliases();
    const allIds = new Set<string>();
    for (const a of aliases) {
      allIds.add(a.id);
      if (a.aliases) {
        for (const alt of a.aliases) {
          if (alt) allIds.add(alt);
        }
      }
    }
    return allIds.has(alias);
  }, []);

  const fetchInsights = useCallback(
    (alias: string, range: Parameters<typeof fetchModelInsights>[1]) =>
      fetchModelInsights(alias, range),
    []
  );

  const {
    activeRange,
    handleRangeSelect,
    isConfiguredForCurrentEntity: isConfiguredForCurrentAlias,
    isLoadingCurrentEntity: isLoadingCurrentAlias,
    errorForCurrentEntity: errorForCurrentAlias,
    dataForCurrentEntity: dataForCurrentAlias,
    handleRetry,
  } = useInsightsPage<ModelInsightsResponse>({
    entityId: decodedModelId,
    defaultRangeKey: DEFAULT_RANGE_KEY,
    checkIsConfigured,
    fetchInsights,
  });

  const handleBackToModels = () => {
    navigate('/models');
  };

  const isEmpty =
    dataForCurrentAlias !== null &&
    dataForCurrentAlias.metrics.requests === 0 &&
    dataForCurrentAlias.providers.length === 0;

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
        {isLoadingCurrentAlias && <LoadingSkeleton />}

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

        {!isLoadingCurrentAlias &&
          !errorForCurrentAlias &&
          dataForCurrentAlias &&
          !isEmpty &&
          isConfiguredForCurrentAlias === true && (
            <>
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

              <Card title="Performance" className="mb-4" dense>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3">
                  <SectionMetric label="Success Rate" value={formatPercent(dataForCurrentAlias.metrics.successRate * 100)} />
                  <SectionMetric label="Avg TTFT" value={formatMs(dataForCurrentAlias.metrics.avgTtftMs)} />
                  <SectionMetric label="Throughput" value={`${formatTPS(dataForCurrentAlias.metrics.avgThroughputTps)} tok/s`} />
                  <SectionMetric label="E2E TPS" value={`${formatTPS(dataForCurrentAlias.metrics.avgE2eTps)} tok/s`} />
                  <SectionMetric label="Cache Hit Rate" value={formatPercent(dataForCurrentAlias.metrics.cacheHitRate * 100)} />
                </div>
              </Card>

              <Card title="Tokens" className="mb-4" dense>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3">
                  <SectionMetric label="Total" value={formatInteger(dataForCurrentAlias.metrics.totalTokens)} />
                  <SectionMetric label="Input" value={formatInteger(dataForCurrentAlias.metrics.inputTokens)} />
                  <SectionMetric label="Output" value={formatInteger(dataForCurrentAlias.metrics.outputTokens)} />
                  <SectionMetric label="Reasoning" value={formatInteger(dataForCurrentAlias.metrics.reasoningTokens)} />
                  <SectionMetric label="Cached" value={formatInteger(dataForCurrentAlias.metrics.cachedTokens)} />
                  <SectionMetric label="Cache Write" value={formatInteger(dataForCurrentAlias.metrics.cacheWriteTokens)} />
                </div>
              </Card>

              <Card title="Cost Details" className="mb-6" dense>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3">
                  <SectionMetric label="Cost per Request" value={formatCost(dataForCurrentAlias.metrics.costPerRequest)} />
                  <SectionMetric label="Cost per 1M Tokens" value={formatCost(dataForCurrentAlias.metrics.costPerMillionTokens)} />
                  <SectionMetric label="Streamed Requests" value={formatNumber(dataForCurrentAlias.metrics.streamedRequests, 0)} />
                  <SectionMetric label="Non-Streamed" value={formatNumber(dataForCurrentAlias.metrics.nonStreamedRequests, 0)} />
                </div>
              </Card>

              {chartData.length > 0 && (
                <InsightsTimeSeriesCharts
                  chartData={chartData}
                  requestsChartAxis={requestsChartAxis}
                  rangeKey={dataForCurrentAlias.range.key}
                />
              )}

              {dataForCurrentAlias.providers.length > 0 && (
                <div className="space-y-3 mb-6">
                  <h3 className="font-heading text-sm font-semibold text-text px-1">Providers</h3>
                  {dataForCurrentAlias.providers.map((provider, pIdx) => (
                    <ProviderSection
                      key={`${provider.provider}:${pIdx}`}
                      provider={provider}
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

function providerDisplayName(provider: string | null): string {
  return provider ?? '(unknown)';
}

const ProviderSection: React.FC<{
  provider: ModelInsightProvider;
}> = ({ provider }) => {
  const displayName = providerDisplayName(provider.provider);
  const summaryText = [
    `${formatInteger(provider.metrics.requests)} requests`,
    `${formatInteger(provider.metrics.totalTokens)} tokens`,
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
          <span className="font-medium">{displayName}</span>
          <span className="text-xs text-text-muted font-normal">{summaryText}</span>
        </span>
      }
      extra={extra}
      defaultOpen={false}
    >
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3 mb-4">
        <ProviderMetric label="Requests" value={formatInteger(provider.metrics.requests)} />
        <ProviderMetric
          label="Total Tokens"
          value={formatInteger(provider.metrics.totalTokens)}
        />
        <ProviderMetric label="Cost" value={formatCost(provider.metrics.totalCost)} />
        <ProviderMetric label="Avg TTFT" value={formatMs(provider.metrics.avgTtftMs)} />
        <ProviderMetric
          label="Throughput"
          value={`${formatTPS(provider.metrics.avgThroughputTps)} tok/s`}
        />
        <ProviderMetric label="E2E TPS" value={`${formatTPS(provider.metrics.avgE2eTps)} tok/s`} />
      </div>

      {provider.models.length > 0 && (
        <ProviderModelTable models={provider.models} providerName={displayName} />
      )}
    </Disclosure>
  );
};

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
        key: 'upstream',
        header: 'Upstream',
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
        render: (row) => formatInteger(row.metrics.totalTokens),
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
