/**
 * Model Insights domain types, API client, and helpers.
 *
 * Consumes the canonical backend endpoint:
 *   GET /v0/management/model-insights?model=<alias>&range=1h|5h|24h|7d|30d
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported API range keys. */
export type ModelInsightRangeKey = '1h' | '5h' | '24h' | '7d' | '30d';

/** UI timeline label -> API range key mapping. */
export const TIMELINE_OPTIONS: ReadonlyArray<{
  label: string;
  key: ModelInsightRangeKey;
}> = [
  { label: '1hr', key: '1h' },
  { label: '5h', key: '5h' },
  { label: '24h', key: '24h' },
  { label: '7d', key: '7d' },
  { label: '30d', key: '30d' },
];

export const DEFAULT_RANGE_KEY: ModelInsightRangeKey = '24h';

export interface ModelInsightRangeMeta {
  key: ModelInsightRangeKey;
  label: string;
  startTimeMs: number;
  endTimeMs: number;
  bucketSizeMs: number;
}

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

export interface ModelInsightSeriesBucket {
  bucketStartMs: number;
  metrics: ModelInsightMetrics;
}

export interface ModelInsightProviderModel {
  canonicalModelName: string | null;
  selectedModelName: string | null;
  finalAttemptProvider: string | null;
  finalAttemptModel: string | null;
  metrics: ModelInsightMetrics;
}

export interface ModelInsightProvider {
  provider: string;
  metrics: ModelInsightMetrics;
  models: ModelInsightProviderModel[];
}

export interface ModelInsightsResponse {
  model: string;
  range: ModelInsightRangeMeta;
  metrics: ModelInsightMetrics;
  series: ModelInsightSeriesBucket[];
  providers: ModelInsightProvider[];
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

const API_BASE = ''; // Proxied via server.ts

/**
 * Fetch model insights from the backend API.
 *
 * The `model` parameter is the raw alias id (not pre-encoded).
 * This function percent-encodes it for the query string.
 */
export async function fetchModelInsights(
  model: string,
  range: ModelInsightRangeKey,
  adminKey?: string,
): Promise<ModelInsightsResponse> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const key = adminKey ?? localStorage.getItem('plexus_admin_key') ?? '';
  if (key) {
    headers['x-admin-key'] = key;
  }

  const params = new URLSearchParams({
    model,
    range,
  });

  const url = `${API_BASE}/v0/management/model-insights?${params.toString()}`;
  const res = await fetch(url, { headers });

  if (res.status === 401) {
    localStorage.removeItem('plexus_admin_key');
    if (window.location.pathname !== '/ui/login') {
      window.location.href = '/ui/login';
    }
    throw new Error('Unauthorized');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as Record<string, unknown>).error
        ? String((body as Record<string, unknown>).error)
        : `Failed to fetch model insights (HTTP ${res.status})`,
    );
  }

  return (await res.json()) as ModelInsightsResponse;
}

// ---------------------------------------------------------------------------
// Route helpers
// ---------------------------------------------------------------------------

/**
 * Build the frontend path to a model's insights page.
 * Uses `encodeURIComponent` for robust encoding of special characters.
 */
export function modelInsightsPath(modelId: string): string {
  return `/models/${encodeURIComponent(modelId)}/insights`;
}
