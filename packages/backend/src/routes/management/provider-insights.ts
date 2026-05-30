import { FastifyInstance } from 'fastify';
import { and, eq, gte, lte } from 'drizzle-orm';
import { getSchema } from '../../db/client';
import { UsageStorageService } from '../../services/usage-storage';
import {
  buildInsightsResponse,
  groupByModel,
  parseInsightsQuery,
  type RawRow,
} from './insights-shared';

export async function registerProviderInsightsRoutes(
  fastify: FastifyInstance,
  usageStorage: UsageStorageService
) {
  fastify.get('/v0/management/provider-insights', async (request, reply) => {
    const parsed = parseInsightsQuery(
      request.query as Record<string, string | string[] | undefined>,
      'provider'
    );
    if (!parsed.ok) {
      return reply.code(400).send({ error: parsed.error });
    }

    const { filterValue: provider, rangeResult } = parsed;

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

    const { metrics, series } = buildInsightsResponse(rows, rangeResult);
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
