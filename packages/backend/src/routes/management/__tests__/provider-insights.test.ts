import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { setConfigForTesting } from '../../../config';
import { registerManagementRoutes } from '../../management';
import { UsageStorageService } from '../../../services/usage-storage';
import { Dispatcher } from '../../../services/dispatcher';
import { ProbeService } from '../../../services/probe-service';
import { closeDatabase, getDatabase, getSchema, initializeDatabase } from '../../../db/client';
import { runMigrations } from '../../../db/migrate';
import {
  groupByModel,
  groupByProvider,
  computeMetrics,
  deriveBucketSizeMs,
  resolveCustomRange,
  type RawRow,
} from '../insights-shared';

const ADMIN_KEY = 'test-admin-key';

const BASE_CONFIG = {
  providers: {},
  models: {},
  keys: {
    'limited-key': {
      secret: 'sk-limited-secret',
      comment: 'Limited Key',
    },
  },
  failover: {
    enabled: false,
    retryableStatusCodes: [429, 500, 502, 503, 504],
    retryableErrors: ['ECONNREFUSED', 'ETIMEDOUT'],
  },
  quotas: [],
};

function makeMockDispatcher() {
  return {
    dispatch: async () => ({
      id: 'test-id',
      model: 'test-model',
      created: Date.now(),
      content: 'ok',
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }),
  } as unknown as Dispatcher;
}

function makeMockProbeService() {
  return {
    runProbe: async () => ({
      success: true,
      durationMs: 0,
      apiType: 'chat' as const,
      response: 'ok',
    }),
  } as unknown as ProbeService;
}

function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now();
  return {
    requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
    date: new Date(now).toISOString(),
    startTime: now,
    durationMs: 100,
    isStreamed: 0,
    isPassthrough: 0,
    tokensEstimated: 0,
    createdAt: now,
    attemptCount: 1,
    responseStatus: 'success',
    incomingModelAlias: 'insight-alias',
    provider: 'provider-a',
    ...overrides,
  };
}

function makeRawRow(overrides: Partial<RawRow> = {}): RawRow {
  const now = Date.now();
  return {
    requestId: 'req-1',
    provider: 'provider-a',
    incomingModelAlias: 'alias-a',
    canonicalModelName: 'gpt-4',
    selectedModelName: null,
    finalAttemptProvider: 'provider-a',
    finalAttemptModel: 'gpt-4',
    allAttemptedProviders: null,
    attemptCount: 1,
    retryHistory: null,
    tokensInput: 100,
    tokensOutput: 50,
    tokensReasoning: 0,
    tokensCached: 0,
    tokensCacheWrite: 0,
    costInput: null,
    costOutput: null,
    costCached: null,
    costCacheWrite: null,
    costTotal: 0.01,
    costSource: null,
    durationMs: 200,
    ttftMs: 50,
    tokensPerSec: 25,
    isStreamed: 0,
    isPassthrough: 0,
    responseStatus: 'success',
    startTime: now,
    providerReportedCost: null,
    tokensEstimated: 0,
    isDescriptorRequest: 0,
    isVisionFallthrough: 0,
    ...overrides,
  };
}

describe('resolveCustomRange', () => {
  it('returns custom range meta with auto-derived bucket size', () => {
    const startMs = 1_700_000_000_000;
    const endMs = startMs + 3 * 24 * 60 * 60 * 1000;
    const result = resolveCustomRange(startMs, endMs);
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.key).toBe('custom');
    expect(result.label).toBe('Custom');
    expect(result.startTimeMs).toBe(startMs);
    expect(result.endTimeMs).toBe(endMs);
    expect(result.bucketSizeMs).toBe(6 * 60 * 60 * 1000);
  });

  it('rejects start >= end', () => {
    const result = resolveCustomRange(1000, 1000);
    expect('error' in result).toBe(true);
  });

  it('rejects non-finite timestamps', () => {
    expect('error' in resolveCustomRange(Number.NaN, 2000)).toBe(true);
    expect('error' in resolveCustomRange(1000, Number.NaN)).toBe(true);
  });
});

describe('deriveBucketSizeMs', () => {
  it('targets at most 48 buckets for short ranges', () => {
    const oneHour = 60 * 60 * 1000;
    expect(deriveBucketSizeMs(oneHour)).toBe(5 * 60 * 1000);
  });
});

describe('groupByModel', () => {
  it('groups rows by model with per-alias breakdown', () => {
    const rows: RawRow[] = [
      makeRawRow({
        requestId: 'r1',
        incomingModelAlias: 'alias-a',
        canonicalModelName: 'gpt-4',
        tokensInput: 100,
      }),
      makeRawRow({
        requestId: 'r2',
        incomingModelAlias: 'alias-b',
        canonicalModelName: 'gpt-4',
        tokensInput: 200,
      }),
      makeRawRow({
        requestId: 'r3',
        incomingModelAlias: 'alias-a',
        canonicalModelName: 'claude-3',
        selectedModelName: 'claude-3-opus',
        tokensInput: 50,
      }),
    ];

    const models = groupByModel(rows);
    expect(models).toHaveLength(2);

    const gpt4 = models.find((m) => m.canonicalModelName === 'gpt-4');
    expect(gpt4).toBeDefined();
    expect(gpt4!.metrics.requests).toBe(2);
    expect(gpt4!.aliases).toHaveLength(2);
    expect(gpt4!.aliases[0]!.metrics.requests).toBe(1);

    const claude = models.find((m) => m.canonicalModelName === 'claude-3');
    expect(claude).toBeDefined();
    expect(claude!.metrics.requests).toBe(1);
    expect(claude!.aliases).toHaveLength(1);
    expect(claude!.aliases[0]!.incomingModelAlias).toBe('alias-a');
  });

  it('sorts models by descending request count', () => {
    const rows: RawRow[] = [
      makeRawRow({ requestId: 'r1', canonicalModelName: 'small', tokensInput: 10 }),
      makeRawRow({ requestId: 'r2', canonicalModelName: 'big', tokensInput: 10 }),
      makeRawRow({ requestId: 'r3', canonicalModelName: 'big', tokensInput: 10 }),
    ];

    const models = groupByModel(rows);
    expect(models[0]!.canonicalModelName).toBe('big');
    expect(models[0]!.metrics.requests).toBe(2);
  });

  it('keeps null alias separate from literal "(unknown)" alias', () => {
    const rows: RawRow[] = [
      makeRawRow({
        requestId: 'r1',
        incomingModelAlias: null,
        canonicalModelName: 'gpt-4',
      }),
      makeRawRow({
        requestId: 'r2',
        incomingModelAlias: '(unknown)',
        canonicalModelName: 'gpt-4',
      }),
    ];

    const models = groupByModel(rows);
    expect(models).toHaveLength(1);
    expect(models[0]!.aliases).toHaveLength(2);

    const nullAlias = models[0]!.aliases.find((a) => a.incomingModelAlias === null);
    const literalAlias = models[0]!.aliases.find((a) => a.incomingModelAlias === '(unknown)');
    expect(nullAlias).toBeDefined();
    expect(literalAlias).toBeDefined();
    expect(nullAlias!.metrics.requests).toBe(1);
    expect(literalAlias!.metrics.requests).toBe(1);
  });
});

describe('groupByProvider', () => {
  it('keeps null provider separate from literal "(unknown)" provider', () => {
    const rows: RawRow[] = [
      makeRawRow({ requestId: 'r1', provider: null, canonicalModelName: 'gpt-4' }),
      makeRawRow({ requestId: 'r2', provider: '(unknown)', canonicalModelName: 'gpt-4' }),
    ];

    const providers = groupByProvider(rows);
    expect(providers).toHaveLength(2);

    const nullProvider = providers.find((p) => p.provider === null);
    const literalProvider = providers.find((p) => p.provider === '(unknown)');
    expect(nullProvider).toBeDefined();
    expect(literalProvider).toBeDefined();
    expect(nullProvider!.metrics.requests).toBe(1);
    expect(literalProvider!.metrics.requests).toBe(1);
  });
});

describe('GET /v0/management/provider-insights', () => {
  let fastify: ReturnType<typeof Fastify>;
  let db: ReturnType<typeof getDatabase>;
  let schema: ReturnType<typeof getSchema>;

  beforeEach(async () => {
    await closeDatabase();
    const dbUrl = process.env.PLEXUS_TEST_DB_URL ?? 'sqlite://:memory:';
    process.env.DATABASE_URL = dbUrl;
    initializeDatabase(dbUrl);
    await runMigrations();

    db = getDatabase();
    schema = getSchema();

    process.env.ADMIN_KEY = ADMIN_KEY;
    setConfigForTesting(BASE_CONFIG);

    fastify = Fastify();
    const usageStorage = new UsageStorageService();
    await registerManagementRoutes(
      fastify,
      usageStorage,
      makeMockDispatcher(),
      makeMockProbeService()
    );
    await fastify.ready();

    await db.delete(schema.requestUsage);
  });

  afterEach(async () => {
    await fastify.close();
    await closeDatabase();
    delete process.env.ADMIN_KEY;
  });

  it('returns 401 without X-Admin-Key', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/provider-insights?provider=provider-a&range=24h',
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for limited API key', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/provider-insights?provider=provider-a&range=24h',
      headers: { 'x-admin-key': 'sk-limited-secret' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 200 with provider, range, metrics, series, models', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values(
      makeRow({
        startTime: now - 1000,
        provider: 'provider-a',
        incomingModelAlias: 'alias-one',
        canonicalModelName: 'gpt-4',
        tokensInput: 100,
        tokensOutput: 50,
        costTotal: 0.01,
      })
    );

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/provider-insights?provider=provider-a&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.provider).toBe('provider-a');
    expect(body.range.key).toBe('24h');
    expect(body.metrics.requests).toBe(1);
    expect(Array.isArray(body.series)).toBe(true);
    expect(body.models).toHaveLength(1);
    expect(body.models[0].canonicalModelName).toBe('gpt-4');
    expect(body.models[0].aliases).toHaveLength(1);
    expect(body.models[0].aliases[0].incomingModelAlias).toBe('alias-one');
  });

  it('returns 400 when provider is omitted', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/provider-insights?range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('provider');
  });

  it('returns 400 for unsupported range', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/provider-insights?provider=provider-a&range=custom',
      headers: { 'x-admin-key': ADMIN_KEY },
    });
    expect(res.statusCode).toBe(400);
  });

  it('filters by provider exactly', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values([
      makeRow({
        startTime: now - 1000,
        provider: 'provider-a',
        incomingModelAlias: 'alias-a',
        canonicalModelName: 'gpt-4',
      }),
      makeRow({
        startTime: now - 1000,
        provider: 'provider-b',
        incomingModelAlias: 'alias-a',
        canonicalModelName: 'gpt-4',
      }),
    ]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/provider-insights?provider=provider-a&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().metrics.requests).toBe(1);
  });

  it('returns empty metrics for provider with no usage', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/provider-insights?provider=no-usage&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.metrics.requests).toBe(0);
    expect(body.models).toEqual([]);
    expect(body.series).toEqual([]);
  });

  it('accepts all supported range values', async () => {
    for (const rangeKey of ['1h', '5h', '24h', '7d', '30d']) {
      const res = await fastify.inject({
        method: 'GET',
        url: `/v0/management/provider-insights?provider=provider-a&range=${rangeKey}`,
        headers: { 'x-admin-key': ADMIN_KEY },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().range.key).toBe(rangeKey);
    }
  });

  it('accepts custom startTime and endTime range', async () => {
    const now = Date.now();
    const startMs = now - 2 * 60 * 60 * 1000;
    const endMs = now;
    await db.insert(schema.requestUsage).values(
      makeRow({
        startTime: now - 30 * 60 * 1000,
        provider: 'provider-a',
        incomingModelAlias: 'alias-one',
        canonicalModelName: 'gpt-4',
      })
    );

    const res = await fastify.inject({
      method: 'GET',
      url: `/v0/management/provider-insights?provider=provider-a&startTime=${startMs}&endTime=${endMs}`,
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.range.key).toBe('custom');
    expect(body.range.startTimeMs).toBe(startMs);
    expect(body.range.endTimeMs).toBe(endMs);
    expect(body.metrics.requests).toBe(1);
  });

  it('returns 400 when only startTime is provided', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/provider-insights?provider=provider-a&startTime=1000',
      headers: { 'x-admin-key': ADMIN_KEY },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('startTime and endTime');
  });

  it('returns 400 when startTime >= endTime', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/provider-insights?provider=provider-a&startTime=2000&endTime=1000',
      headers: { 'x-admin-key': ADMIN_KEY },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('less than');
  });

  it('filters usage rows by custom start/end window', async () => {
    const now = Date.now();
    const startMs = now - 60 * 60 * 1000;
    const endMs = now;
    await db.insert(schema.requestUsage).values([
      makeRow({
        startTime: now - 30 * 60 * 1000,
        provider: 'provider-a',
        incomingModelAlias: 'in-window',
        canonicalModelName: 'gpt-4',
      }),
      makeRow({
        startTime: now - 3 * 60 * 60 * 1000,
        provider: 'provider-a',
        incomingModelAlias: 'out-of-window',
        canonicalModelName: 'gpt-4',
      }),
    ]);

    const res = await fastify.inject({
      method: 'GET',
      url: `/v0/management/provider-insights?provider=provider-a&startTime=${startMs}&endTime=${endMs}`,
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().metrics.requests).toBe(1);
    expect(res.json().models[0].aliases[0].incomingModelAlias).toBe('in-window');
  });

  it('aggregates metrics across multiple aliases for same model', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values([
      makeRow({
        startTime: now - 1000,
        provider: 'provider-a',
        incomingModelAlias: 'alias-a',
        canonicalModelName: 'gpt-4',
        tokensInput: 100,
        costTotal: 0.01,
      }),
      makeRow({
        startTime: now - 2000,
        provider: 'provider-a',
        incomingModelAlias: 'alias-b',
        canonicalModelName: 'gpt-4',
        tokensInput: 200,
        costTotal: 0.02,
      }),
    ]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/provider-insights?provider=provider-a&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    const body = res.json();
    expect(body.metrics.requests).toBe(2);
    expect(body.models).toHaveLength(1);
    expect(body.models[0].metrics.requests).toBe(2);
    expect(body.models[0].aliases).toHaveLength(2);

    const aliasMetrics = body.models[0].aliases.map(
      (a: { incomingModelAlias: string; metrics: { requests: number } }) => a.metrics.requests
    );
    expect(aliasMetrics.sort()).toEqual([1, 1]);
  });
});

describe('computeMetrics via provider insights path', () => {
  it('computes failoverRequests for cross-provider rows', () => {
    const rows: RawRow[] = [
      makeRawRow({
        attemptCount: 2,
        allAttemptedProviders: ['openai/gpt-4', 'anthropic/claude-3'],
      }),
    ];
    const metrics = computeMetrics(rows);
    expect(metrics.failoverRequests).toBe(1);
  });
});
