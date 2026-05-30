import { FastifyInstance } from 'fastify';
import { and, eq, gte, lte } from 'drizzle-orm';
import { getSchema } from '../../db/client';
import { UsageStorageService } from '../../services/usage-storage';
import {
  buildSeries,
  computeMetrics,
  groupByProvider,
  resolveInsightRange,
  type RawRow,
} from './insights-shared';

// Re-export shared symbols for tests and consumers
export {
  computeMetrics,
  detectCrossProviderFailover,
  type ModelInsightMetrics,
  type RawRow,
} from './insights-shared';

export async function registerModelInsightsRoutes(
  fastify: FastifyInstance,
  usageStorage: UsageStorageService
) {
  fastify.get('/v0/management/model-insights', async (request, reply) => {
    const query = request.query as Record<string, string | string[] | undefined>;

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
    const rangeKey = query.range ?? '24h';

    if (!model || model.trim() === '') {
      return reply.code(400).send({
        error: {
          message: 'The "model" query parameter is required and must be non-empty',
          type: 'validation_error',
          code: 400,
        },
      });
    }

    if (model !== model.trim()) {
      return reply.code(400).send({
        error: {
          message: 'The "model" query parameter must not contain leading or trailing whitespace',
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
          eq(schema.requestUsage.incomingModelAlias, model),
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
    const providers = groupByProvider(rows);

    return reply.send({
      model,
      range: rangeResult,
      metrics,
      series,
      providers,
    });
  });
}
