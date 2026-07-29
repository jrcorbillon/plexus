import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
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

/** Build a request_usage row. `overrides` merges last. */
function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now();
  return {
    requestId: `req-${Math.random().toString(36).slice(2, 12)}`,
    date: new Date(now).toISOString(),
    startTime: now,
    durationMs: 100,
    isStreamed: 0,
    isPassthrough: 0,
    tokensEstimated: 0,
    createdAt: now,
    attemptCount: 1,
    responseStatus: 'success',
    provider: 'anthropic',
    selectedModelName: 'claude-sonnet-4-5',
    ...overrides,
  };
}

/** UTC midnight (ms epoch) for a Date. */
function utcMidnightMs(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

interface DayRow {
  day: string;
  provider: string;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
}

const DAY_KEYS = [
  'day',
  'provider',
  'model',
  'requests',
  'inputTokens',
  'outputTokens',
  'cachedTokens',
  'cacheWriteTokens',
] as const;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('GET /v0/management/usage/daily-breakdown', () => {
  let fastify: ReturnType<typeof Fastify>;
  let db: ReturnType<typeof getDatabase>;
  let schema: any;

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

  // -------------------------------------------------------------------------
  // VAL-API-001: Endpoint exists and returns 200
  // -------------------------------------------------------------------------
  it('returns 200 with JSON content-type for admin', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/usage/daily-breakdown',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
  });

  // -------------------------------------------------------------------------
  // VAL-API-002: Response shape matches spec
  // -------------------------------------------------------------------------
  it('response body has top-level days array with exactly the required keys per row', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values(
      makeRow({
        startTime: now,
        provider: 'anthropic',
        selectedModelName: 'claude-sonnet-4-5',
        tokensInput: 10,
        tokensOutput: 5,
        tokensCached: 2,
        tokensCacheWrite: 1,
      })
    );

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/usage/daily-breakdown',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { days: DayRow[] };
    expect(Array.isArray(body.days)).toBe(true);
    expect(body.days.length).toBeGreaterThan(0);
    for (const row of body.days) {
      const keys = Object.keys(row).sort();
      expect(keys).toEqual([...DAY_KEYS].sort());
    }
  });

  // -------------------------------------------------------------------------
  // VAL-API-003: Multiple records same day+provider+model are summed
  // -------------------------------------------------------------------------
  it('sums records sharing the same UTC day + provider + model into one row', async () => {
    const now = new Date();
    const t0 = utcMidnightMs(now) + 12 * 3600 * 1000; // noon UTC today

    await db.insert(schema.requestUsage).values([
      makeRow({
        startTime: t0,
        provider: 'anthropic',
        selectedModelName: 'claude-sonnet-4-5',
        tokensInput: 100,
        tokensOutput: 50,
        tokensCached: 10,
        tokensCacheWrite: 5,
      }),
      makeRow({
        startTime: t0 + 60_000,
        provider: 'anthropic',
        selectedModelName: 'claude-sonnet-4-5',
        tokensInput: 200,
        tokensOutput: 25,
        tokensCached: 0,
        tokensCacheWrite: 0,
      }),
      makeRow({
        startTime: t0 + 120_000,
        provider: 'anthropic',
        selectedModelName: 'claude-sonnet-4-5',
        tokensInput: 300,
        tokensOutput: 75,
        tokensCached: 40,
        tokensCacheWrite: 15,
      }),
    ]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/usage/daily-breakdown',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { days: DayRow[] };
    const todayStr = new Date().toISOString().slice(0, 10);
    const todayRows = body.days.filter((r) => r.day === todayStr);
    expect(todayRows).toHaveLength(1);
    const row = todayRows[0]!;
    expect(row.provider).toBe('anthropic');
    expect(row.model).toBe('claude-sonnet-4-5');
    expect(row.requests).toBe(3);
    expect(row.inputTokens).toBe(600);
    expect(row.outputTokens).toBe(150);
    expect(row.cachedTokens).toBe(50);
    expect(row.cacheWriteTokens).toBe(20);
  });

  // -------------------------------------------------------------------------
  // VAL-API-004: Different providers/models produce separate rows
  // -------------------------------------------------------------------------
  it('produces separate rows for distinct (provider, model) pairs in the same day', async () => {
    const now = new Date();
    const t0 = utcMidnightMs(now) + 12 * 3600 * 1000; // noon UTC today

    await db.insert(schema.requestUsage).values([
      makeRow({
        startTime: t0,
        provider: 'anthropic',
        selectedModelName: 'claude-sonnet-4-5',
        tokensInput: 100,
        tokensOutput: 10,
      }),
      makeRow({
        startTime: t0 + 60_000,
        provider: 'openai',
        selectedModelName: 'gpt-4o',
        tokensInput: 200,
        tokensOutput: 20,
      }),
      makeRow({
        startTime: t0 + 120_000,
        provider: 'google',
        selectedModelName: 'gemini-2.5-pro',
        tokensInput: 300,
        tokensOutput: 30,
      }),
    ]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/usage/daily-breakdown',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { days: DayRow[] };
    const todayStr = new Date().toISOString().slice(0, 10);
    const todayRows = body.days.filter((r) => r.day === todayStr);
    expect(todayRows).toHaveLength(3);
    const pairs = todayRows.map((r) => `${r.provider}/${r.model}`).sort();
    expect(pairs).toEqual(
      ['anthropic/claude-sonnet-4-5', 'google/gemini-2.5-pro', 'openai/gpt-4o'].sort()
    );
  });

  // -------------------------------------------------------------------------
  // VAL-API-005: Day bucketing uses UTC midnight boundaries
  // -------------------------------------------------------------------------
  it('places 23:59:59 UTC and 00:00:01 UTC next day into different day buckets', async () => {
    // Build a fixed date in UTC: pick yesterday at 23:59:59 and today at 00:00:01
    const today = new Date();
    const todayMidnight = utcMidnightMs(today);
    const justBeforeMidnight = todayMidnight - 1_000; // yesterday 23:59:59 UTC
    const justAfterMidnight = todayMidnight + 1_000; // today 00:00:01 UTC

    await db.insert(schema.requestUsage).values([
      makeRow({
        startTime: justBeforeMidnight,
        provider: 'anthropic',
        selectedModelName: 'claude-sonnet-4-5',
        tokensInput: 11,
      }),
      makeRow({
        startTime: justAfterMidnight,
        provider: 'anthropic',
        selectedModelName: 'claude-sonnet-4-5',
        tokensInput: 22,
      }),
    ]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/usage/daily-breakdown?days=30',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { days: DayRow[] };
    const days = body.days.map((r) => r.day);
    const yesterdayStr = new Date(todayMidnight - 1).toISOString().slice(0, 10);
    const todayStr = new Date(todayMidnight).toISOString().slice(0, 10);
    expect(days).toContain(yesterdayStr);
    expect(days).toContain(todayStr);
    expect(new Set(days).size).toBe(days.length); // two distinct buckets
  });

  // -------------------------------------------------------------------------
  // VAL-API-006: `days` query param controls range (default 30)
  // -------------------------------------------------------------------------
  it('respects days=7 (excludes 8-day-old records) and defaults to 30', async () => {
    const now = Date.now();
    const eightDaysAgo = now - 8 * 24 * 3600 * 1000;
    const twoDaysAgo = now - 2 * 24 * 3600 * 1000;

    await db.insert(schema.requestUsage).values([
      makeRow({
        startTime: eightDaysAgo,
        provider: 'anthropic',
        selectedModelName: 'old-model',
        tokensInput: 999,
      }),
      makeRow({
        startTime: twoDaysAgo,
        provider: 'anthropic',
        selectedModelName: 'recent-model',
        tokensInput: 111,
      }),
    ]);

    // days=7 should exclude the 8-day-old record
    const res7 = await fastify.inject({
      method: 'GET',
      url: '/v0/management/usage/daily-breakdown?days=7',
      headers: { 'x-admin-key': ADMIN_KEY },
    });
    expect(res7.statusCode).toBe(200);
    const body7 = res7.json() as { days: DayRow[] };
    const models7 = body7.days.map((r) => r.model);
    expect(models7).not.toContain('old-model');
    expect(models7).toContain('recent-model');

    // default (30) should include both
    const resDefault = await fastify.inject({
      method: 'GET',
      url: '/v0/management/usage/daily-breakdown',
      headers: { 'x-admin-key': ADMIN_KEY },
    });
    expect(resDefault.statusCode).toBe(200);
    const bodyDefault = resDefault.json() as { days: DayRow[] };
    const modelsDefault = bodyDefault.days.map((r) => r.model);
    expect(modelsDefault).toContain('old-model');
    expect(modelsDefault).toContain('recent-model');
  });

  // -------------------------------------------------------------------------
  // VAL-API-007: `days=0` handled gracefully
  // -------------------------------------------------------------------------
  it('days=0 does not crash and returns a well-formed 200 response', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values(
      makeRow({
        startTime: now,
        provider: 'anthropic',
        selectedModelName: 'claude-sonnet-4-5',
        tokensInput: 10,
      })
    );

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/usage/daily-breakdown?days=0',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('days');
    expect(Array.isArray(body.days)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // VAL-API-008: Invalid `days` value handled gracefully
  // -------------------------------------------------------------------------
  it('days=abc and days=-5 do not crash (no 500)', async () => {
    for (const bad of ['abc', '-5']) {
      const res = await fastify.inject({
        method: 'GET',
        url: `/v0/management/usage/daily-breakdown?days=${bad}`,
        headers: { 'x-admin-key': ADMIN_KEY },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('days');
      expect(Array.isArray(body.days)).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // VAL-API-009: Limited-user scoping returns only own records
  // -------------------------------------------------------------------------
  it('limited user sees only their own apiKey records', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values([
      makeRow({
        startTime: now,
        apiKey: 'limited-key',
        provider: 'anthropic',
        selectedModelName: 'my-model',
        tokensInput: 10,
      }),
      makeRow({
        startTime: now,
        apiKey: 'other-user',
        provider: 'openai',
        selectedModelName: 'their-model',
        tokensInput: 999,
      }),
    ]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/usage/daily-breakdown',
      headers: { 'x-admin-key': 'sk-limited-secret' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { days: DayRow[] };
    const models = body.days.map((r) => r.model);
    expect(models).toContain('my-model');
    expect(models).not.toContain('their-model');
  });

  // -------------------------------------------------------------------------
  // VAL-API-010: Empty result returns { days: [] }
  // -------------------------------------------------------------------------
  it('returns { days: [] } with 200 when no rows match', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/usage/daily-breakdown',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ days: [] });
  });

  // -------------------------------------------------------------------------
  // VAL-API-011: Null provider bucketed as 'unknown'
  // -------------------------------------------------------------------------
  it('buckets null provider as "unknown"', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values(
      makeRow({
        startTime: now,
        provider: null,
        selectedModelName: 'some-model',
        tokensInput: 10,
      })
    );

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/usage/daily-breakdown',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { days: DayRow[] };
    expect(body.days.length).toBeGreaterThan(0);
    for (const row of body.days) {
      expect(row.provider).not.toBeNull();
      expect(row.provider).not.toBeUndefined();
    }
    expect(body.days.some((r) => r.provider === 'unknown')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // VAL-API-012: Null model bucketed as 'unknown'
  // -------------------------------------------------------------------------
  it('buckets null selectedModelName as "unknown"', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values(
      makeRow({
        startTime: now,
        provider: 'anthropic',
        selectedModelName: null,
        tokensInput: 10,
      })
    );

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/usage/daily-breakdown',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { days: DayRow[] };
    expect(body.days.length).toBeGreaterThan(0);
    for (const row of body.days) {
      expect(row.model).not.toBeNull();
      expect(row.model).not.toBeUndefined();
    }
    expect(body.days.some((r) => r.model === 'unknown')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // VAL-API-013: Null token values treated as 0
  // -------------------------------------------------------------------------
  it('treats null token columns as 0 (integer, not null) in aggregated output', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values(
      makeRow({
        startTime: now,
        provider: 'anthropic',
        selectedModelName: 'claude-sonnet-4-5',
        tokensInput: null,
        tokensOutput: null,
        tokensCached: null,
        tokensCacheWrite: null,
      })
    );

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/usage/daily-breakdown',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { days: DayRow[] };
    expect(body.days.length).toBeGreaterThan(0);
    const row = body.days[0]!;
    expect(row.inputTokens).toBe(0);
    expect(row.outputTokens).toBe(0);
    expect(row.cachedTokens).toBe(0);
    expect(row.cacheWriteTokens).toBe(0);
    // Must be integers, not null
    expect(typeof row.inputTokens).toBe('number');
    expect(typeof row.outputTokens).toBe('number');
  });

  // -------------------------------------------------------------------------
  // VAL-API-014: `day` values are ISO date strings (YYYY-MM-DD)
  // -------------------------------------------------------------------------
  it('formats day field as YYYY-MM-DD', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values(
      makeRow({
        startTime: now,
        provider: 'anthropic',
        selectedModelName: 'claude-sonnet-4-5',
        tokensInput: 10,
      })
    );

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/usage/daily-breakdown',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { days: DayRow[] };
    expect(body.days.length).toBeGreaterThan(0);
    const isoDateRe = /^\d{4}-\d{2}-\d{2}$/;
    for (const row of body.days) {
      expect(row.day).toMatch(isoDateRe);
    }
  });

  // -------------------------------------------------------------------------
  // VAL-API-015: Unauthorized request is rejected
  // -------------------------------------------------------------------------
  it('returns 401 when no x-admin-key is provided', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/usage/daily-breakdown',
    });

    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when x-admin-key is invalid', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/usage/daily-breakdown',
      headers: { 'x-admin-key': 'totally-wrong-key' },
    });

    expect(res.statusCode).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Regression: NULL and literal 'unknown" must merge into a single group
  // (GROUP BY must use the same COALESCE expressions as the SELECT)
  // -------------------------------------------------------------------------
  it('merges NULL and literal "unknown" provider/model into one row per day', async () => {
    const now = Date.now();
    await db.insert(schema.requestUsage).values([
      makeRow({
        startTime: now,
        provider: null,
        selectedModelName: null,
        tokensInput: 10,
        tokensOutput: 0,
        tokensCached: 0,
        tokensCacheWrite: 0,
      }),
      makeRow({
        startTime: now + 1000,
        provider: 'unknown' as any,
        selectedModelName: 'unknown' as any,
        tokensInput: 20,
        tokensOutput: 0,
        tokensCached: 0,
        tokensCacheWrite: 0,
      }),
    ]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/usage/daily-breakdown',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { days: DayRow[] };
    const unknownRows = body.days.filter((r) => r.provider === 'unknown' && r.model === 'unknown');
    expect(unknownRows).toHaveLength(1);
    expect(unknownRows[0]!.requests).toBe(2);
    expect(unknownRows[0]!.inputTokens).toBe(30);
  });
});
