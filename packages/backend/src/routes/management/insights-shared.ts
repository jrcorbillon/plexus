// ---------------------------------------------------------------------------
// Range configuration
// ---------------------------------------------------------------------------

export type InsightRangeKey = '1h' | '5h' | '24h' | '7d' | '30d';

export const RANGE_DURATIONS_MS: Record<InsightRangeKey, number> = {
  '1h': 60 * 60 * 1000,
  '5h': 5 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

export const RANGE_LABELS: Record<InsightRangeKey, string> = {
  '1h': '1hr',
  '5h': '5h',
  '24h': '24h',
  '7d': '7d',
  '30d': '30d',
};

export const RANGE_BUCKET_SIZES_MS: Record<InsightRangeKey, number> = {
  '1h': 5 * 60 * 1000,
  '5h': 15 * 60 * 1000,
  '24h': 60 * 60 * 1000,
  '7d': 6 * 60 * 60 * 1000,
  '30d': 24 * 60 * 60 * 1000,
};

export const SUPPORTED_RANGE_KEYS = new Set<string>(['1h', '5h', '24h', '7d', '30d']);

export interface InsightRangeMeta {
  key: InsightRangeKey;
  label: string;
  startTimeMs: number;
  endTimeMs: number;
  bucketSizeMs: number;
}

export type InsightsFilterParam = 'model' | 'provider';

export interface InsightsValidationError {
  message: string;
  type: 'validation_error';
  code: 400;
}

export type ParseInsightsQueryResult =
  | { ok: true; filterValue: string; rangeResult: InsightRangeMeta }
  | { ok: false; error: InsightsValidationError };

export function parseInsightsQuery(
  query: Record<string, string | string[] | undefined>,
  filterParam: InsightsFilterParam
): ParseInsightsQueryResult {
  if (Array.isArray(query[filterParam])) {
    return {
      ok: false,
      error: {
        message: `Duplicate "${filterParam}" parameter is not allowed`,
        type: 'validation_error',
        code: 400,
      },
    };
  }
  if (Array.isArray(query.range)) {
    return {
      ok: false,
      error: {
        message: 'Duplicate "range" parameter is not allowed',
        type: 'validation_error',
        code: 400,
      },
    };
  }

  const filterValue = query[filterParam];
  const rangeKey = query.range ?? '24h';

  if (!filterValue || filterValue.trim() === '') {
    return {
      ok: false,
      error: {
        message: `The "${filterParam}" query parameter is required and must be non-empty`,
        type: 'validation_error',
        code: 400,
      },
    };
  }

  if (filterValue !== filterValue.trim()) {
    return {
      ok: false,
      error: {
        message: `The "${filterParam}" query parameter must not contain leading or trailing whitespace`,
        type: 'validation_error',
        code: 400,
      },
    };
  }

  const rangeResult = resolveInsightRange(rangeKey);
  if ('error' in rangeResult) {
    return {
      ok: false,
      error: {
        message: rangeResult.error,
        type: 'validation_error',
        code: 400,
      },
    };
  }

  return { ok: true, filterValue, rangeResult };
}

export interface InsightsResponseBody {
  range: InsightRangeMeta;
  metrics: ModelInsightMetrics;
  series: SeriesBucket[];
}

export function buildInsightsResponse(
  rows: RawRow[],
  rangeResult: InsightRangeMeta
): InsightsResponseBody {
  return {
    range: rangeResult,
    metrics: computeMetrics(rows),
    series: buildSeries(
      rows,
      rangeResult.startTimeMs,
      rangeResult.endTimeMs,
      rangeResult.bucketSizeMs
    ),
  };
}

export function resolveInsightRange(rangeKey: string): InsightRangeMeta | { error: string } {
  if (!SUPPORTED_RANGE_KEYS.has(rangeKey)) {
    return {
      error: `Unsupported range "${rangeKey}". Supported values: 1h, 5h, 24h, 7d, 30d`,
    };
  }
  const typedRangeKey = rangeKey as InsightRangeKey;
  const nowMs = Date.now();
  const durationMs = RANGE_DURATIONS_MS[typedRangeKey];
  const startTimeMs = nowMs - durationMs;
  const endTimeMs = nowMs;
  const bucketSizeMs = RANGE_BUCKET_SIZES_MS[typedRangeKey];
  return {
    key: typedRangeKey,
    label: RANGE_LABELS[typedRangeKey],
    startTimeMs,
    endTimeMs,
    bucketSizeMs,
  };
}

// ---------------------------------------------------------------------------
// Metrics types
// ---------------------------------------------------------------------------

export interface StatusBreakdown {
  success: number;
  error: number;
  pending: number;
  other: number;
}

export interface ModelInsightMetrics {
  requests: number;
  successfulRequests: number;
  errorRequests: number;
  pendingRequests: number;
  otherRequests: number;
  successRate: number;
  errorRate: number;
  pendingRate: number;
  otherRate: number;
  statusBreakdown: StatusBreakdown;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  totalCost: number;
  inputCost: number;
  outputCost: number;
  cachedCost: number;
  cacheWriteCost: number;
  providerReportedCost: number;
  calculatedCost: number;
  providerReportedCostCount: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  avgTtftMs: number;
  p50TtftMs: number;
  p95TtftMs: number;
  p99TtftMs: number;
  avgThroughputTps: number;
  avgE2eTps: number;
  cacheHitRate: number;
  costPerRequest: number;
  costPerMillionTokens: number;
  streamedRequests: number;
  nonStreamedRequests: number;
  totalRetryAttempts: number;
  failoverRequests: number;
  avgAttempts: number;
  estimatedTokensCount: number;
  descriptorRequestCount: number;
  visionFallthroughCount: number;
}

function emptyMetrics(): ModelInsightMetrics {
  return {
    requests: 0,
    successfulRequests: 0,
    errorRequests: 0,
    pendingRequests: 0,
    otherRequests: 0,
    successRate: 0,
    errorRate: 0,
    pendingRate: 0,
    otherRate: 0,
    statusBreakdown: { success: 0, error: 0, pending: 0, other: 0 },
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    totalCost: 0,
    inputCost: 0,
    outputCost: 0,
    cachedCost: 0,
    cacheWriteCost: 0,
    providerReportedCost: 0,
    calculatedCost: 0,
    providerReportedCostCount: 0,
    avgLatencyMs: 0,
    p50LatencyMs: 0,
    p95LatencyMs: 0,
    p99LatencyMs: 0,
    avgTtftMs: 0,
    p50TtftMs: 0,
    p95TtftMs: 0,
    p99TtftMs: 0,
    avgThroughputTps: 0,
    avgE2eTps: 0,
    cacheHitRate: 0,
    costPerRequest: 0,
    costPerMillionTokens: 0,
    streamedRequests: 0,
    nonStreamedRequests: 0,
    totalRetryAttempts: 0,
    failoverRequests: 0,
    avgAttempts: 0,
    estimatedTokensCount: 0,
    descriptorRequestCount: 0,
    visionFallthroughCount: 0,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (rank - lower);
}

export function detectCrossProviderFailover(row: RawRow): boolean {
  if (row.allAttemptedProviders) {
    let attempted: unknown[] | null = null;

    if (Array.isArray(row.allAttemptedProviders)) {
      attempted = row.allAttemptedProviders;
    } else if (typeof row.allAttemptedProviders === 'string') {
      try {
        attempted = JSON.parse(row.allAttemptedProviders);
      } catch {
        // fall through
      }
    }

    if (Array.isArray(attempted) && attempted.length > 0) {
      const distinctProviders = new Set(
        (attempted as unknown[])
          .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
          .map((entry: string) => entry.split('/')[0]!)
      );
      if (distinctProviders.size > 1) {
        return true;
      }
      return false;
    }
  }

  if (row.retryHistory) {
    try {
      const history: Array<{ provider?: string; model?: string; status?: string }> = JSON.parse(
        row.retryHistory
      );
      if (Array.isArray(history) && history.length > 0) {
        const retriedProviders = new Set(
          history
            .filter((h): h is { provider: string } => typeof h?.provider === 'string')
            .map((h) => h.provider)
        );
        const finalProvider = row.finalAttemptProvider || row.provider;
        if (finalProvider) {
          for (const retriedProvider of retriedProviders) {
            if (retriedProvider !== finalProvider) {
              return true;
            }
          }
        }
        if (retriedProviders.size > 1) {
          return true;
        }
        return false;
      }
    } catch {
      // fall through
    }
  }

  return false;
}

export interface RawRow {
  requestId: string;
  provider: string | null;
  incomingModelAlias?: string | null;
  canonicalModelName: string | null;
  selectedModelName: string | null;
  finalAttemptProvider: string | null;
  finalAttemptModel: string | null;
  allAttemptedProviders: string | string[] | null;
  attemptCount: number;
  retryHistory: string | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  tokensReasoning: number | null;
  tokensCached: number | null;
  tokensCacheWrite: number | null;
  costInput: number | null;
  costOutput: number | null;
  costCached: number | null;
  costCacheWrite: number | null;
  costTotal: number | null;
  costSource: string | null;
  durationMs: number | null;
  ttftMs: number | null;
  tokensPerSec: number | null;
  isStreamed: number;
  isPassthrough: number;
  responseStatus: string | null;
  startTime: number;
  providerReportedCost: number | null;
  tokensEstimated: number;
  isDescriptorRequest: number;
  isVisionFallthrough: number;
}

function toNum(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function computeMetrics(rows: RawRow[]): ModelInsightMetrics {
  const m = emptyMetrics();
  m.requests = rows.length;

  const durations: number[] = [];
  const ttfts: number[] = [];
  const tpsValues: number[] = [];
  const e2eTpsValues: number[] = [];
  let successfulMeasured = 0;
  let successfulWithCached = 0;
  let providerReportedCostSum = 0;
  let calculatedCostSum = 0;
  let providerReportedCount = 0;

  for (const row of rows) {
    const status = row.responseStatus;
    const isSuccess = status === 'success';
    const isPending = status === 'pending';
    const isError = status === 'error';

    if (isSuccess) {
      m.successfulRequests++;
      successfulMeasured++;
      if (toNum(row.tokensCached) > 0) {
        successfulWithCached++;
      }
    } else if (isPending) {
      m.pendingRequests++;
    } else if (isError) {
      m.errorRequests++;
    } else {
      m.otherRequests++;
    }

    m.inputTokens += toNum(row.tokensInput);
    m.outputTokens += toNum(row.tokensOutput);
    m.reasoningTokens += toNum(row.tokensReasoning);
    m.cachedTokens += toNum(row.tokensCached);
    m.cacheWriteTokens += toNum(row.tokensCacheWrite);

    m.totalCost += toNum(row.costTotal);
    m.inputCost += toNum(row.costInput);
    m.outputCost += toNum(row.costOutput);
    m.cachedCost += toNum(row.costCached);
    m.cacheWriteCost += toNum(row.costCacheWrite);

    if (row.costSource === 'provider_reported' && row.providerReportedCost != null) {
      providerReportedCostSum += toNum(row.providerReportedCost);
      providerReportedCount++;
    } else {
      calculatedCostSum += toNum(row.costTotal);
    }

    const dur = row.durationMs;
    if (dur != null && dur > 0 && !isPending) {
      durations.push(dur);
    }

    if (row.ttftMs != null && row.ttftMs > 0) {
      ttfts.push(row.ttftMs);
    }

    if (row.tokensPerSec != null && row.tokensPerSec > 0) {
      tpsValues.push(row.tokensPerSec);
    }

    if (dur != null && dur > 0 && !isPending) {
      const generated = toNum(row.tokensOutput) + toNum(row.tokensReasoning);
      if (generated > 0) {
        e2eTpsValues.push(generated / (dur / 1000));
      }
    }

    if (row.isStreamed) {
      m.streamedRequests++;
    } else {
      m.nonStreamedRequests++;
    }

    const attempts = toNum(row.attemptCount) || 1;
    m.totalRetryAttempts += Math.max(0, attempts - 1);

    if (attempts > 1) {
      const isFailover = detectCrossProviderFailover(row);
      if (isFailover) {
        m.failoverRequests++;
      }
    }

    if (row.tokensEstimated) {
      m.estimatedTokensCount++;
    }
    if (row.isDescriptorRequest) {
      m.descriptorRequestCount++;
    }
    if (row.isVisionFallthrough) {
      m.visionFallthroughCount++;
    }
  }

  m.totalTokens =
    m.inputTokens + m.outputTokens + m.reasoningTokens + m.cachedTokens + m.cacheWriteTokens;

  m.errorRequests = m.errorRequests + m.otherRequests;

  m.successRate = m.requests > 0 ? m.successfulRequests / m.requests : 0;
  m.errorRate = m.requests > 0 ? m.errorRequests / m.requests : 0;
  m.pendingRate = m.requests > 0 ? m.pendingRequests / m.requests : 0;
  m.otherRate = m.requests > 0 ? m.otherRequests / m.requests : 0;
  m.statusBreakdown = {
    success: m.successfulRequests,
    error: m.errorRequests - m.otherRequests,
    pending: m.pendingRequests,
    other: m.otherRequests,
  };

  m.cacheHitRate = successfulMeasured > 0 ? successfulWithCached / successfulMeasured : 0;

  m.costPerRequest = m.requests > 0 ? m.totalCost / m.requests : 0;
  m.costPerMillionTokens = m.totalTokens > 0 ? (m.totalCost / m.totalTokens) * 1_000_000 : 0;

  m.providerReportedCost = providerReportedCostSum;
  m.calculatedCost = calculatedCostSum;
  m.providerReportedCostCount = providerReportedCount;

  durations.sort((a, b) => a - b);
  m.avgLatencyMs =
    durations.length > 0 ? durations.reduce((s, v) => s + v, 0) / durations.length : 0;
  m.p50LatencyMs = percentile(durations, 50);
  m.p95LatencyMs = percentile(durations, 95);
  m.p99LatencyMs = percentile(durations, 99);

  ttfts.sort((a, b) => a - b);
  m.avgTtftMs = ttfts.length > 0 ? ttfts.reduce((s, v) => s + v, 0) / ttfts.length : 0;
  m.p50TtftMs = percentile(ttfts, 50);
  m.p95TtftMs = percentile(ttfts, 95);
  m.p99TtftMs = percentile(ttfts, 99);

  m.avgThroughputTps =
    tpsValues.length > 0 ? tpsValues.reduce((s, v) => s + v, 0) / tpsValues.length : 0;

  m.avgE2eTps =
    e2eTpsValues.length > 0 ? e2eTpsValues.reduce((s, v) => s + v, 0) / e2eTpsValues.length : 0;

  m.avgAttempts =
    m.requests > 0 ? rows.reduce((s, r) => s + (toNum(r.attemptCount) || 1), 0) / m.requests : 0;

  return m;
}

export interface SeriesBucket {
  bucketStartMs: number;
  metrics: ModelInsightMetrics;
}

export function buildSeries(
  rows: RawRow[],
  startTimeMs: number,
  _endTimeMs: number,
  bucketSizeMs: number
): SeriesBucket[] {
  if (rows.length === 0) return [];

  const bucketMap = new Map<number, RawRow[]>();

  for (const row of rows) {
    const offset = row.startTime - startTimeMs;
    const bucketIndex = Math.floor(offset / bucketSizeMs);
    const bucketStart = startTimeMs + bucketIndex * bucketSizeMs;
    if (!bucketMap.has(bucketStart)) {
      bucketMap.set(bucketStart, []);
    }
    bucketMap.get(bucketStart)!.push(row);
  }

  const buckets: SeriesBucket[] = [];
  const sortedKeys = [...bucketMap.keys()].sort((a, b) => a - b);

  for (const bucketStart of sortedKeys) {
    const bucketRows = bucketMap.get(bucketStart)!;
    buckets.push({
      bucketStartMs: bucketStart,
      metrics: computeMetrics(bucketRows),
    });
  }

  return buckets;
}

const MISSING_STRING_SENTINEL = Symbol('missing-string-value');

type StringMapKey = string | typeof MISSING_STRING_SENTINEL;

function toStringMapKey(value: string | null | undefined): StringMapKey {
  return value ?? MISSING_STRING_SENTINEL;
}

function fromStringMapKey(key: StringMapKey): string | null {
  return key === MISSING_STRING_SENTINEL ? null : key;
}

export interface ProviderModelGroup {
  provider: string | null;
  metrics: ModelInsightMetrics;
  models: Array<{
    canonicalModelName: string | null;
    selectedModelName: string | null;
    finalAttemptProvider: string | null;
    finalAttemptModel: string | null;
    metrics: ModelInsightMetrics;
  }>;
}

export function groupByProvider(rows: RawRow[]): ProviderModelGroup[] {
  const providerMap = new Map<StringMapKey, { rows: RawRow[]; models: Map<string, RawRow[]> }>();

  for (const row of rows) {
    const providerKey = toStringMapKey(row.provider);
    if (!providerMap.has(providerKey)) {
      providerMap.set(providerKey, { rows: [], models: new Map() });
    }
    const pGroup = providerMap.get(providerKey)!;
    pGroup.rows.push(row);

    const modelKey = `${row.canonicalModelName ?? ''}\0${row.selectedModelName ?? ''}\0${row.finalAttemptProvider ?? ''}\0${row.finalAttemptModel ?? ''}`;
    if (!pGroup.models.has(modelKey)) {
      pGroup.models.set(modelKey, []);
    }
    pGroup.models.get(modelKey)!.push(row);
  }

  const providers: ProviderModelGroup[] = [];
  for (const [providerKey, group] of providerMap) {
    const modelEntries: ProviderModelGroup['models'] = [];
    for (const [, modelRows] of group.models) {
      const first = modelRows[0]!;
      modelEntries.push({
        canonicalModelName: first.canonicalModelName,
        selectedModelName: first.selectedModelName,
        finalAttemptProvider: first.finalAttemptProvider,
        finalAttemptModel: first.finalAttemptModel,
        metrics: computeMetrics(modelRows),
      });
    }
    modelEntries.sort((a, b) => {
      const reqDiff = b.metrics.requests - a.metrics.requests;
      if (reqDiff !== 0) return reqDiff;
      return (a.canonicalModelName ?? '').localeCompare(b.canonicalModelName ?? '');
    });

    providers.push({
      provider: fromStringMapKey(providerKey),
      metrics: computeMetrics(group.rows),
      models: modelEntries,
    });
  }

  providers.sort((a, b) => {
    const reqDiff = b.metrics.requests - a.metrics.requests;
    if (reqDiff !== 0) return reqDiff;
    return (a.provider ?? '').localeCompare(b.provider ?? '');
  });

  return providers;
}

export interface ProviderInsightModelGroup {
  canonicalModelName: string | null;
  selectedModelName: string | null;
  metrics: ModelInsightMetrics;
  aliases: Array<{
    incomingModelAlias: string | null;
    metrics: ModelInsightMetrics;
  }>;
}

function modelGroupKey(row: RawRow): StringMapKey {
  const canonical = row.canonicalModelName ?? '';
  const selected = row.selectedModelName ?? '';
  if (canonical || selected) {
    return `${canonical}\0${selected}`;
  }
  return toStringMapKey(row.finalAttemptModel);
}

function modelDisplayName(canonical: string | null, selected: string | null): string {
  return canonical ?? selected ?? '(unknown)';
}

export function groupByModel(rows: RawRow[]): ProviderInsightModelGroup[] {
  const modelMap = new Map<
    StringMapKey,
    { rows: RawRow[]; aliases: Map<StringMapKey, RawRow[]> }
  >();

  for (const row of rows) {
    const modelKey = modelGroupKey(row);
    if (!modelMap.has(modelKey)) {
      modelMap.set(modelKey, { rows: [], aliases: new Map() });
    }
    const mGroup = modelMap.get(modelKey)!;
    mGroup.rows.push(row);

    const aliasKey = toStringMapKey(row.incomingModelAlias);
    if (!mGroup.aliases.has(aliasKey)) {
      mGroup.aliases.set(aliasKey, []);
    }
    mGroup.aliases.get(aliasKey)!.push(row);
  }

  const models: ProviderInsightModelGroup[] = [];
  for (const [, group] of modelMap) {
    const first = group.rows[0]!;
    const aliasEntries: ProviderInsightModelGroup['aliases'] = [];
    for (const [aliasKey, aliasRows] of group.aliases) {
      aliasEntries.push({
        incomingModelAlias: fromStringMapKey(aliasKey),
        metrics: computeMetrics(aliasRows),
      });
    }
    aliasEntries.sort((a, b) => {
      const reqDiff = b.metrics.requests - a.metrics.requests;
      if (reqDiff !== 0) return reqDiff;
      return (a.incomingModelAlias ?? '').localeCompare(b.incomingModelAlias ?? '');
    });

    models.push({
      canonicalModelName: first.canonicalModelName,
      selectedModelName: first.selectedModelName,
      metrics: computeMetrics(group.rows),
      aliases: aliasEntries,
    });
  }

  models.sort((a, b) => {
    const reqDiff = b.metrics.requests - a.metrics.requests;
    if (reqDiff !== 0) return reqDiff;
    const aName = modelDisplayName(a.canonicalModelName, a.selectedModelName);
    const bName = modelDisplayName(b.canonicalModelName, b.selectedModelName);
    return aName.localeCompare(bName);
  });

  return models;
}
