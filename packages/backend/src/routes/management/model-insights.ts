import { FastifyInstance } from 'fastify';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { getCurrentDialect, getSchema } from '../../db/client';
import { UsageStorageService } from '../../services/usage-storage';

// ---------------------------------------------------------------------------
// Range configuration
// ---------------------------------------------------------------------------

type RangeKey = '1h' | '5h' | '24h' | '7d' | '30d';

const RANGE_DURATIONS_MS: Record<RangeKey, number> = {
  '1h': 60 * 60 * 1000,
  '5h': 5 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

const RANGE_LABELS: Record<RangeKey, string> = {
  '1h': '1hr',
  '5h': '5h',
  '24h': '24h',
  '7d': '7d',
  '30d': '30d',
};

const RANGE_BUCKET_SIZES_MS: Record<RangeKey, number> = {
  '1h': 5 * 60 * 1000, // 5-minute buckets
  '5h': 15 * 60 * 1000, // 15-minute buckets
  '24h': 60 * 60 * 1000, // 1-hour buckets
  '7d': 6 * 60 * 60 * 1000, // 6-hour buckets
  '30d': 24 * 60 * 60 * 1000, // 1-day buckets
};

const SUPPORTED_RANGE_KEYS = new Set<string>(['1h', '5h', '24h', '7d', '30d']);

// ---------------------------------------------------------------------------
// Metrics types
// ---------------------------------------------------------------------------

interface StatusBreakdown {
  success: number;
  error: number;
  pending: number;
  other: number;
}

interface ModelInsightMetrics {
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

// ---------------------------------------------------------------------------
// Percentile helper (nearest-rank)
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (rank - lower);
}

// ---------------------------------------------------------------------------
// Cross-provider failover detection
// ---------------------------------------------------------------------------

/**
 * Determines whether a request row represents a cross-provider failover
 * (as opposed to a same-provider retry).
 *
 * Detection strategy (in order of priority):
 * 1. Normalize `allAttemptedProviders` — it may be a native string array
 *    (from the dispatcher's error/exhausted routingContext) or a JSON string.
 *    Check for distinct provider prefixes in the normalized array.
 * 2. If allAttemptedProviders is absent or non-parseable, inspect `retryHistory`
 *    (a JSON array of { provider, model, status } objects) and compare
 *    retried providers against `finalAttemptProvider` or the row's `provider`.
 * 3. If no metadata is available, returns false (cannot determine cross-provider).
 */
export function detectCrossProviderFailover(row: RawRow): boolean {
  // --- Strategy 1: allAttemptedProviders ---
  if (row.allAttemptedProviders) {
    // Normalize to a string array regardless of whether it's already a native
    // array or a JSON string.  The dispatcher stores a native array in the
    // error/exhausted routingContext path, which may be persisted directly.
    let attempted: unknown[] | null = null;

    if (Array.isArray(row.allAttemptedProviders)) {
      // Already a native array — use it directly.
      attempted = row.allAttemptedProviders;
    } else if (typeof row.allAttemptedProviders === 'string') {
      try {
        attempted = JSON.parse(row.allAttemptedProviders);
      } catch {
        // Not valid JSON — fall through to retryHistory fallback below.
        // Do NOT silently return false here; the row might still be cross-provider.
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
      // Valid array with only one provider → not cross-provider
      return false;
    }
  }

  // --- Strategy 2: retryHistory fallback ---
  // Failed/exhausted requests may have allAttemptedProviders absent but
  // still carry retryHistory with per-attempt provider information.
  if (row.retryHistory) {
    try {
      const history: Array<{ provider?: string; model?: string; status?: string }> = JSON.parse(
        row.retryHistory
      );
      if (Array.isArray(history) && history.length > 0) {
        // Collect all providers from retry history
        const retriedProviders = new Set(
          history
            .filter((h): h is { provider: string } => typeof h?.provider === 'string')
            .map((h) => h.provider)
        );
        // The final attempt provider is either finalAttemptProvider or the row's provider
        const finalProvider = row.finalAttemptProvider || row.provider;
        if (finalProvider) {
          // If any retried provider differs from the final provider, it's cross-provider
          for (const retriedProvider of retriedProviders) {
            if (retriedProvider !== finalProvider) {
              return true;
            }
          }
        }
        // Also check if retried history itself spans multiple providers
        if (retriedProviders.size > 1) {
          return true;
        }
        return false;
      }
    } catch {
      // retryHistory also not parseable — fall through
    }
  }

  // --- Strategy 3: insufficient metadata ---
  // attemptCount > 1 but no parseable provider metadata available.
  // We cannot determine cross-provider status, so do not count as failover.
  return false;
}

// ---------------------------------------------------------------------------
// Row aggregation
// ---------------------------------------------------------------------------

export interface RawRow {
  requestId: string;
  provider: string | null;
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
      // Any status that is not success/error/pending falls into "other"
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

    // Provider-reported vs calculated cost
    if (row.costSource === 'provider_reported' && row.providerReportedCost != null) {
      providerReportedCostSum += toNum(row.providerReportedCost);
      providerReportedCount++;
    } else {
      calculatedCostSum += toNum(row.costTotal);
    }

    // Latency (only completed requests with durationMs)
    const dur = row.durationMs;
    if (dur != null && dur > 0 && !isPending) {
      durations.push(dur);
    }

    // TTFT
    if (row.ttftMs != null && row.ttftMs > 0) {
      ttfts.push(row.ttftMs);
    }

    // Throughput TPS (provider-reported)
    if (row.tokensPerSec != null && row.tokensPerSec > 0) {
      tpsValues.push(row.tokensPerSec);
    }

    // E2E TPS: (output + reasoning) / (durationMs / 1000)
    if (dur != null && dur > 0 && !isPending) {
      const generated = toNum(row.tokensOutput) + toNum(row.tokensReasoning);
      if (generated > 0) {
        e2eTpsValues.push(generated / (dur / 1000));
      }
    }

    // Streaming
    if (row.isStreamed) {
      m.streamedRequests++;
    } else {
      m.nonStreamedRequests++;
    }

    // Retry/failover
    const attempts = toNum(row.attemptCount) || 1;
    m.totalRetryAttempts += Math.max(0, attempts - 1);

    // Count as failover only when cross-provider attempts occurred.
    // Strategy:
    // 1. Try allAttemptedProviders (JSON string array or comma-separated string)
    // 2. Fall back to retryHistory to check if retried providers differ from final
    // 3. If all metadata absent, we cannot determine cross-provider status
    if (attempts > 1) {
      const isFailover = detectCrossProviderFailover(row);
      if (isFailover) {
        m.failoverRequests++;
      }
    }

    // Estimated/descriptor/vision-fallthrough attribution
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

  // Legacy error compatibility: errorRequests counts exact "error" status PLUS
  // all non-success/non-pending terminal statuses (timeout, stall, cancelled,
  // rate_limited, and any other unknown terminal statuses). This preserves the
  // legacy contract where every non-success/non-pending request is an "error"
  // from the consumer's perspective, while statusBreakdown keeps fine-grained
  // counts with error and other as separate buckets.
  m.errorRequests = m.errorRequests + m.otherRequests;

  m.successRate = m.requests > 0 ? m.successfulRequests / m.requests : 0;
  m.errorRate = m.requests > 0 ? m.errorRequests / m.requests : 0;
  m.pendingRate = m.requests > 0 ? m.pendingRequests / m.requests : 0;
  m.otherRate = m.requests > 0 ? m.otherRequests / m.requests : 0;
  m.statusBreakdown = {
    success: m.successfulRequests,
    error: m.errorRequests - m.otherRequests, // fine-grained: only exact "error" status
    pending: m.pendingRequests,
    other: m.otherRequests,
  };

  m.cacheHitRate = successfulMeasured > 0 ? successfulWithCached / successfulMeasured : 0;

  m.costPerRequest = m.requests > 0 ? m.totalCost / m.requests : 0;
  m.costPerMillionTokens = m.totalTokens > 0 ? (m.totalCost / m.totalTokens) * 1_000_000 : 0;

  m.providerReportedCost = providerReportedCostSum;
  m.calculatedCost = calculatedCostSum;
  m.providerReportedCostCount = providerReportedCount;

  // Latency percentiles
  durations.sort((a, b) => a - b);
  m.avgLatencyMs =
    durations.length > 0 ? durations.reduce((s, v) => s + v, 0) / durations.length : 0;
  m.p50LatencyMs = percentile(durations, 50);
  m.p95LatencyMs = percentile(durations, 95);
  m.p99LatencyMs = percentile(durations, 99);

  // TTFT percentiles
  ttfts.sort((a, b) => a - b);
  m.avgTtftMs = ttfts.length > 0 ? ttfts.reduce((s, v) => s + v, 0) / ttfts.length : 0;
  m.p50TtftMs = percentile(ttfts, 50);
  m.p95TtftMs = percentile(ttfts, 95);
  m.p99TtftMs = percentile(ttfts, 99);

  // Throughput TPS
  m.avgThroughputTps =
    tpsValues.length > 0 ? tpsValues.reduce((s, v) => s + v, 0) / tpsValues.length : 0;

  // E2E TPS
  m.avgE2eTps =
    e2eTpsValues.length > 0 ? e2eTpsValues.reduce((s, v) => s + v, 0) / e2eTpsValues.length : 0;

  // Average attempts
  m.avgAttempts =
    m.requests > 0 ? rows.reduce((s, r) => s + (toNum(r.attemptCount) || 1), 0) / m.requests : 0;

  return m;
}

// ---------------------------------------------------------------------------
// Provider grouping
// ---------------------------------------------------------------------------

interface ProviderModelGroup {
  provider: string;
  metrics: ModelInsightMetrics;
  models: Array<{
    canonicalModelName: string | null;
    selectedModelName: string | null;
    finalAttemptProvider: string | null;
    finalAttemptModel: string | null;
    metrics: ModelInsightMetrics;
  }>;
}

function groupByProvider(rows: RawRow[]): ProviderModelGroup[] {
  // Group by (provider, canonicalModelName, selectedModelName)
  const providerMap = new Map<string, { rows: RawRow[]; models: Map<string, RawRow[]> }>();

  for (const row of rows) {
    const providerKey = row.provider ?? '(unknown)';
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
    // Sort models by descending request count, then stable name
    modelEntries.sort((a, b) => {
      const reqDiff = b.metrics.requests - a.metrics.requests;
      if (reqDiff !== 0) return reqDiff;
      return (a.canonicalModelName ?? '').localeCompare(b.canonicalModelName ?? '');
    });

    providers.push({
      provider: providerKey,
      metrics: computeMetrics(group.rows),
      models: modelEntries,
    });
  }

  // Sort providers by descending request count, then stable name
  providers.sort((a, b) => {
    const reqDiff = b.metrics.requests - a.metrics.requests;
    if (reqDiff !== 0) return reqDiff;
    return a.provider.localeCompare(b.provider);
  });

  return providers;
}

// ---------------------------------------------------------------------------
// Time series bucketing
// ---------------------------------------------------------------------------

interface SeriesBucket {
  bucketStartMs: number;
  metrics: ModelInsightMetrics;
}

function buildSeries(
  rows: RawRow[],
  startTimeMs: number,
  endTimeMs: number,
  bucketSizeMs: number
): SeriesBucket[] {
  if (rows.length === 0) return [];

  const bucketMap = new Map<number, RawRow[]>();

  for (const row of rows) {
    // Anchor bucket to startTimeMs: offset from startTimeMs, then round down to bucket boundary
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

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerModelInsightsRoutes(
  fastify: FastifyInstance,
  usageStorage: UsageStorageService
) {
  fastify.get('/v0/management/model-insights', async (request, reply) => {
    const query = request.query as Record<string, string | string[] | undefined>;

    // --- Parameter validation ---

    // Handle duplicate parameters (arrays)
    if (Array.isArray(query.model)) {
      return reply.code(400).send({
        error: {
          message: 'Duplicate "model" parameter is not allowed',
          type: 'validation_error',
          code: 400,
        },
      });
    }
    if (Array.isArray(query.range)) {
      return reply.code(400).send({
        error: {
          message: 'Duplicate "range" parameter is not allowed',
          type: 'validation_error',
          code: 400,
        },
      });
    }

    const model = query.model;
    const rangeKey = query.range ?? '24h'; // default range

    // Validate model
    if (!model || model.trim() === '') {
      return reply.code(400).send({
        error: {
          message: 'The "model" query parameter is required and must be non-empty',
          type: 'validation_error',
          code: 400,
        },
      });
    }

    // Reject whitespace-padded model values (leading/trailing whitespace)
    if (model !== model.trim()) {
      return reply.code(400).send({
        error: {
          message: 'The "model" query parameter must not contain leading or trailing whitespace',
          type: 'validation_error',
          code: 400,
        },
      });
    }

    // Validate range
    if (!SUPPORTED_RANGE_KEYS.has(rangeKey)) {
      return reply.code(400).send({
        error: {
          message: `Unsupported range "${rangeKey}". Supported values: 1h, 5h, 24h, 7d, 30d`,
          type: 'validation_error',
          code: 400,
        },
      });
    }

    const typedRangeKey = rangeKey as RangeKey;

    // --- Compute range boundaries ---
    const nowMs = Date.now();
    const durationMs = RANGE_DURATIONS_MS[typedRangeKey];
    const startTimeMs = nowMs - durationMs;
    const endTimeMs = nowMs;
    const bucketSizeMs = RANGE_BUCKET_SIZES_MS[typedRangeKey];

    // --- Query request_usage ---
    const db = usageStorage.getDb();
    const schema = getSchema();
    const dialect = getCurrentDialect();

    const rows = (await db
      .select()
      .from(schema.requestUsage)
      .where(
        and(
          eq(schema.requestUsage.incomingModelAlias, model),
          gte(schema.requestUsage.startTime, startTimeMs),
          lte(schema.requestUsage.startTime, endTimeMs)
        )
      )) as RawRow[];

    // --- Compute response ---
    const metrics = computeMetrics(rows);
    const series = buildSeries(rows, startTimeMs, endTimeMs, bucketSizeMs);
    const providers = groupByProvider(rows);

    return reply.send({
      model,
      range: {
        key: typedRangeKey,
        label: RANGE_LABELS[typedRangeKey],
        startTimeMs,
        endTimeMs,
        bucketSizeMs,
      },
      metrics,
      series,
      providers,
    });
  });
}
