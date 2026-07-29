import { eq } from 'drizzle-orm';
import { getCurrentDialect, getDatabase, getSchema } from './client';
import { decryptJson, encrypt } from '../utils/encryption';
import { toDbTimestampMs } from '../utils/normalize';
import { logger } from '../utils/logger';

const AUTH_HEADERS = new Map([
  ['x-api-key', 'x-api-key'],
  ['x-goog-api-key', 'x-goog-api-key'],
  ['x-subscription-token', 'x-subscription-token'],
]);

type AuthScheme = 'bearer' | 'x-api-key' | 'x-goog-api-key' | 'x-subscription-token';

/** In-process chain so concurrent startup paths serialize per server. */
const serverMigrationChains = new Map<number, Promise<unknown>>();

function enqueueServerMigration<T>(serverId: number, task: () => Promise<T>): Promise<T> {
  const previous = serverMigrationChains.get(serverId) ?? Promise.resolve();
  const next = previous.then(task, task);
  serverMigrationChains.set(
    serverId,
    next.then(
      () => undefined,
      () => undefined
    )
  );
  return next;
}

function extractLegacyCredential(
  headers: unknown
):
  | { key: string; scheme: AuthScheme; header: string; headers: Record<string, string> }
  | undefined {
  const parsed = decryptJson(headers);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;

  const entries = Object.entries(parsed).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string'
  );
  const legacyHeaders = Object.fromEntries(entries);

  for (const [header, value] of entries) {
    const normalizedHeader = header.toLowerCase();
    if (normalizedHeader === 'authorization') {
      const match = /^Bearer\s+(.+)$/i.exec(value.trim());
      if (match?.[1]) {
        return { key: match[1], scheme: 'bearer', header, headers: legacyHeaders };
      }
      continue;
    }

    const scheme = AUTH_HEADERS.get(normalizedHeader);
    if (scheme && value.trim()) {
      return { key: value.trim(), scheme: scheme as AuthScheme, header, headers: legacyHeaders };
    }
  }

  return undefined;
}

/** Drop every header whose name matches the migrated scheme (HTTP names are case-insensitive). */
function removeMatchingAuthHeaders(
  headers: Record<string, string>,
  scheme: AuthScheme
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [header, value] of Object.entries(headers)) {
    const normalized = header.toLowerCase();
    const matchesScheme =
      scheme === 'bearer'
        ? normalized === 'authorization'
        : AUTH_HEADERS.get(normalized) === scheme;
    if (!matchesScheme) {
      result[header] = value;
    }
  }
  return result;
}

/**
 * Moves legacy remote MCP credentials from persisted headers into mcp_keys.
 * This is idempotent: servers with an existing key are left untouched.
 */
export async function runMcpKeyMigration(): Promise<number> {
  const db = getDatabase();
  const schema = getSchema();
  const dialect = getCurrentDialect();
  const timestamp = toDbTimestampMs(Date.now(), dialect);
  let migratedCount = 0;

  const servers = await db.select().from(schema.mcpServers);
  for (const server of servers) {
    if (server.mode === 'local_http' || !server.headers) continue;

    const credential = extractLegacyCredential(server.headers);
    if (!credential) continue;

    const didMigrate = await enqueueServerMigration(server.id, async () => {
      const migrateTx = async (tx: typeof db): Promise<boolean> => {
        // Row lock so concurrent DB sessions serialize on this server.
        if (dialect === 'postgres') {
          const lockQuery = tx
            .select({ id: schema.mcpServers.id })
            .from(schema.mcpServers)
            .where(eq(schema.mcpServers.id, server.id));
          await (
            lockQuery as typeof lockQuery & { for: (strength: 'update') => Promise<unknown> }
          ).for('update');
        }

        const [current] = await tx
          .select()
          .from(schema.mcpServers)
          .where(eq(schema.mcpServers.id, server.id))
          .limit(1);
        if (!current?.headers) return false;

        const existingKeys = await tx
          .select({ id: schema.mcpKeys.id })
          .from(schema.mcpKeys)
          .where(eq(schema.mcpKeys.mcpServerId, server.id))
          .limit(1);
        if (existingKeys.length > 0) return false;

        const freshCredential = extractLegacyCredential(current.headers);
        if (!freshCredential) return false;

        const cleanedHeaders = removeMatchingAuthHeaders(
          freshCredential.headers,
          freshCredential.scheme
        );
        const nextHeaders = Object.keys(cleanedHeaders).length
          ? encrypt(JSON.stringify(cleanedHeaders))
          : null;

        // Persist migration marker (clear matching auth headers) before inserting the key
        // so a concurrent migrator cannot re-extract the credential after this commits.
        await tx
          .update(schema.mcpServers)
          .set({
            authScheme: freshCredential.scheme,
            headers: nextHeaders,
            updatedAt: Date.now(),
          })
          .where(eq(schema.mcpServers.id, server.id));

        await tx.insert(schema.mcpKeys).values({
          mcpServerId: server.id,
          key: encrypt(freshCredential.key),
          createdAt: timestamp!,
          updatedAt: timestamp!,
        });
        return true;
      };

      if (dialect === 'sqlite') {
        return db.transaction(migrateTx, { behavior: 'immediate' });
      }
      return db.transaction(migrateTx);
    });

    if (didMigrate) migratedCount++;
  }

  if (migratedCount > 0) {
    logger.info(`Migrated ${migratedCount} legacy MCP server credential(s)`);
  }
  return migratedCount;
}
