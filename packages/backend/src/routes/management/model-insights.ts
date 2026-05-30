import { FastifyInstance } from 'fastify';
import { and, eq, gte, lte } from 'drizzle-orm';
import { getSchema } from '../../db/client';
import { UsageStorageService } from '../../services/usage-storage';
import {
  buildInsightsResponse,
  groupByProvider,
  parseInsightsQuery,
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
    const parsed = parseInsightsQuery(
      request.query as Record<string, string | string[] | undefined>,
      'model'
    );
    if (!parsed.ok) {
      return reply.code(400).send({ error: parsed.error });
    }

    const { filterValue: model, rangeResult } = parsed;

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

    const { metrics, series } = buildInsightsResponse(rows, rangeResult);
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
