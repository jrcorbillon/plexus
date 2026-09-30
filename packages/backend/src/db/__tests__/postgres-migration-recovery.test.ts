import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, getCurrentDialect, getDatabase, initializeDatabase } from '../client';
import { runMigrations } from '../migrate';

const migrationDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../drizzle/migrations_pg'
);

async function untrack(tag: string) {
  const content = await Bun.file(path.join(migrationDir, `${tag}.sql`)).text();
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  await getDatabase().execute(sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`);
  return hash;
}

describe('PostgreSQL migration recovery', () => {
  beforeEach(async () => {
    await closeDatabase();
    initializeDatabase(process.env.PLEXUS_TEST_DB_URL ?? process.env.DATABASE_URL);
    await runMigrations();
  });

  afterEach(async () => {
    await closeDatabase();
  });

  it('repairs an earlier missing column even when a newer migration is already tracked', async () => {
    if (getCurrentDialect() !== 'postgres') return;
    const db = getDatabase();
    const hash = await untrack('0078_add_allow_100_percent_utilization');
    await db.execute(sql`ALTER TABLE providers DROP COLUMN allow_100_percent_utilization`);

    await runMigrations();
    await expect(
      db.execute(sql`SELECT allow_100_percent_utilization FROM providers`)
    ).resolves.toBeDefined();
    await runMigrations();
    const rows = await db.execute(
      sql`SELECT hash FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`
    );
    expect(Array.isArray(rows) ? rows : rows.rows).toHaveLength(1);
  });

  it('does not skip rolled-back migrations when the fork already has retry columns', async () => {
    if (getCurrentDialect() !== 'postgres') return;
    const db = getDatabase();
    await untrack('0078_add_allow_100_percent_utilization');
    await untrack('0086_add_provider_cache_key_injection');
    await untrack('0087_add_alias_retry_rounds');
    await db.execute(sql`ALTER TABLE providers DROP COLUMN allow_100_percent_utilization`);
    await db.execute(sql`ALTER TABLE providers DROP COLUMN cache_key_injection`);
    await db.execute(
      sql`INSERT INTO providers (slug, created_at, updated_at) VALUES ('migration-recovery', 1, 1)`
    );

    await runMigrations();
    const rows = await db.execute(
      sql`SELECT slug, allow_100_percent_utilization, cache_key_injection FROM providers WHERE slug = 'migration-recovery'`
    );
    expect(Array.isArray(rows) ? rows : rows.rows).toHaveLength(1);
    expect((Array.isArray(rows) ? rows : rows.rows)[0]).toMatchObject({
      slug: 'migration-recovery',
      allow_100_percent_utilization: false,
      cache_key_injection: null,
    });
    await expect(
      db.execute(sql`SELECT max_attempts, retry_delay_seconds FROM model_aliases`)
    ).resolves.toBeDefined();
  });

  it('recovers existing tables, indexes, and enum values without aborting the transaction', async () => {
    if (getCurrentDialect() !== 'postgres') return;
    const db = getDatabase();
    const hashes = [
      await untrack('0076_add_mcp_oauth_tables'),
      await untrack('0079_add_quota_selector'),
    ];

    await expect(runMigrations()).resolves.toBeUndefined();
    await expect(db.execute(sql`SELECT id FROM mcp_oauth_clients`)).resolves.toBeDefined();
    for (const hash of hashes) {
      const rows = await db.execute(
        sql`SELECT hash FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`
      );
      expect(Array.isArray(rows) ? rows : rows.rows).toHaveLength(1);
    }
  });
});
