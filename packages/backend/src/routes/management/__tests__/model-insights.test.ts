import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { sql } from 'drizzle-orm';
import { setConfigForTesting } from '../../../config';
import { registerManagementRoutes } from '../../management';
import { UsageStorageService } from '../../../services/usage-storage';
import { Dispatcher } from '../../../services/dispatcher';
import { ProbeService } from '../../../services/probe-service';
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
    );

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const m = body.metrics;

    // All metric values must be finite numbers (no NaN or Infinity)
    // Check metrics object specifically (provider groups may have null string fields)
    const metricsStr = JSON.stringify(m);
    expect(metricsStr).not.toContain('NaN');
    expect(metricsStr).not.toContain('Infinity');

    // Check series metrics
    for (const bucket of body.series) {
      const bucketMetricsStr = JSON.stringify(bucket.metrics);
      expect(bucketMetricsStr).not.toContain('NaN');
      expect(bucketMetricsStr).not.toContain('Infinity');
    }

    // Check provider metrics
    for (const provider of body.providers) {
      const providerMetricsStr = JSON.stringify(provider.metrics);
      expect(providerMetricsStr).not.toContain('NaN');
      expect(providerMetricsStr).not.toContain('Infinity');
      for (const model of provider.models) {
        const modelMetricsStr = JSON.stringify(model.metrics);
        expect(modelMetricsStr).not.toContain('NaN');
        expect(modelMetricsStr).not.toContain('Infinity');
      }
    }

    expect(m.inputTokens).toBe(0);
    expect(m.outputTokens).toBe(0);
    expect(m.totalTokens).toBe(0);
    expect(m.totalCost).toBe(0);
    expect(m.requests).toBe(1);
  });

  // -------------------------------------------------------------------------
  // VAL-API-035: Numeric response values are finite JSON numbers
  // -------------------------------------------------------------------------
  it('returns only finite non-negative values for empty and populated data', async () => {
    // Empty case
    const emptyRes = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=no-data&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });
    expect(emptyRes.statusCode).toBe(200);
    const emptyBody = emptyRes.json();
    const emptyStr = JSON.stringify(emptyBody);
    expect(emptyStr).not.toContain('NaN');
    expect(emptyStr).not.toContain('Infinity');
    expect(emptyStr).not.toContain('-Infinity');

    // Recursively check all numbers are finite and non-negative (where applicable)
    function checkFinite(obj: unknown, path: string = ''): void {
      if (typeof obj === 'number') {
        expect(Number.isFinite(obj)).toBe(true);
      } else if (Array.isArray(obj)) {
        obj.forEach((item, i) => checkFinite(item, `${path}[${i}]`));
      } else if (obj && typeof obj === 'object') {
        for (const [key, value] of Object.entries(obj)) {
          checkFinite(value, `${path}.${key}`);
        }
      }
    }
    checkFinite(emptyBody);
  });

  // -------------------------------------------------------------------------
  // VAL-API-036: Validation and server errors do not leak internals
  // -------------------------------------------------------------------------
  it('returns sanitized validation errors without stack traces', async () => {
    // Missing model
    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBeDefined();
    // Should not contain stack traces or file paths
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toMatch(/at\s+\w+\s+\(/); // no stack trace
    expect(bodyStr).not.toMatch(/\.ts:\d+:\d+/); // no file paths
  });

  // -------------------------------------------------------------------------
  // VAL-API-037: Unconfigured model behavior is explicit and safe
  // -------------------------------------------------------------------------
  it('returns 200 with empty metrics for unconfigured/unknown model alias', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=unconfigured-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    // Should return 200 with empty metrics (not 404 or error)
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.model).toBe('unconfigured-alias');
    expect(body.metrics.requests).toBe(0);
    expect(body.providers.length).toBe(0);
    // Should NOT aggregate all models
    expect(body.metrics.totalTokens).toBe(0);
  });

  // -------------------------------------------------------------------------
  // VAL-API-038: Missing or duplicate query parameters are deterministic
  // -------------------------------------------------------------------------
  it('handles missing range with documented default (24h)', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.range.key).toBe('24h');
  });

  it('rejects duplicate model parameter', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=a&model=b&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.message).toContain('model');
  });

  it('rejects duplicate range parameter', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h&range=30d',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.message).toContain('range');
  });

  // -------------------------------------------------------------------------
  // VAL-API-039: Successful response schema is consistent
  // -------------------------------------------------------------------------
  it('returns consistent schema with range.key, range.label, range.startTimeMs, etc.', async () => {
    const now = Date.now();
    await db
      .insert(schema.requestUsage)
      .values(makeRow({ startTime: now - 1000, incomingModelAlias: 'insight-alias' }));

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Top-level shape
    expect(body.model).toBe('insight-alias');
    expect(typeof body.range.key).toBe('string');
    expect(typeof body.range.label).toBe('string');
    expect(typeof body.range.startTimeMs).toBe('number');
    expect(typeof body.range.endTimeMs).toBe('number');
    expect(typeof body.range.bucketSizeMs).toBe('number');
    expect(typeof body.metrics).toBe('object');
    expect(Array.isArray(body.series)).toBe(true);
    expect(Array.isArray(body.providers)).toBe(true);

    // Provider shape
    if (body.providers.length > 0) {
      const p = body.providers[0];
      expect(typeof p.provider).toBe('string');
      expect(typeof p.metrics).toBe('object');
      expect(Array.isArray(p.models)).toBe(true);
      if (p.models.length > 0) {
        const m = p.models[0];
        expect(m.canonicalModelName).toBeDefined();
        expect(m.selectedModelName).toBeDefined();
        expect(typeof m.metrics).toBe('object');
      }
    }

    // Series shape
    if (body.series.length > 0) {
      const s = body.series[0];
      expect(typeof s.bucketStartMs).toBe('number');
      expect(typeof s.metrics).toBe('object');
    }
  });

  // -------------------------------------------------------------------------
  // VAL-API-041: Dense 30-day responses are bounded and chart-safe
  // -------------------------------------------------------------------------
  it('returns bounded series for 30d range, not per-request payloads', async () => {
    const fixedNow = 1700000000000;
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);

    // Seed 100 rows across 30 days
    const rows = [];
    for (let i = 0; i < 100; i++) {
      rows.push(
        makeRow({
          startTime: fixedNow - i * 8 * 60 * 60 * 1000, // spread across ~33 days
          incomingModelAlias: 'insight-alias',
          tokensInput: 10,
          tokensOutput: 5,
          costTotal: 0.001,
        })
      );
    }
    await db.insert(schema.requestUsage).values(rows);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=30d',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    vi.useRealTimers();

    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Series should be bounded (30 days with daily buckets = max 30 buckets)
    expect(body.series.length).toBeLessThanOrEqual(31);
    expect(body.range.key).toBe('30d');
    expect(body.range.bucketSizeMs).toBe(24 * 60 * 60 * 1000); // daily

    // Metrics should be correct
    expect(body.metrics.requests).toBeGreaterThan(0);
    expect(body.metrics.inputTokens).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Whitespace-only model is rejected
  // -------------------------------------------------------------------------
  it('rejects whitespace-only model', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=%20%20&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.message).toContain('model');
  });

  // =========================================================================
  // VAL-API-017: Overall token metrics use the complete token formula
  // =========================================================================
  it('computes totalTokens = input + output + reasoning + cached + cacheWrite', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values([
      makeRow({
        startTime: now - 1000,
        incomingModelAlias: 'insight-alias',
        tokensInput: 100,
        tokensOutput: 50,
        tokensReasoning: 10,
        tokensCached: 20,
        tokensCacheWrite: 5,
      }),
      makeRow({
        startTime: now - 2000,
        incomingModelAlias: 'insight-alias',
        tokensInput: 200,
        tokensOutput: 80,
        tokensReasoning: 15,
        tokensCached: 30,
        tokensCacheWrite: 10,
      }),
    ]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const m = res.json().metrics;
    // Row 1: 100+50+10+20+5 = 185; Row 2: 200+80+15+30+10 = 335
    expect(m.inputTokens).toBe(300);
    expect(m.outputTokens).toBe(130);
    expect(m.reasoningTokens).toBe(25);
    expect(m.cachedTokens).toBe(50);
    expect(m.cacheWriteTokens).toBe(15);
    expect(m.totalTokens).toBe(300 + 130 + 25 + 50 + 15); // 520
    expect(m.totalTokens).toBe(
      m.inputTokens + m.outputTokens + m.reasoningTokens + m.cachedTokens + m.cacheWriteTokens
    );
  });

  // =========================================================================
  // VAL-API-018: Total cost and cost component sums are accurate
  // =========================================================================
  it('sums costTotal and cost components accurately', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values([
      makeRow({
        startTime: now - 1000,
        incomingModelAlias: 'insight-alias',
        costInput: 0.005,
        costOutput: 0.003,
        costCached: 0.001,
        costCacheWrite: 0.002,
        costTotal: 0.011,
      }),
      makeRow({
        startTime: now - 2000,
        incomingModelAlias: 'insight-alias',
        costInput: 0.01,
        costOutput: 0.006,
        costCached: 0.002,
        costCacheWrite: 0.004,
        costTotal: 0.022,
      }),
    ]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const m = res.json().metrics;
    expect(m.totalCost).toBeCloseTo(0.033, 6);
    expect(m.inputCost).toBeCloseTo(0.015, 6);
    expect(m.outputCost).toBeCloseTo(0.009, 6);
    expect(m.cachedCost).toBeCloseTo(0.003, 6);
    expect(m.cacheWriteCost).toBeCloseTo(0.006, 6);
  });

  // =========================================================================
  // VAL-API-019: Provider-reported and calculated cost are distinguishable
  // =========================================================================
  it('separates provider-reported and calculated costs', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values([
      makeRow({
        startTime: now - 1000,
        incomingModelAlias: 'insight-alias',
        costTotal: 0.05,
        costSource: 'provider_reported',
        providerReportedCost: 0.05,
      }),
      makeRow({
        startTime: now - 2000,
        incomingModelAlias: 'insight-alias',
        costTotal: 0.03,
        costSource: null,
        providerReportedCost: null,
      }),
    ]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const m = res.json().metrics;
    // totalCost = sum of all costTotal
    expect(m.totalCost).toBeCloseTo(0.08, 6);
    // Provider-reported sum and calculated sum
    expect(m.providerReportedCost).toBeCloseTo(0.05, 6);
    expect(m.calculatedCost).toBeCloseTo(0.03, 6);
    expect(m.providerReportedCostCount).toBe(1);
  });

  // =========================================================================
  // VAL-API-020: Request status counts and rates are correct
  // =========================================================================
  it('computes status counts and rates correctly', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values([
      makeRow({
        startTime: now - 1000,
        incomingModelAlias: 'insight-alias',
        responseStatus: 'success',
      }),
      makeRow({
        startTime: now - 2000,
        incomingModelAlias: 'insight-alias',
        responseStatus: 'success',
      }),
      makeRow({
        startTime: now - 3000,
        incomingModelAlias: 'insight-alias',
        responseStatus: 'success',
      }),
      makeRow({
        startTime: now - 4000,
        incomingModelAlias: 'insight-alias',
        responseStatus: 'error',
      }),
      makeRow({
        startTime: now - 5000,
        incomingModelAlias: 'insight-alias',
        responseStatus: 'pending',
      }),
    ]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const m = res.json().metrics;
    expect(m.requests).toBe(5);
    expect(m.successfulRequests).toBe(3);
    expect(m.errorRequests).toBe(1);
    expect(m.pendingRequests).toBe(1);
    expect(m.otherRequests).toBe(0);
    expect(m.successRate).toBeCloseTo(3 / 5);
    expect(m.errorRate).toBeCloseTo(1 / 5);
    expect(m.pendingRate).toBeCloseTo(1 / 5);
    expect(m.otherRate).toBeCloseTo(0 / 5);
    // successRate + errorRate + pendingRate + otherRate should reconcile to 1.0
    expect(m.successRate + m.errorRate + m.pendingRate + m.otherRate).toBeCloseTo(1.0);
    // statusBreakdown exposes explicit counts
    expect(m.statusBreakdown).toEqual({ success: 3, error: 1, pending: 1, other: 0 });
  });

  // =========================================================================
  // Focused tests: statusBreakdown and pendingRate compatibility
  // =========================================================================
  describe('statusBreakdown and pendingRate compatibility', () => {
    it('exposes statusBreakdown with success, error, pending, and other counts', async () => {
      const now = Date.now();
      await db.insert(schema.requestUsage).values([
        makeRow({
          startTime: now - 1000,
          incomingModelAlias: 'insight-alias',
          responseStatus: 'success',
        }),
        makeRow({
          startTime: now - 2000,
          incomingModelAlias: 'insight-alias',
          responseStatus: 'error',
        }),
        makeRow({
          startTime: now - 3000,
          incomingModelAlias: 'insight-alias',
          responseStatus: 'pending',
        }),
        makeRow({
          startTime: now - 4000,
          incomingModelAlias: 'insight-alias',
          responseStatus: 'timeout',
        }),
      ]);

      const res = await fastify.inject({
        method: 'GET',
        url: '/v0/management/model-insights?model=insight-alias&range=24h',
        headers: { 'x-admin-key': ADMIN_KEY },
      });

      expect(res.statusCode).toBe(200);
      const m = res.json().metrics;
      expect(m.statusBreakdown).toEqual({
        success: 1,
        error: 1,
        pending: 1,
        other: 1,
      });
      expect(m.otherRequests).toBe(1);
      expect(m.otherRate).toBeCloseTo(1 / 4);
    });

    it('pendingRate is exposed and rates reconcile over documented request denominator', async () => {
      const now = Date.now();
      // 3 success, 1 error, 1 pending = 5 total
      await db.insert(schema.requestUsage).values([
        makeRow({
          startTime: now - 1000,
          incomingModelAlias: 'insight-alias',
          responseStatus: 'success',
        }),
        makeRow({
          startTime: now - 2000,
          incomingModelAlias: 'insight-alias',
          responseStatus: 'success',
        }),
        makeRow({
          startTime: now - 3000,
          incomingModelAlias: 'insight-alias',
          responseStatus: 'success',
        }),
        makeRow({
          startTime: now - 4000,
          incomingModelAlias: 'insight-alias',
          responseStatus: 'error',
        }),
        makeRow({
          startTime: now - 5000,
          incomingModelAlias: 'insight-alias',
          responseStatus: 'pending',
        }),
      ]);

      const res = await fastify.inject({
        method: 'GET',
        url: '/v0/management/model-insights?model=insight-alias&range=24h',
        headers: { 'x-admin-key': ADMIN_KEY },
      });

      expect(res.statusCode).toBe(200);
      const m = res.json().metrics;

      // pendingRate should be explicit, not computed manually
      expect(m.pendingRate).toBeCloseTo(1 / 5);
      // All rates sum to 1.0
      expect(m.successRate + m.errorRate + m.pendingRate + m.otherRate).toBeCloseTo(1.0);
      // statusBreakdown counts sum to requests
      const breakdownSum =
        m.statusBreakdown.success +
        m.statusBreakdown.error +
        m.statusBreakdown.pending +
        m.statusBreakdown.other;
      expect(breakdownSum).toBe(m.requests);
    });

    it('existing successRate/errorRate/status count fields remain backward-compatible', async () => {
      const now = Date.now();
      await db.insert(schema.requestUsage).values([
        makeRow({
          startTime: now - 1000,
          incomingModelAlias: 'insight-alias',
          responseStatus: 'success',
        }),
        makeRow({
          startTime: now - 2000,
          incomingModelAlias: 'insight-alias',
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

      // Legacy fields still work
      expect(m.requests).toBe(2);
      expect(m.successfulRequests).toBe(1);
      expect(m.errorRequests).toBe(1);
      expect(m.pendingRequests).toBe(0);
      expect(m.successRate).toBeCloseTo(0.5);
      expect(m.errorRate).toBeCloseTo(0.5);

      // New fields are also present and consistent
      expect(m.otherRequests).toBe(0);
      expect(m.pendingRate).toBeCloseTo(0);
      expect(m.otherRate).toBeCloseTo(0);
      expect(m.statusBreakdown.success).toBe(m.successfulRequests);
      expect(m.statusBreakdown.error).toBe(m.errorRequests);
      expect(m.statusBreakdown.pending).toBe(m.pendingRequests);
      expect(m.statusBreakdown.other).toBe(m.otherRequests);
    });

    it('empty data returns zero statusBreakdown and rates', async () => {
      const res = await fastify.inject({
        method: 'GET',
        url: '/v0/management/model-insights?model=empty-alias&range=24h',
        headers: { 'x-admin-key': ADMIN_KEY },
      });

      expect(res.statusCode).toBe(200);
      const m = res.json().metrics;
      expect(m.statusBreakdown).toEqual({ success: 0, error: 0, pending: 0, other: 0 });
      expect(m.pendingRate).toBe(0);
      expect(m.otherRate).toBe(0);
      expect(m.successRate).toBe(0);
      expect(m.errorRate).toBe(0);
      expect(Number.isFinite(m.pendingRate)).toBe(true);
      expect(Number.isFinite(m.otherRate)).toBe(true);
    });

    it('counts multiple non-standard statuses as other', async () => {
      const now = Date.now();
      await db.insert(schema.requestUsage).values([
        makeRow({
          startTime: now - 1000,
          incomingModelAlias: 'insight-alias',
          responseStatus: 'timeout',
        }),
        makeRow({
          startTime: now - 2000,
          incomingModelAlias: 'insight-alias',
          responseStatus: 'cancelled',
        }),
        makeRow({
          startTime: now - 3000,
          incomingModelAlias: 'insight-alias',
          responseStatus: 'rate_limited',
        }),
      ]);

      const res = await fastify.inject({
        method: 'GET',
        url: '/v0/management/model-insights?model=insight-alias&range=24h',
        headers: { 'x-admin-key': ADMIN_KEY },
      });

      expect(res.statusCode).toBe(200);
      const m = res.json().metrics;
      expect(m.otherRequests).toBe(3);
      expect(m.otherRate).toBeCloseTo(1.0);
      expect(m.statusBreakdown.other).toBe(3);
      expect(m.statusBreakdown.success).toBe(0);
      expect(m.statusBreakdown.error).toBe(0);
      expect(m.statusBreakdown.pending).toBe(0);

      // Legacy error compat: non-standard terminal statuses count toward legacy errorRequests
      expect(m.errorRequests).toBe(3);
      expect(m.errorRate).toBeCloseTo(1.0);
      // Legacy rate reconciliation: successRate + pendingRate + errorRate = 1.0
      expect(m.successRate + m.pendingRate + m.errorRate).toBeCloseTo(1.0);
    });

    it('provider group statusBreakdown and pendingRate reconcile with overall', async () => {
      const now = Date.now();
      await db.insert(schema.requestUsage).values([
        makeRow({
          startTime: now - 1000,
          incomingModelAlias: 'insight-alias',
          provider: 'provider-a',
          responseStatus: 'success',
        }),
        makeRow({
          startTime: now - 2000,
          incomingModelAlias: 'insight-alias',
          provider: 'provider-a',
          responseStatus: 'pending',
        }),
        makeRow({
          startTime: now - 3000,
          incomingModelAlias: 'insight-alias',
          provider: 'provider-b',
          responseStatus: 'error',
        }),
        makeRow({
          startTime: now - 4000,
          incomingModelAlias: 'insight-alias',
          provider: 'provider-b',
          responseStatus: 'timeout',
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

      // Overall status breakdown
      expect(m.statusBreakdown).toEqual({ success: 1, error: 1, pending: 1, other: 1 });
      expect(m.pendingRate).toBeCloseTo(1 / 4);

      // Provider sums reconcile
      const providerSuccess = body.providers.reduce(
        (s: number, p: any) => s + p.metrics.statusBreakdown.success,
        0
      );
      const providerError = body.providers.reduce(
        (s: number, p: any) => s + p.metrics.statusBreakdown.error,
        0
      );
      const providerPending = body.providers.reduce(
        (s: number, p: any) => s + p.metrics.statusBreakdown.pending,
        0
      );
      const providerOther = body.providers.reduce(
        (s: number, p: any) => s + p.metrics.statusBreakdown.other,
        0
      );

      expect(providerSuccess).toBe(m.statusBreakdown.success);
      expect(providerError).toBe(m.statusBreakdown.error);
      expect(providerPending).toBe(m.statusBreakdown.pending);
      expect(providerOther).toBe(m.statusBreakdown.other);

      // Provider pendingRates are consistent with provider-level data
      for (const provider of body.providers) {
        const pm = provider.metrics;
        expect(pm.pendingRate).toBeCloseTo(
          pm.requests > 0 ? pm.pendingRequests / pm.requests : 0
        );
        expect(pm.otherRate).toBeCloseTo(
          pm.requests > 0 ? pm.otherRequests / pm.requests : 0
        );
        // Provider rate reconciliation (legacy: errorRate includes otherRate)
        expect(pm.successRate + pm.errorRate + pm.pendingRate).toBeCloseTo(
          pm.requests > 0 ? 1.0 : 0.0
        );
      }
    });

    it('bucket statusBreakdown reconciles with overall statusBreakdown', async () => {
      const fixedNow = 1700000000000;
      vi.useFakeTimers();
      vi.setSystemTime(fixedNow);

      const rangeStart = fixedNow - 60 * 60 * 1000; // 1h range

      await db.insert(schema.requestUsage).values([
        makeRow({
          startTime: rangeStart,
          incomingModelAlias: 'insight-alias',
          responseStatus: 'success',
        }),
        makeRow({
          startTime: rangeStart + 2 * 60 * 1000,
          incomingModelAlias: 'insight-alias',
          responseStatus: 'error',
        }),
        makeRow({
          startTime: rangeStart + 10 * 60 * 1000,
          incomingModelAlias: 'insight-alias',
          responseStatus: 'pending',
        }),
        makeRow({
          startTime: rangeStart + 20 * 60 * 1000,
          incomingModelAlias: 'insight-alias',
          responseStatus: 'timeout',
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
      const m = body.metrics;

      // Overall statusBreakdown
      expect(m.statusBreakdown).toEqual({ success: 1, error: 1, pending: 1, other: 1 });

      // Bucket statusBreakdown sums reconcile
      const bucketSuccess = body.series.reduce(
        (s: number, b: any) => s + b.metrics.statusBreakdown.success,
        0
      );
      const bucketError = body.series.reduce(
        (s: number, b: any) => s + b.metrics.statusBreakdown.error,
        0
      );
      const bucketPending = body.series.reduce(
        (s: number, b: any) => s + b.metrics.statusBreakdown.pending,
        0
      );
      const bucketOther = body.series.reduce(
        (s: number, b: any) => s + b.metrics.statusBreakdown.other,
        0
      );

      expect(bucketSuccess).toBe(m.statusBreakdown.success);
      expect(bucketError).toBe(m.statusBreakdown.error);
      expect(bucketPending).toBe(m.statusBreakdown.pending);
      expect(bucketOther).toBe(m.statusBreakdown.other);

      // All bucket rates reconcile to 1.0 for non-empty buckets.
      // Legacy: errorRate includes otherRate, so successRate + pendingRate + errorRate = 1.0
      for (const bucket of body.series) {
        const bm = bucket.metrics;
        if (bm.requests > 0) {
          expect(bm.successRate + bm.errorRate + bm.pendingRate).toBeCloseTo(1.0);
        }
      }
    });
  });

  // =========================================================================
  // Terminal status legacy error compatibility
  // =========================================================================
  describe('terminal status legacy error compatibility', () => {
    it('legacy errorRequests counts timeout, stall, cancelled, rate_limited as errors', async () => {
      const now = Date.now();
      await db.insert(schema.requestUsage).values([
        makeRow({
          startTime: now - 1000,
          incomingModelAlias: 'insight-alias',
          responseStatus: 'timeout',
        }),
        makeRow({
          startTime: now - 2000,
          incomingModelAlias: 'insight-alias',
          responseStatus: 'stall',
        }),
        makeRow({
          startTime: now - 3000,
          incomingModelAlias: 'insight-alias',
          responseStatus: 'cancelled',
        }),
        makeRow({
          startTime: now - 4000,
          incomingModelAlias: 'insight-alias',
          responseStatus: 'rate_limited',
        }),
      ]);

      const res = await fastify.inject({
        method: 'GET',
        url: '/v0/management/model-insights?model=insight-alias&range=24h',
        headers: { 'x-admin-key': ADMIN_KEY },
      });
      expect(res.statusCode).toBe(200);
      const m = res.json().metrics;

      // Legacy: all non-success/non-pending statuses count as errors
      expect(m.errorRequests).toBe(4);
      expect(m.errorRate).toBeCloseTo(1.0);

      // Fine-grained statusBreakdown keeps them as "other"
      expect(m.otherRequests).toBe(4);
      expect(m.statusBreakdown.other).toBe(4);
      expect(m.statusBreakdown.error).toBe(0);
      expect(m.statusBreakdown.success).toBe(0);
      expect(m.statusBreakdown.pending).toBe(0);

      // Legacy rate reconciliation: successRate + pendingRate + errorRate = 1.0
      expect(m.successRate + m.pendingRate + m.errorRate).toBeCloseTo(1.0);
    });

    it('mixed success + error + non-standard terminal statuses count toward legacy errorRequests', async () => {
      const now = Date.now();
      await db.insert(schema.requestUsage).values([
        makeRow({
          startTime: now - 1000,
          incomingModelAlias: 'insight-alias',
          responseStatus: 'success',
        }),
        makeRow({
          startTime: now - 2000,
          incomingModelAlias: 'insight-alias',
          responseStatus: 'error',
        }),
        makeRow({
          startTime: now - 3000,
          incomingModelAlias: 'insight-alias',
          responseStatus: 'timeout',
        }),
        makeRow({
          startTime: now - 4000,
          incomingModelAlias: 'insight-alias',
          responseStatus: 'pending',
        }),
      ]);

      const res = await fastify.inject({
        method: 'GET',
        url: '/v0/management/model-insights?model=insight-alias&range=24h',
        headers: { 'x-admin-key': ADMIN_KEY },
      });
      expect(res.statusCode).toBe(200);
      const m = res.json().metrics;

      // Legacy: errorRequests = exact error + timeout (non-success/non-pending terminal)
      expect(m.errorRequests).toBe(2);
      expect(m.errorRate).toBeCloseTo(2 / 4);
      expect(m.successfulRequests).toBe(1);
      expect(m.pendingRequests).toBe(1);

      // Fine-grained statusBreakdown
      expect(m.statusBreakdown).toEqual({ success: 1, error: 1, pending: 1, other: 1 });

      // otherRequests still tracked separately
      expect(m.otherRequests).toBe(1);
      expect(m.otherRate).toBeCloseTo(1 / 4);

      // Legacy rate reconciliation
      expect(m.successRate + m.pendingRate + m.errorRate).toBeCloseTo(1.0);
    });

    it('unknown terminal status counts toward legacy errorRequests and statusBreakdown.other', async () => {
      const now = Date.now();
      await db.insert(schema.requestUsage).values([
        makeRow({
          startTime: now - 1000,
          incomingModelAlias: 'insight-alias',
          responseStatus: 'success',
        }),
        makeRow({
          startTime: now - 2000,
          incomingModelAlias: 'insight-alias',
          responseStatus: 'some_unknown_terminal_status',
        }),
      ]);

      const res = await fastify.inject({
        method: 'GET',
        url: '/v0/management/model-insights?model=insight-alias&range=24h',
        headers: { 'x-admin-key': ADMIN_KEY },
      });
      expect(res.statusCode).toBe(200);
      const m = res.json().metrics;

      // Unknown terminal status counts as error in legacy metric
      expect(m.errorRequests).toBe(1);
      expect(m.errorRate).toBeCloseTo(0.5);

      // Fine-grained: it goes to statusBreakdown.other, not error
      expect(m.statusBreakdown.other).toBe(1);
      expect(m.statusBreakdown.error).toBe(0);
      expect(m.statusBreakdown.success).toBe(1);

      // Legacy rate reconciliation
      expect(m.successRate + m.pendingRate + m.errorRate).toBeCloseTo(1.0);
    });

    it('provider-level errorRequests includes other terminal statuses for legacy compat', async () => {
      const now = Date.now();
      await db.insert(schema.requestUsage).values([
        makeRow({
          startTime: now - 1000,
          incomingModelAlias: 'insight-alias',
          provider: 'provider-a',
          responseStatus: 'success',
        }),
        makeRow({
          startTime: now - 2000,
          incomingModelAlias: 'insight-alias',
          provider: 'provider-b',
          responseStatus: 'timeout',
        }),
        makeRow({
          startTime: now - 3000,
          incomingModelAlias: 'insight-alias',
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
      const body = res.json();
      const m = body.metrics;

      // Overall legacy errorRequests = error + timeout
      expect(m.errorRequests).toBe(2);
      expect(m.errorRate).toBeCloseTo(2 / 3);

      // Provider reconciliation
      const providerErrors = body.providers.reduce(
        (s: number, p: any) => s + p.metrics.errorRequests,
        0
      );
      expect(providerErrors).toBe(m.errorRequests);

      // Provider-b has timeout + error → errorRequests = 2
      const providerB = body.providers.find((p: any) => p.provider === 'provider-b');
      expect(providerB.metrics.errorRequests).toBe(2);
      expect(providerB.metrics.statusBreakdown.error).toBe(1);
      expect(providerB.metrics.statusBreakdown.other).toBe(1);
    });
  });

  // =========================================================================
  // VAL-API-021: Latency percentiles and average latency
  // =========================================================================
  it('computes latency percentiles from completed requests only', async () => {
    const now = Date.now();
    // Completed requests with durations [100, 200, 300, 400, 500]
    await db.insert(schema.requestUsage).values([
      makeRow({
        startTime: now - 1000,
        incomingModelAlias: 'insight-alias',
        responseStatus: 'success',
        durationMs: 100,
      }),
      makeRow({
        startTime: now - 2000,
        incomingModelAlias: 'insight-alias',
        responseStatus: 'success',
        durationMs: 200,
      }),
      makeRow({
        startTime: now - 3000,
        incomingModelAlias: 'insight-alias',
        responseStatus: 'success',
        durationMs: 300,
      }),
      makeRow({
        startTime: now - 4000,
        incomingModelAlias: 'insight-alias',
        responseStatus: 'success',
        durationMs: 400,
      }),
      makeRow({
        startTime: now - 5000,
        incomingModelAlias: 'insight-alias',
        responseStatus: 'success',
        durationMs: 500,
      }),
      // Pending request with null duration - should be excluded
      makeRow({
        startTime: now - 6000,
        incomingModelAlias: 'insight-alias',
        responseStatus: 'pending',
        durationMs: null,
      }),
    ]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const m = res.json().metrics;
    expect(m.avgLatencyMs).toBe(300); // average of [100,200,300,400,500]
    expect(m.p50LatencyMs).toBe(300);
    // Linear interpolation: rank=3.8 => 400+(500-400)*0.8=480
    expect(m.p95LatencyMs).toBeCloseTo(480, 0);
    // rank=3.96 => 400+100*0.96=496
    expect(m.p99LatencyMs).toBeCloseTo(496, 0);
  });

  // =========================================================================
  // VAL-API-022: TTFT averages and percentiles use measured TTFT rows only
  // =========================================================================
  it('computes TTFT from measured rows only (null TTFT excluded)', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values([
      makeRow({ startTime: now - 1000, incomingModelAlias: 'insight-alias', ttftMs: 10 }),
      makeRow({ startTime: now - 2000, incomingModelAlias: 'insight-alias', ttftMs: 20 }),
      makeRow({ startTime: now - 3000, incomingModelAlias: 'insight-alias', ttftMs: 30 }),
      // Row with null TTFT - should be excluded
      makeRow({ startTime: now - 4000, incomingModelAlias: 'insight-alias', ttftMs: null }),
    ]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const m = res.json().metrics;
    expect(m.avgTtftMs).toBe(20); // average of [10, 20, 30]
    expect(m.p50TtftMs).toBe(20);
    // Linear interpolation: rank=(95/100)*2=1.9 => 20+(30-20)*0.9=29
    expect(m.p95TtftMs).toBeCloseTo(29, 0);
    // rank=(99/100)*2=1.98 => 20+10*0.98=29.8
    expect(m.p99TtftMs).toBeCloseTo(29.8, 0);
  });

  // =========================================================================
  // VAL-API-023: Throughput TPS uses provider-reported/stored TPS consistently
  // =========================================================================
  it('computes avgThroughputTps from non-null tokensPerSec rows only', async () => {
    const now = Date.now();
    await db
      .insert(schema.requestUsage)
      .values([
        makeRow({ startTime: now - 1000, incomingModelAlias: 'insight-alias', tokensPerSec: 10 }),
        makeRow({ startTime: now - 2000, incomingModelAlias: 'insight-alias', tokensPerSec: 30 }),
        makeRow({ startTime: now - 3000, incomingModelAlias: 'insight-alias', tokensPerSec: null }),
      ]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const m = res.json().metrics;
    expect(m.avgThroughputTps).toBe(20); // (10+30)/2
  });

  // =========================================================================
  // VAL-API-024: E2E TPS is derived from request_usage duration and generated tokens
  // =========================================================================
  it('computes avgE2eTps from generated tokens / duration, not tokensPerSec', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values([
      makeRow({
        startTime: now - 1000,
        incomingModelAlias: 'insight-alias',
        tokensOutput: 100,
        tokensReasoning: 50,
        durationMs: 1000,
        tokensPerSec: 999, // deliberately different to verify E2E formula is used
        responseStatus: 'success',
      }),
      makeRow({
        startTime: now - 2000,
        incomingModelAlias: 'insight-alias',
        tokensOutput: 200,
        tokensReasoning: 0,
        durationMs: 2000,
        tokensPerSec: 888,
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
    // Row 1: (100+50) / (1000/1000) = 150 TPS
    // Row 2: (200+0) / (2000/1000) = 100 TPS
    // avg = (150+100) / 2 = 125
    expect(m.avgE2eTps).toBe(125);
    // Must NOT be the tokensPerSec average
    expect(m.avgE2eTps).not.toBeCloseTo((999 + 888) / 2);
  });

  // =========================================================================
  // VAL-API-025: Cache hit rate is cached tokens over cacheable input tokens
  // =========================================================================
  it('computes cacheHitRate as cachedTokens / (inputTokens + cachedTokens)', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values([
      makeRow({
        startTime: now - 1000,
        incomingModelAlias: 'insight-alias',
        tokensInput: 300,
        tokensCached: 100,
      }),
      makeRow({
        startTime: now - 2000,
        incomingModelAlias: 'insight-alias',
        tokensInput: 100,
        tokensCached: 50,
      }),
      makeRow({
        startTime: now - 3000,
        incomingModelAlias: 'insight-alias',
        tokensInput: 50,
        tokensCached: 0,
      }),
    ]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const m = res.json().metrics;
    // cached = 150, input = 450 -> 150 / (450 + 150)
    expect(m.cacheHitRate).toBeCloseTo(150 / 600);
  });

  // =========================================================================
  // VAL-API-026: Cost/request and cost per 1M tokens are safe and accurate
  // =========================================================================
  it('computes costPerRequest and costPerMillionTokens with zero-denominator safety', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values([
      makeRow({
        startTime: now - 1000,
        incomingModelAlias: 'insight-alias',
        costTotal: 0.01,
        tokensInput: 1000,
        tokensOutput: 500,
        tokensReasoning: 0,
        tokensCached: 0,
        tokensCacheWrite: 0,
      }),
      makeRow({
        startTime: now - 2000,
        incomingModelAlias: 'insight-alias',
        costTotal: 0.02,
        tokensInput: 1000,
        tokensOutput: 500,
        tokensReasoning: 0,
        tokensCached: 0,
        tokensCacheWrite: 0,
      }),
    ]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const m = res.json().metrics;
    // totalCost = 0.03, requests = 2, totalTokens = 3000
    expect(m.costPerRequest).toBeCloseTo(0.03 / 2, 6);
    expect(m.costPerMillionTokens).toBeCloseTo((0.03 / 3000) * 1_000_000, 2);
  });

  it('returns 0 for costPerRequest and costPerMillionTokens when no data', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=empty-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const m = res.json().metrics;
    expect(m.costPerRequest).toBe(0);
    expect(m.costPerMillionTokens).toBe(0);
    // Must not be NaN or Infinity
    expect(Number.isFinite(m.costPerRequest)).toBe(true);
    expect(Number.isFinite(m.costPerMillionTokens)).toBe(true);
  });

  // =========================================================================
  // VAL-API-027: Provider/model grouping is stable and complete
  // =========================================================================
  it('groups by provider and canonical model identity', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values([
      // providerA + model1
      makeRow({
        startTime: now - 1000,
        incomingModelAlias: 'insight-alias',
        provider: 'provider-a',
        canonicalModelName: 'model-1',
        selectedModelName: 'model-1',
      }),
      // providerA + model2
      makeRow({
        startTime: now - 2000,
        incomingModelAlias: 'insight-alias',
        provider: 'provider-a',
        canonicalModelName: 'model-2',
        selectedModelName: 'model-2',
      }),
      // providerB + model1
      makeRow({
        startTime: now - 3000,
        incomingModelAlias: 'insight-alias',
        provider: 'provider-b',
        canonicalModelName: 'model-1',
        selectedModelName: 'model-1',
      }),
      // null provider
      makeRow({
        startTime: now - 4000,
        incomingModelAlias: 'insight-alias',
        provider: null,
        canonicalModelName: 'model-3',
        selectedModelName: 'model-3',
      }),
    ]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const providers = body.providers;

    // Should have 3 provider groups: provider-a, provider-b, null
    expect(providers.length).toBe(3);

    // provider-a should have 2 model sub-groups
    const providerA = providers.find((p: any) => p.provider === 'provider-a');
    expect(providerA).toBeDefined();
    expect(providerA.metrics.requests).toBe(2);
    expect(providerA.models.length).toBe(2);

    // provider-b should have 1 model sub-group
    const providerB = providers.find((p: any) => p.provider === 'provider-b');
    expect(providerB).toBeDefined();
    expect(providerB.metrics.requests).toBe(1);
    expect(providerB.models.length).toBe(1);

    // null provider
    const nullProvider = providers.find((p: any) => p.provider === null);
    expect(nullProvider).toBeDefined();
    expect(nullProvider.metrics.requests).toBe(1);
  });

  // =========================================================================
  // VAL-API-028: Provider group metrics reconcile with overall metrics
  // =========================================================================
  it('provider group sums reconcile with overall metrics', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values([
      makeRow({
        startTime: now - 1000,
        incomingModelAlias: 'insight-alias',
        provider: 'provider-a',
        tokensInput: 100,
        tokensOutput: 50,
        tokensReasoning: 10,
        tokensCached: 5,
        tokensCacheWrite: 2,
        costTotal: 0.01,
        responseStatus: 'success',
        durationMs: 100,
        ttftMs: 10,
        tokensPerSec: 20,
        isStreamed: 1,
        attemptCount: 1,
      }),
      makeRow({
        startTime: now - 2000,
        incomingModelAlias: 'insight-alias',
        provider: 'provider-b',
        tokensInput: 200,
        tokensOutput: 80,
        tokensReasoning: 15,
        tokensCached: 10,
        tokensCacheWrite: 3,
        costTotal: 0.02,
        responseStatus: 'error',
        durationMs: 200,
        ttftMs: 20,
        tokensPerSec: 30,
        isStreamed: 0,
        attemptCount: 2,
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
    const providers = body.providers;

    // Sum provider request counts
    const totalProviderRequests = providers.reduce(
      (sum: number, p: any) => sum + p.metrics.requests,
      0
    );
    expect(totalProviderRequests).toBe(m.requests);

    // Sum provider token counts
    const totalInputTokens = providers.reduce(
      (sum: number, p: any) => sum + p.metrics.inputTokens,
      0
    );
    expect(totalInputTokens).toBe(m.inputTokens);

    // Sum provider cost
    const totalCost = providers.reduce((sum: number, p: any) => sum + p.metrics.totalCost, 0);
    expect(totalCost).toBeCloseTo(m.totalCost, 6);

    // Sum streamed/nonStreamed
    const totalStreamed = providers.reduce(
      (sum: number, p: any) => sum + p.metrics.streamedRequests,
      0
    );
    const totalNonStreamed = providers.reduce(
      (sum: number, p: any) => sum + p.metrics.nonStreamedRequests,
      0
    );
    expect(totalStreamed).toBe(m.streamedRequests);
    expect(totalNonStreamed).toBe(m.nonStreamedRequests);

    // Sum status counts
    const totalSuccessful = providers.reduce(
      (sum: number, p: any) => sum + p.metrics.successfulRequests,
      0
    );
    const totalErrors = providers.reduce((sum: number, p: any) => sum + p.metrics.errorRequests, 0);
    expect(totalSuccessful).toBe(m.successfulRequests);
    expect(totalErrors).toBe(m.errorRequests);
  });

  // =========================================================================
  // VAL-API-029: Time-series buckets are sorted, stable, and range-appropriate
  // =========================================================================
  it('returns sorted ascending series with consistent bucketSizeMs', async () => {
    const fixedNow = 1700000000000;
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);

    // Seed rows across multiple hours for 24h range
    await db.insert(schema.requestUsage).values([
      makeRow({
        startTime: fixedNow - 2 * 60 * 60 * 1000,
        incomingModelAlias: 'insight-alias',
        tokensInput: 100,
      }),
      makeRow({
        startTime: fixedNow - 5 * 60 * 60 * 1000,
        incomingModelAlias: 'insight-alias',
        tokensInput: 200,
      }),
      makeRow({
        startTime: fixedNow - 10 * 60 * 60 * 1000,
        incomingModelAlias: 'insight-alias',
        tokensInput: 300,
      }),
    ]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    vi.useRealTimers();

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const series = body.series;

    // Verify ascending order
    for (let i = 1; i < series.length; i++) {
      expect(series[i]!.bucketStartMs).toBeGreaterThan(series[i - 1]!.bucketStartMs);
    }

    // All buckets within range bounds
    for (const bucket of series) {
      expect(bucket.bucketStartMs).toBeGreaterThanOrEqual(body.range.startTimeMs);
      expect(bucket.bucketStartMs).toBeLessThanOrEqual(body.range.endTimeMs);
    }
  });

  // =========================================================================
  // VAL-API-030: Bucket metrics are assigned exactly once and reconcile
  // =========================================================================
  it('bucket sums reconcile with overall metrics', async () => {
    const fixedNow = 1700000000000;
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);

    // Use 1h range with 5-min buckets for precision
    await db.insert(schema.requestUsage).values([
      makeRow({
        startTime: fixedNow - 10 * 60 * 1000,
        incomingModelAlias: 'insight-alias',
        tokensInput: 100,
        costTotal: 0.01,
      }),
      makeRow({
        startTime: fixedNow - 20 * 60 * 1000,
        incomingModelAlias: 'insight-alias',
        tokensInput: 200,
        costTotal: 0.02,
      }),
      makeRow({
        startTime: fixedNow - 30 * 60 * 1000,
        incomingModelAlias: 'insight-alias',
        tokensInput: 300,
        costTotal: 0.03,
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

    // Sum bucket requests
    const bucketRequests = body.series.reduce((sum: number, b: any) => sum + b.metrics.requests, 0);
    expect(bucketRequests).toBe(body.metrics.requests);

    // Sum bucket tokens
    const bucketInputTokens = body.series.reduce(
      (sum: number, b: any) => sum + b.metrics.inputTokens,
      0
    );
    expect(bucketInputTokens).toBe(body.metrics.inputTokens);

    // Sum bucket costs
    const bucketTotalCost = body.series.reduce(
      (sum: number, b: any) => sum + b.metrics.totalCost,
      0
    );
    expect(bucketTotalCost).toBeCloseTo(body.metrics.totalCost, 6);
  });

  // =========================================================================
  // VAL-API-031: Streamed versus non-streamed split is correct
  // =========================================================================
  it('counts streamed and nonStreamed requests correctly', async () => {
    const now = Date.now();
    await db
      .insert(schema.requestUsage)
      .values([
        makeRow({ startTime: now - 1000, incomingModelAlias: 'insight-alias', isStreamed: 1 }),
        makeRow({ startTime: now - 2000, incomingModelAlias: 'insight-alias', isStreamed: 1 }),
        makeRow({ startTime: now - 3000, incomingModelAlias: 'insight-alias', isStreamed: 0 }),
        makeRow({ startTime: now - 4000, incomingModelAlias: 'insight-alias', isStreamed: 0 }),
        makeRow({ startTime: now - 5000, incomingModelAlias: 'insight-alias', isStreamed: 0 }),
      ]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const m = res.json().metrics;
    expect(m.streamedRequests).toBe(2);
    expect(m.nonStreamedRequests).toBe(3);
    expect(m.streamedRequests + m.nonStreamedRequests).toBe(m.requests);
  });

  // =========================================================================
  // VAL-API-032: Retry and failover metrics from request_usage routing metadata
  // =========================================================================
  it('computes retry and failover metrics from attemptCount', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values([
      makeRow({
        startTime: now - 1000,
        incomingModelAlias: 'insight-alias',
        attemptCount: 1,
        allAttemptedProviders: JSON.stringify(['provider-a/model-1']),
      }),
      makeRow({
        startTime: now - 2000,
        incomingModelAlias: 'insight-alias',
        attemptCount: 2,
        allAttemptedProviders: JSON.stringify(['provider-a/model-1', 'provider-b/model-1']),
      }),
      makeRow({
        startTime: now - 3000,
        incomingModelAlias: 'insight-alias',
        attemptCount: 3,
        allAttemptedProviders: JSON.stringify([
          'provider-a/model-1',
          'provider-b/model-1',
          'provider-c/model-1',
        ]),
      }),
    ]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const m = res.json().metrics;
    // totalRetryAttempts = sum(attemptCount - 1) = 0 + 1 + 2 = 3
    expect(m.totalRetryAttempts).toBe(3);
    // failoverRequests = cross-provider attempts = 2 (rows 2 and 3)
    expect(m.failoverRequests).toBe(2);
    // avgAttempts = (1+2+3)/3 = 2
    expect(m.avgAttempts).toBeCloseTo(2.0);
  });

  // =========================================================================
  // VAL-API-033: Source of truth excludes provider_performance-only data
  // =========================================================================
  it('does not use provider_performance data (request_usage is source of truth)', async () => {
    // Seed provider_performance rows but NO request_usage for empty-alias
    const perfSchema = schema.providerPerformance;
    if (perfSchema) {
      await db
        .insert(perfSchema)
        .values({
          provider: 'provider-x',
          model: 'some-model',
          canonicalModelName: 'some-model',
          requestId: 'perf-req-1',
          timeToFirstTokenMs: 100,
          totalTokens: 500,
          durationMs: 1000,
          tokensPerSec: 500,
          e2eTokensPerSec: 500,
          failureCount: 0,
          successCount: 1,
          createdAt: Date.now(),
        })
        .catch(() => {
          // If insert fails due to schema mismatch, that's fine - the test
          // still validates that the endpoint returns zero without request_usage
        });
    }

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=empty-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const m = res.json().metrics;
    // No request_usage rows for empty-alias, so everything should be 0
    // regardless of any provider_performance data
    expect(m.requests).toBe(0);
    expect(m.totalTokens).toBe(0);
    expect(m.avgTtftMs).toBe(0);
    expect(m.avgThroughputTps).toBe(0);
    expect(m.totalCost).toBe(0);
  });

  // =========================================================================
  // VAL-API-034: API call is side-effect free and does not create usage records
  // =========================================================================
  it('does not create usage records or change state on repeated GETs', async () => {
    const now = Date.now();
    await db
      .insert(schema.requestUsage)
      .values(
        makeRow({ startTime: now - 1000, incomingModelAlias: 'insight-alias', tokensInput: 50 })
      );

    // Get initial count
    const countBefore = await db.select({ count: sql`count(*)` }).from(schema.requestUsage);

    // Call model-insights twice
    const res1 = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });
    const res2 = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);

    // Count should be unchanged
    const countAfter = await db.select({ count: sql`count(*)` }).from(schema.requestUsage);
    expect(Number(countAfter[0]!.count)).toBe(Number(countBefore[0]!.count));

    // Both responses should have the same metrics
    expect(res1.json().metrics.requests).toBe(res2.json().metrics.requests);
    expect(res1.json().metrics.inputTokens).toBe(res2.json().metrics.inputTokens);
  });

  // =========================================================================
  // VAL-API-040: Estimated and descriptor usage handling is explicit
  // =========================================================================
  it('includes estimated/descriptor rows with explicit attribution indicators', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values([
      // Normal row
      makeRow({
        startTime: now - 1000,
        incomingModelAlias: 'insight-alias',
        tokensInput: 100,
        tokensOutput: 50,
        tokensEstimated: 0,
        isDescriptorRequest: 0,
        isVisionFallthrough: 0,
        costTotal: 0.01,
      }),
      // Estimated token row
      makeRow({
        startTime: now - 2000,
        incomingModelAlias: 'insight-alias',
        tokensInput: 200,
        tokensOutput: 80,
        tokensEstimated: 1,
        isDescriptorRequest: 0,
        isVisionFallthrough: 0,
        costTotal: 0.02,
      }),
      // Descriptor/vision fallthrough row
      makeRow({
        startTime: now - 3000,
        incomingModelAlias: 'insight-alias',
        tokensInput: 50,
        tokensOutput: 20,
        tokensEstimated: 0,
        isDescriptorRequest: 1,
        isVisionFallthrough: 1,
        costTotal: 0.005,
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

    // All rows should be included in counts
    expect(m.requests).toBe(3);
    expect(m.inputTokens).toBe(350); // 100 + 200 + 50
    expect(m.totalCost).toBeCloseTo(0.035, 6);

    // Explicit estimated/descriptor attribution indicators should exist
    expect(typeof m.estimatedTokensCount).toBe('number');
    expect(typeof m.descriptorRequestCount).toBe('number');
    expect(typeof m.visionFallthroughCount).toBe('number');
    expect(m.estimatedTokensCount).toBe(1);
    expect(m.descriptorRequestCount).toBe(1);
    expect(m.visionFallthroughCount).toBe(1);
  });

  it('returns zero estimated/descriptor indicators when no such rows exist', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values(
      makeRow({
        startTime: now - 1000,
        incomingModelAlias: 'insight-alias',
        tokensInput: 100,
        tokensEstimated: 0,
        isDescriptorRequest: 0,
        isVisionFallthrough: 0,
      })
    );

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const m = res.json().metrics;
    expect(m.estimatedTokensCount).toBe(0);
    expect(m.descriptorRequestCount).toBe(0);
    expect(m.visionFallthroughCount).toBe(0);
  });

  // =========================================================================
  // Whitespace-padded model handling
  // =========================================================================

  it('rejects whitespace-padded non-empty model as malformed', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=%20gpt-4%20&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.message).toContain('model');
    expect(body.error.message.toLowerCase()).toContain('whitespace');
  });

  it('rejects model with leading whitespace as malformed', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=%20gpt-4&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.message).toContain('model');
  });

  it('rejects model with trailing whitespace as malformed', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=gpt-4%20&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.message).toContain('model');
  });

  it('whitespace-only model remains 400', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=%20%20%20&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.message).toContain('model');
  });

  it('accepts model with internal spaces but no padding', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values(
      makeRow({
        startTime: now - 1000,
        incomingModelAlias: 'gpt 4 turbo',
        tokensInput: 50,
      })
    );

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=gpt%204%20turbo&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.model).toBe('gpt 4 turbo');
    expect(body.metrics.requests).toBe(1);
  });

  // =========================================================================
  // Bucket anchoring: no bucket starts before range.startTimeMs
  // =========================================================================

  it('series bucketStartMs values are anchored to range.startTimeMs', async () => {
    const fixedNow = 1700000000000;
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);

    // Use 1h range with 5-min buckets
    const oneHourAgo = fixedNow - 60 * 60 * 1000;
    await db.insert(schema.requestUsage).values([
      makeRow({
        startTime: oneHourAgo, // exactly at startTimeMs, should be in first bucket
        incomingModelAlias: 'insight-alias',
        tokensInput: 100,
      }),
      // Row near the middle
      makeRow({
        startTime: fixedNow - 30 * 60 * 1000,
        incomingModelAlias: 'insight-alias',
        tokensInput: 50,
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
    const { startTimeMs, endTimeMs, bucketSizeMs } = body.range;

    // Every bucket must start at or after startTimeMs
    for (const bucket of body.series) {
      expect(bucket.bucketStartMs).toBeGreaterThanOrEqual(startTimeMs);
    }

    // Every bucket must start before endTimeMs
    for (const bucket of body.series) {
      expect(bucket.bucketStartMs).toBeLessThan(endTimeMs);
    }

    // First bucket should start exactly at startTimeMs (anchored)
    if (body.series.length > 0) {
      expect(body.series[0].bucketStartMs).toBe(startTimeMs);
    }
  });

  it('no bucket starts before range.startTimeMs for 5h range', async () => {
    const fixedNow = 1700000000000;
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);

    const fiveHoursAgo = fixedNow - 5 * 60 * 60 * 1000;
    await db.insert(schema.requestUsage).values([
      makeRow({
        startTime: fiveHoursAgo, // exactly at startTimeMs
        incomingModelAlias: 'insight-alias',
        tokensInput: 100,
      }),
      // Row in middle
      makeRow({
        startTime: fixedNow - 2 * 60 * 60 * 1000,
        incomingModelAlias: 'insight-alias',
        tokensInput: 200,
      }),
    ]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=5h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    vi.useRealTimers();

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const { startTimeMs } = body.range;

    for (const bucket of body.series) {
      expect(bucket.bucketStartMs).toBeGreaterThanOrEqual(startTimeMs);
    }

    // First bucket should be anchored to startTimeMs
    if (body.series.length > 0) {
      expect(body.series[0].bucketStartMs).toBe(startTimeMs);
    }
  });

  it('bucket metrics reconcile with top-level metrics at range boundaries', async () => {
    const fixedNow = 1700000000000;
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);

    // 1h range, 5-min buckets
    const oneHourAgo = fixedNow - 60 * 60 * 1000;

    // Row right at the start of the range (exactly at startTimeMs)
    await db.insert(schema.requestUsage).values(
      makeRow({
        startTime: oneHourAgo,
        incomingModelAlias: 'insight-alias',
        tokensInput: 50,
        costTotal: 0.01,
        responseStatus: 'success',
      })
    );

    // Row near the end of the range
    await db.insert(schema.requestUsage).values(
      makeRow({
        startTime: fixedNow - 500, // near end
        incomingModelAlias: 'insight-alias',
        tokensInput: 100,
        costTotal: 0.02,
        responseStatus: 'success',
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

    // All buckets within bounds
    for (const bucket of body.series) {
      expect(bucket.bucketStartMs).toBeGreaterThanOrEqual(body.range.startTimeMs);
      expect(bucket.bucketStartMs).toBeLessThanOrEqual(body.range.endTimeMs);
    }

    // Bucket sums reconcile with overall
    const bucketRequests = body.series.reduce((sum: number, b: any) => sum + b.metrics.requests, 0);
    expect(bucketRequests).toBe(body.metrics.requests);

    const bucketInputTokens = body.series.reduce(
      (sum: number, b: any) => sum + b.metrics.inputTokens,
      0
    );
    expect(bucketInputTokens).toBe(body.metrics.inputTokens);

    const bucketCost = body.series.reduce((sum: number, b: any) => sum + b.metrics.totalCost, 0);
    expect(bucketCost).toBeCloseTo(body.metrics.totalCost, 6);
  });

  // =========================================================================
  // Cross-check: provider/model group reconciliation with buckets
  // =========================================================================
  it('provider group and bucket sums both reconcile to overall metrics', async () => {
    const fixedNow = 1700000000000;
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);

    await db.insert(schema.requestUsage).values([
      makeRow({
        startTime: fixedNow - 1 * 60 * 60 * 1000,
        incomingModelAlias: 'insight-alias',
        provider: 'provider-a',
        canonicalModelName: 'model-1',
        tokensInput: 100,
        costTotal: 0.01,
        responseStatus: 'success',
      }),
      makeRow({
        startTime: fixedNow - 2 * 60 * 60 * 1000,
        incomingModelAlias: 'insight-alias',
        provider: 'provider-b',
        canonicalModelName: 'model-2',
        tokensInput: 200,
        costTotal: 0.02,
        responseStatus: 'success',
      }),
      makeRow({
        startTime: fixedNow - 3 * 60 * 60 * 1000,
        incomingModelAlias: 'insight-alias',
        provider: 'provider-a',
        canonicalModelName: 'model-1',
        tokensInput: 150,
        costTotal: 0.015,
        responseStatus: 'error',
      }),
    ]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    vi.useRealTimers();

    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Provider group sums
    const providerRequests = body.providers.reduce(
      (s: number, p: any) => s + p.metrics.requests,
      0
    );
    expect(providerRequests).toBe(body.metrics.requests);

    const providerInputTokens = body.providers.reduce(
      (s: number, p: any) => s + p.metrics.inputTokens,
      0
    );
    expect(providerInputTokens).toBe(body.metrics.inputTokens);

    const providerCost = body.providers.reduce((s: number, p: any) => s + p.metrics.totalCost, 0);
    expect(providerCost).toBeCloseTo(body.metrics.totalCost, 6);

    // Bucket sums
    const bucketRequests = body.series.reduce((s: number, b: any) => s + b.metrics.requests, 0);
    expect(bucketRequests).toBe(body.metrics.requests);

    const bucketInputTokens = body.series.reduce(
      (s: number, b: any) => s + b.metrics.inputTokens,
      0
    );
    expect(bucketInputTokens).toBe(body.metrics.inputTokens);
  });

  // =========================================================================
  // Scrutiny fix: costSource 'provider_reported' recognized for cost attribution
  // =========================================================================
  it('recognizes production costSource value provider_reported for cost attribution', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values([
      // Row with production provider-reported cost source
      makeRow({
        startTime: now - 1000,
        incomingModelAlias: 'insight-alias',
        costTotal: 0.042,
        costSource: 'provider_reported',
        providerReportedCost: 0.042,
      }),
      // Row with legacy 'provider' source (no longer used in production)
      makeRow({
        startTime: now - 2000,
        incomingModelAlias: 'insight-alias',
        costTotal: 0.01,
        costSource: 'provider',
        providerReportedCost: 0.01,
      }),
      // Row with calculated cost (simple pricing)
      makeRow({
        startTime: now - 3000,
        incomingModelAlias: 'insight-alias',
        costTotal: 0.025,
        costSource: 'simple',
        providerReportedCost: null,
      }),
    ]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const m = res.json().metrics;

    // totalCost must equal sum of all costTotal values
    expect(m.totalCost).toBeCloseTo(0.077, 6);

    // provider_reported row should be counted as provider-reported cost
    expect(m.providerReportedCost).toBeCloseTo(0.042, 6);
    expect(m.providerReportedCostCount).toBe(1);

    // calculatedCost should include simple + legacy 'provider' rows
    expect(m.calculatedCost).toBeCloseTo(0.035, 6);
  });

  it('totalCost stays tied to request_usage.costTotal regardless of costSource', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values([
      makeRow({
        startTime: now - 1000,
        incomingModelAlias: 'insight-alias',
        costTotal: 0.05,
        costSource: 'provider_reported',
        providerReportedCost: 0.06, // different from costTotal
      }),
      makeRow({
        startTime: now - 2000,
        incomingModelAlias: 'insight-alias',
        costTotal: 0.03,
        costSource: 'simple',
        providerReportedCost: null,
      }),
    ]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const m = res.json().metrics;
    // totalCost = sum of costTotal, NOT providerReportedCost
    expect(m.totalCost).toBeCloseTo(0.08, 6);
    // providerReportedCost uses the providerReportedCost field
    expect(m.providerReportedCost).toBeCloseTo(0.06, 6);
  });

  // =========================================================================
  // Scrutiny fix: failoverRequests counts only cross-provider failover
  // =========================================================================
  it('same-provider retries do not increment failoverRequests', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values([
      // Single attempt, no failover
      makeRow({
        startTime: now - 1000,
        incomingModelAlias: 'insight-alias',
        attemptCount: 1,
        allAttemptedProviders: JSON.stringify(['provider-a/model-1']),
      }),
      // Same-provider retry (3 attempts, all same provider)
      makeRow({
        startTime: now - 2000,
        incomingModelAlias: 'insight-alias',
        attemptCount: 3,
        allAttemptedProviders: JSON.stringify([
          'provider-a/model-1',
          'provider-a/model-1',
          'provider-a/model-1',
        ]),
        retryHistory: JSON.stringify([
          { provider: 'provider-a', model: 'model-1', status: 'error' },
          { provider: 'provider-a', model: 'model-1', status: 'error' },
        ]),
        finalAttemptProvider: 'provider-a',
        finalAttemptModel: 'model-1',
      }),
      // Another same-provider retry (2 attempts, same provider)
      makeRow({
        startTime: now - 3000,
        incomingModelAlias: 'insight-alias',
        attemptCount: 2,
        allAttemptedProviders: JSON.stringify(['provider-a/model-1', 'provider-a/model-1']),
        retryHistory: JSON.stringify([
          { provider: 'provider-a', model: 'model-1', status: 'error' },
        ]),
        finalAttemptProvider: 'provider-a',
        finalAttemptModel: 'model-1',
      }),
    ]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const m = res.json().metrics;
    // Same-provider retries should NOT count as failover
    expect(m.failoverRequests).toBe(0);
    // But retry attempts should still be tracked
    // totalRetryAttempts = (1-1) + (3-1) + (2-1) = 0 + 2 + 1 = 3
    expect(m.totalRetryAttempts).toBe(3);
    // avgAttempts = (1+3+2)/3 = 2
    expect(m.avgAttempts).toBeCloseTo(2.0);
  });

  it('cross-provider failover increments failoverRequests', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values([
      // Single attempt, no failover
      makeRow({
        startTime: now - 1000,
        incomingModelAlias: 'insight-alias',
        attemptCount: 1,
        allAttemptedProviders: JSON.stringify(['provider-a/model-1']),
        provider: 'provider-a',
      }),
      // Cross-provider failover: provider-a -> provider-b
      makeRow({
        startTime: now - 2000,
        incomingModelAlias: 'insight-alias',
        attemptCount: 2,
        allAttemptedProviders: JSON.stringify(['provider-a/model-1', 'provider-b/model-1']),
        retryHistory: JSON.stringify([
          { provider: 'provider-a', model: 'model-1', status: 'error' },
        ]),
        finalAttemptProvider: 'provider-b',
        finalAttemptModel: 'model-1',
        provider: 'provider-b',
      }),
      // Cross-provider failover: provider-a -> provider-b -> provider-c
      makeRow({
        startTime: now - 3000,
        incomingModelAlias: 'insight-alias',
        attemptCount: 3,
        allAttemptedProviders: JSON.stringify([
          'provider-a/model-1',
          'provider-b/model-2',
          'provider-c/model-3',
        ]),
        retryHistory: JSON.stringify([
          { provider: 'provider-a', model: 'model-1', status: 'error' },
          { provider: 'provider-b', model: 'model-2', status: 'error' },
        ]),
        finalAttemptProvider: 'provider-c',
        finalAttemptModel: 'model-3',
        provider: 'provider-c',
      }),
    ]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const m = res.json().metrics;
    // Cross-provider failovers should be counted
    expect(m.failoverRequests).toBe(2);
    // totalRetryAttempts = (1-1) + (2-1) + (3-1) = 0 + 1 + 2 = 3
    expect(m.totalRetryAttempts).toBe(3);
    // avgAttempts = (1+2+3)/3 = 2
    expect(m.avgAttempts).toBeCloseTo(2.0);
  });

  it('mixed same-provider retries and cross-provider failovers', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values([
      // Same-provider retry (no failover)
      makeRow({
        startTime: now - 1000,
        incomingModelAlias: 'insight-alias',
        attemptCount: 2,
        allAttemptedProviders: JSON.stringify(['provider-a/model-1', 'provider-a/model-1']),
        finalAttemptProvider: 'provider-a',
        provider: 'provider-a',
      }),
      // Cross-provider failover
      makeRow({
        startTime: now - 2000,
        incomingModelAlias: 'insight-alias',
        attemptCount: 2,
        allAttemptedProviders: JSON.stringify(['provider-a/model-1', 'provider-b/model-2']),
        finalAttemptProvider: 'provider-b',
        provider: 'provider-b',
      }),
      // Single attempt
      makeRow({
        startTime: now - 3000,
        incomingModelAlias: 'insight-alias',
        attemptCount: 1,
        allAttemptedProviders: JSON.stringify(['provider-a/model-1']),
        provider: 'provider-a',
      }),
    ]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const m = res.json().metrics;
    // Only cross-provider failover counts
    expect(m.failoverRequests).toBe(1);
    // totalRetryAttempts = (2-1) + (2-1) + (1-1) = 1 + 1 + 0 = 2
    expect(m.totalRetryAttempts).toBe(2);
    // avgAttempts = (2+2+1)/3 = 5/3
    expect(m.avgAttempts).toBeCloseTo(5 / 3);
  });

  it('failoverRequests handles null allAttemptedProviders gracefully', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values([
      // Row with attemptCount > 1 but no allAttemptedProviders metadata
      makeRow({
        startTime: now - 1000,
        incomingModelAlias: 'insight-alias',
        attemptCount: 2,
        allAttemptedProviders: null,
        provider: 'provider-a',
      }),
      // Row with empty allAttemptedProviders array
      makeRow({
        startTime: now - 2000,
        incomingModelAlias: 'insight-alias',
        attemptCount: 1,
        allAttemptedProviders: JSON.stringify([]),
        provider: 'provider-a',
      }),
    ]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/model-insights?model=insight-alias&range=24h',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const m = res.json().metrics;
    // null/missing allAttemptedProviders with multiple attempts:
    // cannot determine cross-provider, so should not count as failover
    expect(m.failoverRequests).toBe(0);
    expect(m.totalRetryAttempts).toBe(1); // (2-1) + (1-1)
  });

  // =========================================================================
  // Failover error-path fixes: failed/exhausted cross-provider attempts
  // =========================================================================

  it('counts failed cross-provider attempt as failover when allAttemptedProviders is absent', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values([
      // Failed/exhausted request: attemptCount > 1, allAttemptedProviders is null,
      // but retryHistory shows cross-provider attempts
      makeRow({
        startTime: now - 1000,
        incomingModelAlias: 'insight-alias',
        attemptCount: 3,
        allAttemptedProviders: null, // absent due to error path
        retryHistory: JSON.stringify([
          { provider: 'provider-a', model: 'model-1', status: 'error' },
          { provider: 'provider-b', model: 'model-2', status: 'error' },
        ]),
        finalAttemptProvider: 'provider-c',
        finalAttemptModel: 'model-3',
        provider: 'provider-c',
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
    // Should detect cross-provider from retryHistory
    expect(m.failoverRequests).toBe(1);
    expect(m.totalRetryAttempts).toBe(2); // 3 - 1
    expect(m.avgAttempts).toBeCloseTo(3.0);
  });

  it('counts exhausted cross-provider attempt as failover when allAttemptedProviders is absent but retryHistory is present', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values([
      // All targets exhausted: 2 providers tried, both failed
      makeRow({
        startTime: now - 1000,
        incomingModelAlias: 'insight-alias',
        attemptCount: 2,
        allAttemptedProviders: null,
        retryHistory: JSON.stringify([
          { provider: 'provider-a', model: 'model-1', status: 'error' },
        ]),
        finalAttemptProvider: 'provider-b',
        finalAttemptModel: 'model-2',
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
    // Cross-provider: provider-a -> provider-b
    expect(m.failoverRequests).toBe(1);
    expect(m.totalRetryAttempts).toBe(1); // 2 - 1
  });

  it('uses finalAttemptProvider vs provider to detect cross-provider failover when retryHistory is also absent', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values([
      // Failed request with only finalAttemptProvider/provider mismatch
      makeRow({
        startTime: now - 1000,
        incomingModelAlias: 'insight-alias',
        attemptCount: 2,
        allAttemptedProviders: null,
        retryHistory: null,
        finalAttemptProvider: 'provider-b',
        finalAttemptModel: 'model-2',
        provider: 'provider-b', // final provider (not the initial one)
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
    // Should detect cross-provider from finalAttemptProvider vs retryHistory entries
    // With attemptCount=2, retryHistory=null, allAttemptedProviders=null,
    // and no other metadata to check, we can't definitively determine cross-provider.
    // The row should NOT be counted as failover since there's insufficient evidence.
    expect(m.failoverRequests).toBe(0);
    expect(m.totalRetryAttempts).toBe(1); // 2 - 1
  });

  it('detects cross-provider from retryHistory even when allAttemptedProviders is non-string', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values([
      makeRow({
        startTime: now - 1000,
        incomingModelAlias: 'insight-alias',
        attemptCount: 2,
        allAttemptedProviders: 'not-valid-json', // non-JSON string
        retryHistory: JSON.stringify([
          { provider: 'provider-a', model: 'model-1', status: 'error' },
        ]),
        finalAttemptProvider: 'provider-b',
        finalAttemptModel: 'model-2',
        provider: 'provider-b',
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
    // allAttemptedProviders is not valid JSON, but retryHistory shows provider-a,
    // and finalAttemptProvider is provider-b -> cross-provider
    expect(m.failoverRequests).toBe(1);
  });

  it('handles allAttemptedProviders as JSON array (already parsed)', async () => {
    const now = Date.now();
    // In some edge cases allAttemptedProviders might already be a parsed array
    // (e.g., from routingContext that wasn't stringified). The DB column stores
    // strings, but if a bug or race condition stores a non-JSON value like a
    // comma-separated string, we should try to parse it.
    await db.insert(schema.requestUsage).values([
      makeRow({
        startTime: now - 1000,
        incomingModelAlias: 'insight-alias',
        attemptCount: 2,
        allAttemptedProviders: 'provider-a/model-1,provider-b/model-2', // comma-separated, not JSON
        retryHistory: JSON.stringify([
          { provider: 'provider-a', model: 'model-1', status: 'error' },
        ]),
        finalAttemptProvider: 'provider-b',
        provider: 'provider-b',
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
    // Should detect cross-provider via retryHistory fallback
    expect(m.failoverRequests).toBe(1);
  });

  // =========================================================================
  // Native array allAttemptedProviders (scrutiny fix)
  // =========================================================================

  describe('native array allAttemptedProviders', () => {
    // These tests directly exercise detectCrossProviderFailover with native
    // array values for allAttemptedProviders, which can occur when the
    // dispatcher's error/exhausted path stores the routingContext without
    // JSON.stringify on the array.

    let detectCrossProviderFailover: (row: any) => boolean;

    beforeEach(async () => {
      // Import the exported function for direct unit testing
      const mod = await import('../model-insights');
      detectCrossProviderFailover = mod.detectCrossProviderFailover;
    });

    it('detects cross-provider failover from native array with missing retryHistory', () => {
      // Native array with multiple distinct providers, no retryHistory
      const row = {
        allAttemptedProviders: ['provider-a/model-1', 'provider-b/model-2'] as unknown as string,
        attemptCount: 2,
        retryHistory: null,
        finalAttemptProvider: 'provider-b',
        finalAttemptModel: 'model-2',
        provider: 'provider-b',
      };

      expect(detectCrossProviderFailover(row)).toBe(true);
    });

    it('detects cross-provider failover from native array with unparseable retryHistory', () => {
      // Native array with multiple distinct providers and broken retryHistory
      const row = {
        allAttemptedProviders: ['provider-a/model-1', 'provider-b/model-2'] as unknown as string,
        attemptCount: 2,
        retryHistory: 'not-valid-json',
        finalAttemptProvider: 'provider-b',
        finalAttemptModel: 'model-2',
        provider: 'provider-b',
      };

      expect(detectCrossProviderFailover(row)).toBe(true);
    });

    it('does NOT count same-provider native array as failover', () => {
      // Native array with only one distinct provider (same provider retried)
      const row = {
        allAttemptedProviders: ['provider-a/model-1', 'provider-a/model-1'] as unknown as string,
        attemptCount: 2,
        retryHistory: null,
        finalAttemptProvider: 'provider-a',
        finalAttemptModel: 'model-1',
        provider: 'provider-a',
      };

      expect(detectCrossProviderFailover(row)).toBe(false);
    });

    it('does NOT count single-provider native array as failover', () => {
      const row = {
        allAttemptedProviders: ['provider-a/model-1'] as unknown as string,
        attemptCount: 1,
        retryHistory: null,
        finalAttemptProvider: 'provider-a',
        finalAttemptModel: 'model-1',
        provider: 'provider-a',
      };

      expect(detectCrossProviderFailover(row)).toBe(false);
    });

    it('detects cross-provider with three distinct providers in native array', () => {
      const row = {
        allAttemptedProviders: [
          'provider-a/model-1',
          'provider-b/model-2',
          'provider-c/model-3',
        ] as unknown as string,
        attemptCount: 3,
        retryHistory: null,
        finalAttemptProvider: 'provider-c',
        finalAttemptModel: 'model-3',
        provider: 'provider-c',
      };

      expect(detectCrossProviderFailover(row)).toBe(true);
    });

    it('still handles JSON string allAttemptedProviders correctly', () => {
      // Ensure existing JSON string behavior is not broken
      const row = {
        allAttemptedProviders: JSON.stringify(['provider-a/model-1', 'provider-b/model-2']),
        attemptCount: 2,
        retryHistory: null,
        finalAttemptProvider: 'provider-b',
        finalAttemptModel: 'model-2',
        provider: 'provider-b',
      };

      expect(detectCrossProviderFailover(row)).toBe(true);
    });

    it('falls back to retryHistory when allAttemptedProviders is null', () => {
      const row = {
        allAttemptedProviders: null,
        attemptCount: 2,
        retryHistory: JSON.stringify([
          { provider: 'provider-a', model: 'model-1', status: 'error' },
        ]),
        finalAttemptProvider: 'provider-b',
        finalAttemptModel: 'model-2',
        provider: 'provider-b',
      };

      expect(detectCrossProviderFailover(row)).toBe(true);
    });
  });

  // =========================================================================
  // computeMetrics aggregation path: native array allAttemptedProviders
  // =========================================================================

  describe('computeMetrics aggregation path with native array allAttemptedProviders', () => {
    // These tests prove that native allAttemptedProviders arrays increment
    // failoverRequests through the aggregation metrics path (computeMetrics),
    // not only via direct detectCrossProviderFailover helper tests.
    //
    // SQLite persistence coerces native arrays to comma-separated strings before
    // the API route reads them. These tests bypass SQLite by calling computeMetrics
    // directly with native arrays, proving the aggregation code handles them correctly.

    let computeMetrics: (rows: import('../model-insights').RawRow[]) => any;

    beforeEach(async () => {
      const mod = await import('../model-insights');
      computeMetrics = mod.computeMetrics;
    });

    it('native array with distinct providers and missing retryHistory increments failoverRequests', () => {
      // Native array ['provider-a/model-1','provider-b/model-2'] with missing retryHistory
      const rows: import('../model-insights').RawRow[] = [
        {
          requestId: 'req-aggregation-1',
          provider: 'provider-b',
          canonicalModelName: 'model-2',
          selectedModelName: 'model-2',
          finalAttemptProvider: 'provider-b',
          finalAttemptModel: 'model-2',
          allAttemptedProviders: ['provider-a/model-1', 'provider-b/model-2'] as unknown as string,
          attemptCount: 2,
          retryHistory: null, // missing
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
          tokensPerSec: null,
          isStreamed: 0,
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
      expect(metrics.totalRetryAttempts).toBe(1); // 2 - 1
      expect(metrics.requests).toBe(1);
      expect(metrics.successfulRequests).toBe(1);
    });

    it('native array with distinct providers and unparseable retryHistory increments failoverRequests', () => {
      // Native array with broken/unparseable retryHistory
      const rows: import('../model-insights').RawRow[] = [
        {
          requestId: 'req-aggregation-2',
          provider: 'provider-b',
          canonicalModelName: 'model-2',
          selectedModelName: 'model-2',
          finalAttemptProvider: 'provider-b',
          finalAttemptModel: 'model-2',
          allAttemptedProviders: ['provider-a/model-1', 'provider-b/model-2'] as unknown as string,
          attemptCount: 2,
          retryHistory: 'not-valid-json', // unparseable
          tokensInput: 200,
          tokensOutput: 80,
          tokensReasoning: 0,
          tokensCached: 0,
          tokensCacheWrite: 0,
          costInput: null,
          costOutput: null,
          costCached: null,
          costCacheWrite: null,
          costTotal: 0.02,
          costSource: null,
          durationMs: 300,
          ttftMs: 80,
          tokensPerSec: null,
          isStreamed: 0,
          isPassthrough: 0,
          responseStatus: 'success',
          startTime: Date.now() - 2000,
          providerReportedCost: null,
          tokensEstimated: 0,
          isDescriptorRequest: 0,
          isVisionFallthrough: 0,
        },
      ];

      const metrics = computeMetrics(rows);
      expect(metrics.failoverRequests).toBe(1);
      expect(metrics.totalRetryAttempts).toBe(1); // 2 - 1
    });

    it('native array with same provider does NOT increment failoverRequests', () => {
      const rows: import('../model-insights').RawRow[] = [
        {
          requestId: 'req-aggregation-same',
          provider: 'provider-a',
          canonicalModelName: 'model-1',
          selectedModelName: 'model-1',
          finalAttemptProvider: 'provider-a',
          finalAttemptModel: 'model-1',
          allAttemptedProviders: ['provider-a/model-1', 'provider-a/model-1'] as unknown as string,
          attemptCount: 2,
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
          tokensPerSec: null,
          isStreamed: 0,
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
      expect(metrics.failoverRequests).toBe(0);
      expect(metrics.totalRetryAttempts).toBe(1); // 2 - 1
    });

    it('mixed native array cross-provider and same-provider rows aggregate correctly', () => {
      const rows: import('../model-insights').RawRow[] = [
        // Cross-provider native array → failover
        {
          requestId: 'req-mix-1',
          provider: 'provider-b',
          canonicalModelName: 'model-2',
          selectedModelName: 'model-2',
          finalAttemptProvider: 'provider-b',
          finalAttemptModel: 'model-2',
          allAttemptedProviders: ['provider-a/model-1', 'provider-b/model-2'] as unknown as string,
          attemptCount: 2,
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
          tokensPerSec: null,
          isStreamed: 0,
          isPassthrough: 0,
          responseStatus: 'success',
          startTime: Date.now() - 1000,
          providerReportedCost: null,
          tokensEstimated: 0,
          isDescriptorRequest: 0,
          isVisionFallthrough: 0,
        },
        // Same-provider native array → NOT failover
        {
          requestId: 'req-mix-2',
          provider: 'provider-a',
          canonicalModelName: 'model-1',
          selectedModelName: 'model-1',
          finalAttemptProvider: 'provider-a',
          finalAttemptModel: 'model-1',
          allAttemptedProviders: ['provider-a/model-1', 'provider-a/model-1'] as unknown as string,
          attemptCount: 2,
          retryHistory: null,
          tokensInput: 200,
          tokensOutput: 80,
          tokensReasoning: 0,
          tokensCached: 0,
          tokensCacheWrite: 0,
          costInput: null,
          costOutput: null,
          costCached: null,
          costCacheWrite: null,
          costTotal: 0.02,
          costSource: null,
          durationMs: 300,
          ttftMs: 80,
          tokensPerSec: null,
          isStreamed: 0,
          isPassthrough: 0,
          responseStatus: 'success',
          startTime: Date.now() - 2000,
          providerReportedCost: null,
          tokensEstimated: 0,
          isDescriptorRequest: 0,
          isVisionFallthrough: 0,
        },
        // Single attempt, no failover
        {
          requestId: 'req-mix-3',
          provider: 'provider-a',
          canonicalModelName: 'model-1',
          selectedModelName: 'model-1',
          finalAttemptProvider: 'provider-a',
          finalAttemptModel: 'model-1',
          allAttemptedProviders: ['provider-a/model-1'] as unknown as string,
          attemptCount: 1,
          retryHistory: null,
          tokensInput: 50,
          tokensOutput: 20,
          tokensReasoning: 0,
          tokensCached: 0,
          tokensCacheWrite: 0,
          costInput: null,
          costOutput: null,
          costCached: null,
          costCacheWrite: null,
          costTotal: 0.005,
          costSource: null,
          durationMs: 100,
          ttftMs: 30,
          tokensPerSec: null,
          isStreamed: 0,
          isPassthrough: 0,
          responseStatus: 'success',
          startTime: Date.now() - 3000,
          providerReportedCost: null,
          tokensEstimated: 0,
          isDescriptorRequest: 0,
          isVisionFallthrough: 0,
        },
      ];

      const metrics = computeMetrics(rows);
      expect(metrics.requests).toBe(3);
      expect(metrics.failoverRequests).toBe(1); // only the cross-provider row
      expect(metrics.totalRetryAttempts).toBe(2); // (2-1) + (2-1) + (1-1) = 2
      expect(metrics.avgAttempts).toBeCloseTo(5 / 3); // (2+2+1)/3
      expect(metrics.successfulRequests).toBe(3);
      expect(metrics.inputTokens).toBe(350); // 100 + 200 + 50
    });

    it('JSON string allAttemptedProviders still works through computeMetrics', () => {
      // Ensure existing JSON string behavior is not broken
      const rows: import('../model-insights').RawRow[] = [
        {
          requestId: 'req-json-string',
          provider: 'provider-b',
          canonicalModelName: 'model-2',
          selectedModelName: 'model-2',
          finalAttemptProvider: 'provider-b',
          finalAttemptModel: 'model-2',
          allAttemptedProviders: JSON.stringify(['provider-a/model-1', 'provider-b/model-2']),
          attemptCount: 2,
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
          tokensPerSec: null,
          isStreamed: 0,
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
