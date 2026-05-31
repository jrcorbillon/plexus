/**
 * Provider Insights domain types, API client, and helpers.
 *
 * Consumes the canonical backend endpoint:
 *   GET /v0/management/provider-insights?provider=<id>&range=1h|5h|24h|7d|30d
 */

import {
  TIMELINE_OPTIONS,
  DEFAULT_RANGE_KEY,
  type ModelInsightRangeKey,
  type ModelInsightRangeMeta,
  type ModelInsightMetrics,
  type ModelInsightSeriesBucket,
  type InsightsRangeSelection,
} from './model-insights';

export type { InsightsRangeSelection };

export type ProviderInsightRangeKey = ModelInsightRangeKey;
export { TIMELINE_OPTIONS, DEFAULT_RANGE_KEY };
export type ProviderInsightRangeMeta = ModelInsightRangeMeta;
export type ProviderInsightMetrics = ModelInsightMetrics;
export type ProviderInsightSeriesBucket = ModelInsightSeriesBucket;

export interface ProviderInsightModelAlias {
  incomingModelAlias: string | null;
  metrics: ProviderInsightMetrics;
}

export interface ProviderInsightModel {
  canonicalModelName: string | null;
  selectedModelName: string | null;
  metrics: ProviderInsightMetrics;
  aliases: ProviderInsightModelAlias[];
}

export interface ProviderInsightsResponse {
  provider: string;
  range: ProviderInsightRangeMeta;
  metrics: ProviderInsightMetrics;
  series: ProviderInsightSeriesBucket[];
  models: ProviderInsightModel[];
}

const API_BASE = '';

export async function fetchProviderInsights(
  provider: string,
  selection: InsightsRangeSelection,
  adminKey?: string
): Promise<ProviderInsightsResponse> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const key = adminKey ?? localStorage.getItem('plexus_admin_key') ?? '';
  if (key) {
    headers['x-admin-key'] = key;
  }

  const params = new URLSearchParams({ provider });
  if (selection.kind === 'preset') {
    params.set('range', selection.key);
  } else {
    params.set('startTime', String(selection.startMs));
    params.set('endTime', String(selection.endMs));
  }
  const url = `${API_BASE}/v0/management/provider-insights?${params.toString()}`;
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
        : `Failed to fetch provider insights (HTTP ${res.status})`
    );
  }

  return (await res.json()) as ProviderInsightsResponse;
}

export function providerInsightsPath(providerId: string): string {
  return `/providers/${encodeURIComponent(providerId)}/insights`;
}

export function modelDisplayName(
  canonical: string | null,
  selected: string | null
): string {
  return canonical ?? selected ?? 'Unknown';
}
