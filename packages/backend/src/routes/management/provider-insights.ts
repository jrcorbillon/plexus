import { FastifyInstance } from 'fastify';
import { and, eq, gte, lte } from 'drizzle-orm';
import { getSchema } from '../../db/client';
import { UsageStorageService } from '../../services/usage-storage';
import {
  buildSeries,
  computeMetrics,
  groupByModel,
  resolveInsightRange,
  type RawRow,
} from './insights-shared';

export async function registerProviderInsightsRoutes(
  fastify: FastifyInstance,
  usageStorage: UsageStorageService
) {
  fastify.get('/v0/management/provider-insights', async (request, reply) => {
    const query = request.query as Record<string, string | string[] | undefined>;

    if (Array.isArray(query.provider)) {
      return reply.code(400).send({
        error: {
          message: 'Duplicate "provider" parameter is not allowed',
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

    const provider = query.provider;
    const rangeKey = query.range ?? '24h';

    if (!provider || provider.trim() === '') {
      return reply.code(400).send({
        error: {
          message: 'The "provider" query parameter is required and must be non-empty',
          type: 'validation_error',
          code: 400,
        },
      });
    }

    if (provider !== provider.trim()) {
      return reply.code(400).send({
        error: {
          message:
            'The "provider" query parameter must not contain leading or trailing whitespace',
          type: 'validation_error',
          code: 400,
        },
      });
    }

    const rangeResult = resolveInsightRange(rangeKey);
    if ('error' in rangeResult) {
      return reply.code(400).send({
        error: {
          message: rangeResult.error,
          type: 'validation_error',
          code: 400,
        },
      });
    }

    const db = usageStorage.getDb();
    const schema = getSchema();

    const rows = (await db
      .select()
      .from(schema.requestUsage)
      .where(
        and(
          eq(schema.requestUsage.provider, provider),
          gte(schema.requestUsage.startTime, rangeResult.startTimeMs),
          lte(schema.requestUsage.startTime, rangeResult.endTimeMs)
        )
      )) as RawRow[];

    const metrics = computeMetrics(rows);
    const series = buildSeries(
      rows,
      rangeResult.startTimeMs,
      rangeResult.endTimeMs,
      rangeResult.bucketSizeMs
    );
    const models = groupByModel(rows);

    return reply.send({
      provider,
      range: rangeResult,
      metrics,
      series,
      models,
    });
  });
}
