import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { sql } from 'drizzle-orm';
import { setConfigForTesting } from '../../../config';
import { registerManagementRoutes } from '../../management';
import { UsageStorageService } from '../../../services/observability/usage-storage';
import { Dispatcher } from '../../../services/dispatch/dispatcher';
import { ProbeService } from '../../../services/probes/probe-service';
import { closeDatabase, getDatabase, getSchema, initializeDatabase } from '../../../db/client';
import { runMigrations } from '../../../db/migrate';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Insert a request_usage row for testing. */
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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('GET /v0/management/model-insights', () => {
  let fastify: ReturnType<typeof Fastify>;
  let db: ReturnType<typeof getDatabase>;
  let schema: any;

  beforeEach(async () => {
    // Reset DB for isolation
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
    const mockDispatcher = makeMockDispatcher();
    const mockProbeService = makeMockProbeService();
    await registerManagementRoutes(fastify, usageStorage, mockDispatcher, mockProbeService);
    await fastify.ready();

    // Clean out any rows
    await db.delete(schema.requestUsage);
  });

  afterEach(async () => {
    await fastify.close();
    await closeDatabase();
    delete process.env.ADMIN_KEY;
  });

  // -------------------------------------------------------------------------
  // VAL-API-001: Admin auth required
  // -------------------------------------------------------------------------
  it('returns 401 without X-Admin-Key', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error).toBeDefined();
    expect(body.error.type).toBe('auth_error');
    expect(body.error.code).toBe(401);
  });

  // -------------------------------------------------------------------------
  // VAL-API-002: Invalid admin credential rejected
  // -------------------------------------------------------------------------
  it('returns 401 with incorrect admin key', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
      headers: { 'x-admin-key': 'wrong' },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error).toBeDefined();
    expect(body.error.message).toBe('Unauthorized');
    expect(body.error.type).toBe('auth_error');
    expect(body.error.code).toBe(401);
  });

  // -------------------------------------------------------------------------
  // VAL-API-003: Limited API key cannot access admin-only insights
  // -------------------------------------------------------------------------
  it('returns 403 for limited API key', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
      headers: { 'x-admin-key': 'sk-limited-secret' },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error.type).toBe('forbidden');
    expect(body.error.code).toBe(403);
  });

  // -------------------------------------------------------------------------
  // VAL-API-004: Valid admin credential returns JSON success
  // -------------------------------------------------------------------------
  it('returns 200 JSON with model, range, metrics, series, providers for valid admin key', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values(
      makeRow({
        startTime: now - 1000,
        incomingModelAlias: 'insight-alias',
        provider: 'provider-a',
        tokensInput: 100,
        tokensOutput: 50,
        tokensReasoning: 10,
        tokensCached: 20,
        tokensCacheWrite: 5,
        costTotal: 0.01,
        responseStatus: 'success',
        durationMs: 200,
        ttftMs: 50,
        tokensPerSec: 25,
      })
    );

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    const body = res.json();
    expect(body.model).toBe('insight-alias');
    expect(body.range).toBeDefined();
    expect(body.metrics).toBeDefined();
    expect(body.series).toBeDefined();
    expect(Array.isArray(body.series)).toBe(true);
    expect(body.providers).toBeDefined();
    expect(Array.isArray(body.providers)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // VAL-API-005: Endpoint is read-only GET surface
  // -------------------------------------------------------------------------
  it('includes alternate and direct aliases for the canonical model without double counting', async () => {
    const now = Date.now();
    await db
      .insert(schema.requestUsage)
      .values([
        makeRow({
          startTime: now - 1000,
          incomingModelAlias: 'glm-latest',
          canonicalModelName: 'insight-alias',
          tokensInput: 100,
        }),
        makeRow({
          startTime: now - 1000,
          incomingModelAlias: 'direct/insight-alias/default',
          canonicalModelName: 'insight-alias',
          tokensInput: 200,
        }),
        makeRow({
          startTime: now - 1000,
          incomingModelAlias: 'insight-alias',
          canonicalModelName: 'insight-alias',
          tokensInput: 300,
        }),
        makeRow({
          startTime: now - 1000,
          incomingModelAlias: 'different-alias',
          canonicalModelName: 'insight-alias-extra',
          tokensInput: 400,
        }),
        makeRow({
          startTime: now - 25 * 60 * 60 * 1000,
          incomingModelAlias: 'glm-latest',
          canonicalModelName: 'insight-alias',
          tokensInput: 500,
        }),
      ]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().metrics.requests).toBe(3);
    expect(res.json().metrics.inputTokens).toBe(600);
  });

  it('rejects POST with 404', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await fastify.inject({
        method: method as 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        url: '/v0/management/model-insights',
        headers: { 'x-admin-key': ADMIN_KEY },
      });
      expect([404, 405]).toContain(res.statusCode);
    }
  });

  // -------------------------------------------------------------------------
  // VAL-API-006: Missing model query is rejected
  // -------------------------------------------------------------------------
  it('returns 400 when model is omitted', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.message).toContain('model');
  });

  // -------------------------------------------------------------------------
  // VAL-API-007: Empty model query is rejected
  // -------------------------------------------------------------------------
  it('returns 400 when model is empty string', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.message).toContain('model');
  });

  // -------------------------------------------------------------------------
  // VAL-API-008: Supported range values are accepted exactly
  // -------------------------------------------------------------------------
  it('accepts all supported range values and echoes range.key', async () => {
    for (const rangeKey of ['1h', '5h', '24h', '7d', '30d']) {
      const res = await fastify.inject({
        method: 'GET',
        url: `/v0/management/model-insights?model=insight-alias&range=${rangeKey}`,
        headers: { 'x-admin-key': ADMIN_KEY },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.range.key).toBe(rangeKey);
    }
  });

  // -------------------------------------------------------------------------
  // VAL-API-009: Unsupported range values are rejected
  // -------------------------------------------------------------------------
  it('returns 400 for unsupported range values', async () => {
    for (const badRange of ['hour', '1hr', '0h', '31d', 'custom']) {
      const res = await fastify.inject({
        method: 'GET',
        url: `/v0/management/model-insights?model=insight-alias&range=${badRange}`,
        headers: { 'x-admin-key': ADMIN_KEY },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.message).toContain('range');
    }
  });

  it('accepts custom startTime and endTime range', async () => {
    const now = Date.now();
    const startMs = now - 60 * 60 * 1000;
    const endMs = now;
    await db.insert(schema.requestUsage).values(
      makeRow({
        startTime: now - 15 * 60 * 1000,
        incomingModelAlias: 'insight-alias',
        provider: 'provider-a',
        canonicalModelName: 'gpt-4',
      })
    );

    const res = await fastify.inject({
      method: 'GET',
      url: `/v0/management/model-insights?model=insight-alias&startTime=${startMs}&endTime=${endMs}`,
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.range.key).toBe('custom');
    expect(body.range.startTimeMs).toBe(startMs);
    expect(body.range.endTimeMs).toBe(endMs);
    expect(body.metrics.requests).toBe(1);
  });

  it('returns 400 when only endTime is provided for custom range', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&endTime=2000',
      headers: { 'x-admin-key': ADMIN_KEY },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('startTime and endTime');
  });

  // -------------------------------------------------------------------------
  // VAL-API-010: Model aliases are matched exactly after URL decoding
  // -------------------------------------------------------------------------
  it('matches URL-encoded aliases exactly', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values([
      makeRow({
        startTime: now - 1000,
        incomingModelAlias: 'claude/sonnet 4',
        provider: 'anthropic',
        tokensInput: 100,
        tokensOutput: 50,
      }),
      makeRow({
        startTime: now - 1000,
        incomingModelAlias: 'claude/sonnet 4 extra',
        provider: 'anthropic',
        tokensInput: 200,
        tokensOutput: 100,
      }),
    ]);

    // Request with encoded alias
    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=claude%2Fsonnet%204&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.model).toBe('claude/sonnet 4');
    // Should only include the exact alias, not "claude/sonnet 4 extra"
    expect(body.metrics.requests).toBe(1);
    expect(body.metrics.inputTokens).toBe(100);
  });

  // -------------------------------------------------------------------------
  // VAL-API-011: Unknown configured/no-data model returns empty success
  // -------------------------------------------------------------------------
  it('returns 200 with zero metrics for a configured alias with no data', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=empty-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.model).toBe('empty-alias');
    expect(body.metrics.requests).toBe(0);
    expect(body.metrics.totalTokens).toBe(0);
    expect(body.metrics.totalCost).toBe(0);
    expect(body.providers.length).toBe(0);
    expect(Array.isArray(body.series)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // VAL-API-012: Response range metadata is deterministic and bounded
  // -------------------------------------------------------------------------
  it('returns correct range metadata with startTimeMs, endTimeMs, bucketSizeMs', async () => {
    const fixedNow = 1700000000000; // Fixed deterministic timestamp
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=5h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    vi.useRealTimers();

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const range = body.range;

    expect(range.key).toBe('5h');
    expect(range.label).toBe('5h');
    expect(range.startTimeMs).toBe(fixedNow - 5 * 60 * 60 * 1000);
    expect(range.endTimeMs).toBe(fixedNow);
    expect(range.bucketSizeMs).toBe(15 * 60 * 1000); // 15 min buckets
    expect(range.endTimeMs - range.startTimeMs).toBe(5 * 60 * 60 * 1000);

    // All series points should be within range bounds
    for (const point of body.series) {
      expect(point.bucketStartMs).toBeGreaterThanOrEqual(range.startTimeMs);
      expect(point.bucketStartMs).toBeLessThanOrEqual(range.endTimeMs);
    }
  });

  // -------------------------------------------------------------------------
  // VAL-API-013: Time range filtering excludes older and future rows
  // -------------------------------------------------------------------------
  it('filters out rows outside the requested time range', async () => {
    const fixedNow = 1700000000000;
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);

    const rowInside = makeRow({
      startTime: fixedNow - 23 * 60 * 60 * 1000, // 23h ago - inside 24h
      incomingModelAlias: 'insight-alias',
      tokensInput: 100,
    });
    const rowOutside = makeRow({
      startTime: fixedNow - 25 * 60 * 60 * 1000, // 25h ago - outside 24h
      incomingModelAlias: 'insight-alias',
      tokensInput: 200,
    });
    const rowFuture = makeRow({
      startTime: fixedNow + 60 * 60 * 1000, // 1h future
      incomingModelAlias: 'insight-alias',
      tokensInput: 300,
    });

    await db.insert(schema.requestUsage).values([rowInside, rowOutside, rowFuture]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    vi.useRealTimers();

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Only the 23h-ago row should be included
    expect(body.metrics.requests).toBe(1);
    expect(body.metrics.inputTokens).toBe(100);
  });

  // -------------------------------------------------------------------------
  // VAL-API-014: Range boundary rows are handled consistently
  // -------------------------------------------------------------------------
  it('includes rows well within range and excludes rows well outside', async () => {
    const fixedNow = 1700000000000;
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);

    // Row well inside the 24h range
    const rowInside = makeRow({
      startTime: fixedNow - 12 * 60 * 60 * 1000, // 12h ago - clearly inside 24h
      incomingModelAlias: 'insight-alias',
      tokensInput: 10,
    });
    // Row well outside the 24h range
    const rowOutside = makeRow({
      startTime: fixedNow - 48 * 60 * 60 * 1000, // 48h ago - clearly outside 24h
      incomingModelAlias: 'insight-alias',
      tokensInput: 20,
    });

    await db.insert(schema.requestUsage).values([rowInside, rowOutside]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    vi.useRealTimers();

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Only the 12h-ago row should be included; the 48h-ago one should be excluded
    expect(body.metrics.requests).toBe(1);
    expect(body.metrics.inputTokens).toBe(10);
  });

  // -------------------------------------------------------------------------
  // VAL-API-015: Model filter uses incomingModelAlias as source of truth
  // -------------------------------------------------------------------------
  it('filters by incomingModelAlias, not canonical or selected model name', async () => {
    const now = Date.now();
    // Row matching alias but different canonical model -> should be included
    await db.insert(schema.requestUsage).values(
      makeRow({
        startTime: now - 1000,
        incomingModelAlias: 'insight-alias',
        canonicalModelName: 'canonical-a',
        selectedModelName: 'selected-a',
        provider: 'provider-a',
        tokensInput: 100,
      })
    );
    // Row with different alias but same canonical model -> should be excluded
    await db.insert(schema.requestUsage).values(
      makeRow({
        startTime: now - 1000,
        incomingModelAlias: 'other-alias',
        canonicalModelName: 'canonical-a',
        selectedModelName: 'selected-a',
        provider: 'provider-a',
        tokensInput: 200,
      })
    );

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.metrics.requests).toBe(1);
    expect(body.metrics.inputTokens).toBe(100);
  });

  // -------------------------------------------------------------------------
  // VAL-API-016: Null numeric values are treated as zero
  // -------------------------------------------------------------------------
  it('handles null numeric fields gracefully (zero, not NaN)', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values(
      makeRow({
        startTime: now - 1000,
        incomingModelAlias: 'insight-alias',
        tokensInput: null,
        tokensOutput: null,
        tokensReasoning: null,
        tokensCached: null,
        tokensCacheWrite: null,
        costTotal: null,
        costInput: null,
        costOutput: null,
        durationMs: null,
        ttftMs: null,
        tokensPerSec: null,
        responseStatus: 'success',
      })
…26762 tokens truncated…    isStreamed: 0,
          isPassthrough: 0,
          responseStatus: 'success',
          startTime: Date.now() - 1000,
          providerReportedCost: null,
          tokensEstimated: 0,
          isDescriptorRequest: 0,
          isVisionFallthrough: 0,
        },
      ];

      const metrics = computeMetrics(rows);
      expect(metrics.failoverRequests).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // SQLite comma-string coercion via full API
  // -------------------------------------------------------------------------
  // When SQLite persists a native allAttemptedProviders array, it may coerce
  // it to a plain comma-separated string (e.g. "provider-a/model-1,provider-b/model-2")
  // rather than a JSON array string. These tests verify that the full API route
  // handles such coerced comma strings gracefully: they are NOT treated as
  // native-array failover signals because the string cannot be reliably parsed
  // as JSON. Native-array failover behavior is already covered by the direct
  // computeMetrics aggregation tests above, which bypass SQLite persistence.
  it('handles SQLite-coerced comma string allAttemptedProviders gracefully via API', async () => {
    const now = Date.now();
    // Simulate a row where SQLite coerced a native array to a plain
    // comma-separated string (not valid JSON). With null retryHistory,
    // the coerced string provides insufficient metadata for failover detection.
    await db.insert(schema.requestUsage).values([
      makeRow({
        startTime: now - 1000,
        incomingModelAlias: 'insight-alias',
        attemptCount: 2,
        allAttemptedProviders: 'provider-a/model-1,provider-b/model-2' as any,
        retryHistory: null,
        finalAttemptProvider: 'provider-b',
        provider: 'provider-b',
        responseStatus: 'error',
      }),
    ]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const m = res.json().metrics;
    // The comma-separated string is not valid JSON, so it cannot be used to
    // determine cross-provider status. This is NOT a native-array failover —
    // native arrays are handled correctly by computeMetrics (proven above).
    // The coerced string simply lacks sufficient metadata for failover detection.
    expect(m.failoverRequests).toBe(0); // insufficient metadata from coerced string
    expect(m.totalRetryAttempts).toBe(1); // 2 - 1
  });

  it('same-provider SQLite comma string does not increment failover via API', async () => {
    const now = Date.now();
    // Same-provider entries in a SQLite-coerced comma-separated string
    await db.insert(schema.requestUsage).values([
      makeRow({
        startTime: now - 1000,
        incomingModelAlias: 'insight-alias',
        attemptCount: 2,
        allAttemptedProviders: 'provider-a/model-1,provider-a/model-1' as any,
        retryHistory: null,
        finalAttemptProvider: 'provider-a',
        provider: 'provider-a',
        responseStatus: 'success',
      }),
    ]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const m = res.json().metrics;
    // Same-provider coerced string should NOT be counted as failover
    expect(m.failoverRequests).toBe(0);
    expect(m.totalRetryAttempts).toBe(1); // 2 - 1
  });

  it('same-provider retries with absent allAttemptedProviders do not increment failover', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values([
      // Same-provider retry with absent metadata
      makeRow({
        startTime: now - 1000,
        incomingModelAlias: 'insight-alias',
        attemptCount: 3,
        allAttemptedProviders: null,
        retryHistory: JSON.stringify([
          { provider: 'provider-a', model: 'model-1', status: 'error' },
          { provider: 'provider-a', model: 'model-1', status: 'error' },
        ]),
        finalAttemptProvider: 'provider-a',
        finalAttemptModel: 'model-1',
        provider: 'provider-a',
        responseStatus: 'success',
      }),
    ]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const m = res.json().metrics;
    // Same-provider retries should NOT be failover
    expect(m.failoverRequests).toBe(0);
    expect(m.totalRetryAttempts).toBe(2); // 3 - 1
  });

  it('mixed failed cross-provider and same-provider retries with absent allAttemptedProviders', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values([
      // Failed cross-provider attempt (allAttemptedProviders absent)
      makeRow({
        startTime: now - 1000,
        incomingModelAlias: 'insight-alias',
        attemptCount: 2,
        allAttemptedProviders: null,
        retryHistory: JSON.stringify([
          { provider: 'provider-a', model: 'model-1', status: 'error' },
        ]),
        finalAttemptProvider: 'provider-b',
        provider: 'provider-b',
        responseStatus: 'error',
      }),
      // Same-provider retry (allAttemptedProviders absent)
      makeRow({
        startTime: now - 2000,
        incomingModelAlias: 'insight-alias',
        attemptCount: 3,
        allAttemptedProviders: null,
        retryHistory: JSON.stringify([
          { provider: 'provider-a', model: 'model-1', status: 'error' },
          { provider: 'provider-a', model: 'model-1', status: 'error' },
        ]),
        finalAttemptProvider: 'provider-a',
        provider: 'provider-a',
        responseStatus: 'success',
      }),
      // Single attempt, no retry
      makeRow({
        startTime: now - 3000,
        incomingModelAlias: 'insight-alias',
        attemptCount: 1,
        allAttemptedProviders: null,
        retryHistory: null,
        provider: 'provider-a',
        responseStatus: 'success',
      }),
    ]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const m = res.json().metrics;
    expect(m.failoverRequests).toBe(1); // Only the cross-provider attempt
    expect(m.totalRetryAttempts).toBe(3); // (2-1) + (3-1) + (1-1) = 1 + 2 + 0
    expect(m.avgAttempts).toBeCloseTo(2.0); // (2+3+1)/3
  });

  it('failover reconciliation holds with failed cross-provider rows', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values([
      // Successful cross-provider failover (allAttemptedProviders present)
      makeRow({
        startTime: now - 1000,
        incomingModelAlias: 'insight-alias',
        provider: 'provider-b',
        tokensInput: 100,
        costTotal: 0.01,
        attemptCount: 2,
        allAttemptedProviders: JSON.stringify(['provider-a/model-1', 'provider-b/model-1']),
        responseStatus: 'success',
      }),
      // Failed cross-provider attempt (allAttemptedProviders absent)
      makeRow({
        startTime: now - 2000,
        incomingModelAlias: 'insight-alias',
        provider: 'provider-c',
        tokensInput: 50,
        costTotal: 0.005,
        attemptCount: 3,
        allAttemptedProviders: null,
        retryHistory: JSON.stringify([
          { provider: 'provider-a', model: 'model-1', status: 'error' },
          { provider: 'provider-b', model: 'model-2', status: 'error' },
        ]),
        finalAttemptProvider: 'provider-c',
        responseStatus: 'error',
      }),
    ]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const m = body.metrics;

    // Both rows should be counted as failover
    expect(m.failoverRequests).toBe(2);
    expect(m.totalRetryAttempts).toBe(3); // (2-1) + (3-1) = 1 + 2

    // Provider group reconciliation
    const providerRequests = body.providers.reduce(
      (s: number, p: any) => s + p.metrics.requests,
      0
    );
    expect(providerRequests).toBe(m.requests);
    expect(m.requests).toBe(2);
    expect(m.errorRequests).toBe(1);
    expect(m.successfulRequests).toBe(1);
  });

  // =========================================================================
  // Provider group reconciliation with scrutiny fixes
  // =========================================================================
  it('provider group metrics reconcile with cross-provider failover counting', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values([
      makeRow({
        startTime: now - 1000,
        incomingModelAlias: 'insight-alias',
        provider: 'provider-a',
        tokensInput: 100,
        costTotal: 0.01,
        attemptCount: 2,
        allAttemptedProviders: JSON.stringify(['provider-a/model-1', 'provider-b/model-1']),
        finalAttemptProvider: 'provider-b',
        responseStatus: 'success',
      }),
      makeRow({
        startTime: now - 2000,
        incomingModelAlias: 'insight-alias',
        provider: 'provider-b',
        tokensInput: 200,
        costTotal: 0.02,
        attemptCount: 1,
        allAttemptedProviders: JSON.stringify(['provider-b/model-1']),
        responseStatus: 'success',
      }),
    ]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const m = body.metrics;

    // Overall reconciliation
    const providerRequests = body.providers.reduce(
      (s: number, p: any) => s + p.metrics.requests,
      0
    );
    expect(providerRequests).toBe(m.requests);
    expect(m.requests).toBe(2);

    // Only the first row (cross-provider) should be a failover
    expect(m.failoverRequests).toBe(1);
    expect(m.totalRetryAttempts).toBe(1);
  });

  // =========================================================================
  // Deterministic boundary tests (fixed-clock, exact edge verification)
  // =========================================================================
  describe('deterministic boundary tests with fixed clock', () => {
    // These tests use vi.useFakeTimers + vi.setSystemTime so that fixture
    // timestamps and the endpoint's Date.now() share the exact same "now".
    // This eliminates the timing margin that caused flaky boundary failures.

    it('includes row at exact startTimeMs and excludes row 1ms before', async () => {
      const fixedNow = 1700000000000;
      vi.useFakeTimers();
      vi.setSystemTime(fixedNow);

      const rangeDuration = 24 * 60 * 60 * 1000;
      const startTimeMs = fixedNow - rangeDuration;

      // Row exactly at startTimeMs → should be included (inclusive start)
      await db.insert(schema.requestUsage).values(
        makeRow({
          startTime: startTimeMs,
          incomingModelAlias: 'insight-alias',
          tokensInput: 42,
          costTotal: 0.01,
        })
      );

      // Row 1ms before startTimeMs → should be excluded
      await db.insert(schema.requestUsage).values(
        makeRow({
          startTime: startTimeMs - 1,
          incomingModelAlias: 'insight-alias',
          tokensInput: 99,
          costTotal: 0.02,
        })
      );

      const res = await fastify.inject({
        method: 'GET',
        url: '/v0/management/model-insights?model=insight-alias&range=24h',
        headers: { 'x-admin-key': ADMIN_KEY },
      });

      vi.useRealTimers();

      expect(res.statusCode).toBe(200);
      const body = res.json();

      // Range metadata should use the exact fixedNow
      expect(body.range.endTimeMs).toBe(fixedNow);
      expect(body.range.startTimeMs).toBe(startTimeMs);

      // Only the startTimeMs row should be included
      expect(body.metrics.requests).toBe(1);
      expect(body.metrics.inputTokens).toBe(42);
    });

    it('includes row at exact endTimeMs and excludes row after endTimeMs', async () => {
      const fixedNow = 1700000000000;
      vi.useFakeTimers();
      vi.setSystemTime(fixedNow);

      // Row exactly at endTimeMs (fixedNow) → should be included (inclusive end via lte)
      await db.insert(schema.requestUsage).values(
        makeRow({
          startTime: fixedNow,
          incomingModelAlias: 'insight-alias',
          tokensInput: 55,
          costTotal: 0.015,
        })
      );

      // Row 1ms after endTimeMs → should be excluded
      await db.insert(schema.requestUsage).values(
        makeRow({
          startTime: fixedNow + 1,
          incomingModelAlias: 'insight-alias',
          tokensInput: 77,
          costTotal: 0.025,
        })
      );

      const res = await fastify.inject({
        method: 'GET',
        url: '/v0/management/model-insights?model=insight-alias&range=24h',
        headers: { 'x-admin-key': ADMIN_KEY },
      });

      vi.useRealTimers();

      expect(res.statusCode).toBe(200);
      const body = res.json();

      expect(body.metrics.requests).toBe(1);
      expect(body.metrics.inputTokens).toBe(55);
    });

    it('assigns rows at exact bucket boundaries to the correct bucket', async () => {
      const fixedNow = 1700000000000;
      vi.useFakeTimers();
      vi.setSystemTime(fixedNow);

      // 1h range with 5-min (300000ms) buckets
      const bucketSizeMs = 5 * 60 * 1000;
      const rangeStart = fixedNow - 60 * 60 * 1000;

      // Row at the exact start of the first bucket (startTimeMs)
      await db.insert(schema.requestUsage).values(
        makeRow({
          startTime: rangeStart,
          incomingModelAlias: 'insight-alias',
          tokensInput: 10,
        })
      );

      // Row at the last ms of the first bucket (bucketStart + bucketSizeMs - 1)
      await db.insert(schema.requestUsage).values(
        makeRow({
          startTime: rangeStart + bucketSizeMs - 1,
          incomingModelAlias: 'insight-alias',
          tokensInput: 20,
        })
      );

      // Row at the exact start of the second bucket (bucketStart + bucketSizeMs)
      await db.insert(schema.requestUsage).values(
        makeRow({
          startTime: rangeStart + bucketSizeMs,
          incomingModelAlias: 'insight-alias',
          tokensInput: 30,
        })
      );

      const res = await fastify.inject({
        method: 'GET',
        url: '/v0/management/model-insights?model=insight-alias&range=1h',
        headers: { 'x-admin-key': ADMIN_KEY },
      });

      vi.useRealTimers();

      expect(res.statusCode).toBe(200);
      const body = res.json();

      // Should have at least 2 buckets with data
      expect(body.series.length).toBeGreaterThanOrEqual(2);

      // First bucket should contain rows at rangeStart and rangeStart+bucketSizeMs-1
      const firstBucket = body.series[0];
      expect(firstBucket.bucketStartMs).toBe(rangeStart);
      expect(firstBucket.metrics.requests).toBe(2);
      expect(firstBucket.metrics.inputTokens).toBe(30); // 10 + 20

      // Second bucket should contain the row at rangeStart+bucketSizeMs
      const secondBucket = body.series[1];
      expect(secondBucket.bucketStartMs).toBe(rangeStart + bucketSizeMs);
      expect(secondBucket.metrics.requests).toBe(1);
      expect(secondBucket.metrics.inputTokens).toBe(30);
    });

    it('no bucket starts before range.startTimeMs or at/after range.endTimeMs', async () => {
      const fixedNow = 1700000000000;
      vi.useFakeTimers();
      vi.setSystemTime(fixedNow);

      // Test all supported ranges to verify bucket anchoring
      const ranges: Array<{ key: string; bucketSizeMs: number }> = [
        { key: '1h', bucketSizeMs: 5 * 60 * 1000 },
        { key: '5h', bucketSizeMs: 15 * 60 * 1000 },
        { key: '24h', bucketSizeMs: 60 * 60 * 1000 },
        { key: '7d', bucketSizeMs: 6 * 60 * 60 * 1000 },
        { key: '30d', bucketSizeMs: 24 * 60 * 60 * 1000 },
      ];

      for (const { key, bucketSizeMs: _bucketSizeMs } of ranges) {
        // Seed a row at the start boundary to ensure first bucket is populated
        const rangeStart =
          fixedNow -
          (key === '1h'
            ? 3600000
            : key === '5h'
              ? 18000000
              : key === '24h'
                ? 86400000
                : key === '7d'
                  ? 604800000
                  : 2592000000);
        await db.insert(schema.requestUsage).values(
          makeRow({
            startTime: rangeStart,
            incomingModelAlias: 'insight-alias',
            tokensInput: 1,
          })
        );

        const res = await fastify.inject({
          method: 'GET',
          url: `/v0/management/model-insights?model=insight-alias&range=${key}`,
          headers: { 'x-admin-key': ADMIN_KEY },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();

        for (const bucket of body.series) {
          expect(
            bucket.bucketStartMs,
            `range=${key}: bucket ${bucket.bucketStartMs} must be >= startTimeMs ${body.range.startTimeMs}`
          ).toBeGreaterThanOrEqual(body.range.startTimeMs);
          expect(
            bucket.bucketStartMs,
            `range=${key}: bucket ${bucket.bucketStartMs} must be < endTimeMs ${body.range.endTimeMs}`
          ).toBeLessThan(body.range.endTimeMs);
        }

        // Clean up for next iteration
        await db.delete(schema.requestUsage);
      }

      vi.useRealTimers();
    });

    it('bucket-level metrics reconcile with top-level metrics at exact boundaries', async () => {
      const fixedNow = 1700000000000;
      vi.useFakeTimers();
      vi.setSystemTime(fixedNow);

      // 1h range with 5-min buckets
      const rangeStart = fixedNow - 60 * 60 * 1000;

      // Seed rows at exact bucket boundaries and mid-bucket positions
      await db.insert(schema.requestUsage).values([
        // Exactly at range start
        makeRow({
          startTime: rangeStart,
          incomingModelAlias: 'insight-alias',
          tokensInput: 100,
          tokensOutput: 50,
          costTotal: 0.01,
          responseStatus: 'success',
        }),
        // Middle of first bucket
        makeRow({
          startTime: rangeStart + 2 * 60 * 1000,
          incomingModelAlias: 'insight-alias',
          tokensInput: 200,
          tokensOutput: 80,
          costTotal: 0.02,
          responseStatus: 'success',
        }),
        // Exactly at the boundary of second bucket (5 min mark)
        makeRow({
          startTime: rangeStart + 5 * 60 * 1000,
          incomingModelAlias: 'insight-alias',
          tokensInput: 150,
          tokensOutput: 60,
          costTotal: 0.015,
          responseStatus: 'error',
        }),
        // Near end of range
        makeRow({
          startTime: fixedNow - 1000,
          incomingModelAlias: 'insight-alias',
          tokensInput: 300,
          tokensOutput: 120,
          costTotal: 0.03,
          responseStatus: 'success',
        }),
      ]);

      const res = await fastify.inject({
        method: 'GET',
        url: '/v0/management/model-insights?model=insight-alias&range=1h',
        headers: { 'x-admin-key': ADMIN_KEY },
      });

      vi.useRealTimers();

      expect(res.statusCode).toBe(200);
      const body = res.json();

      // Top-level checks
      expect(body.metrics.requests).toBe(4);
      // Token counts are success-only: the 150/60 error row is excluded
      expect(body.metrics.inputTokens).toBe(600);
      expect(body.metrics.outputTokens).toBe(250);
      expect(body.metrics.totalCost).toBeCloseTo(0.075, 6);
      expect(body.metrics.successfulRequests).toBe(3);
      expect(body.metrics.errorRequests).toBe(1);

      // Bucket reconciliation: sum of bucket metrics = top-level metrics
      const bucketRequests = body.series.reduce(
        (sum: number, b: any) => sum + b.metrics.requests,
        0
      );
      expect(bucketRequests).toBe(body.metrics.requests);

      const bucketInputTokens = body.series.reduce(
        (sum: number, b: any) => sum + b.metrics.inputTokens,
        0
      );
      expect(bucketInputTokens).toBe(body.metrics.inputTokens);

      const bucketOutputTokens = body.series.reduce(
        (sum: number, b: any) => sum + b.metrics.outputTokens,
        0
      );
      expect(bucketOutputTokens).toBe(body.metrics.outputTokens);

      const bucketCost = body.series.reduce((sum: number, b: any) => sum + b.metrics.totalCost, 0);
      expect(bucketCost).toBeCloseTo(body.metrics.totalCost, 6);

      const bucketSuccessful = body.series.reduce(
        (sum: number, b: any) => sum + b.metrics.successfulRequests,
        0
      );
      expect(bucketSuccessful).toBe(body.metrics.successfulRequests);

      const bucketErrors = body.series.reduce(
        (sum: number, b: any) => sum + b.metrics.errorRequests,
        0
      );
      expect(bucketErrors).toBe(body.metrics.errorRequests);

      // Verify range metadata is deterministic
      expect(body.range.startTimeMs).toBe(rangeStart);
      expect(body.range.endTimeMs).toBe(fixedNow);
    });

    it('verifies range metadata matches fixed clock for all supported ranges', async () => {
      const fixedNow = 1700000000000;
      vi.useFakeTimers();
      vi.setSystemTime(fixedNow);

      const expectedDurations: Record<string, number> = {
        '1h': 3600000,
        '5h': 18000000,
        '24h': 86400000,
        '7d': 604800000,
        '30d': 2592000000,
      };

      for (const [key, duration] of Object.entries(expectedDurations)) {
        const res = await fastify.inject({
          method: 'GET',
          url: `/v0/management/model-insights?model=insight-alias&range=${key}`,
          headers: { 'x-admin-key': ADMIN_KEY },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();

        expect(body.range.endTimeMs, `range=${key}: endTimeMs should equal fixedNow`).toBe(
          fixedNow
        );
        expect(
          body.range.startTimeMs,
          `range=${key}: startTimeMs should equal fixedNow - duration`
        ).toBe(fixedNow - duration);
        expect(
          body.range.endTimeMs - body.range.startTimeMs,
          `range=${key}: range span should equal ${duration}`
        ).toBe(duration);
      }

      vi.useRealTimers();
    });
  });
});
