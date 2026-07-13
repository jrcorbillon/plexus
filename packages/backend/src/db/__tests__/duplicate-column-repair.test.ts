import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { closeDatabase, getCurrentDialect, getDatabase, initializeDatabase } from '../client';
import { runMigrations } from '../migrate';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const SQLITE_MIGRATIONS_DIR = path.join(moduleDir, '../../../drizzle/migrations');
const ALIAS_RETRY_MIGRATION_TAG = '0054_add_alias_retry_rounds';
const PI_AI_CUSTOM_MIGRATION_TAG = '0052_add_pi_ai_custom_and_generation';

async function migrationHash(tag: string): Promise<string> {
  const sqlContent = await Bun.file(path.join(SQLITE_MIGRATIONS_DIR, `${tag}.sql`)).text();
  return createHash('sha256').update(sqlContent).digest('hex');
}

describe('SQLite idempotent migrations', () => {
  beforeEach(async () => {
    await closeDatabase();
    process.env.DATABASE_URL = process.env.PLEXUS_TEST_DB_URL ?? process.env.DATABASE_URL;
    initializeDatabase(process.env.DATABASE_URL);
    await runMigrations();
  });

  afterEach(async () => {
    await closeDatabase();
  });

  it('continues when max_attempts already exists but migration is untracked', async () => {
    if (getCurrentDialect() !== 'sqlite') {
      return;
    }

    const db = getDatabase();
    const sqlite = (db as any).session.client as {
      run: (sql: string) => void;
      query: (sql: string) => {
        get: (...args: unknown[]) => unknown;
        all: (...args: unknown[]) => unknown[];
      };
      prepare: (sql: string) => { run: (...args: unknown[]) => void };
    };

    const hash = await migrationHash(ALIAS_RETRY_MIGRATION_TAG);

    // Simulate production drift: columns exist, but migration hash was never recorded
    // (e.g. crash after ADD COLUMN, or restore from a schema-only backup).
    sqlite.prepare('DELETE FROM __drizzle_migrations WHERE hash = ?').run(hash);
    try {
      sqlite.run('ALTER TABLE `model_aliases` DROP COLUMN `retry_delay_seconds`');
    } catch {
      // Older SQLite builds may not support DROP COLUMN; the duplicate-column
      // path is still covered by re-running migrate against existing max_attempts.
    }

    await expect(runMigrations()).resolves.toBeUndefined();

    const tracked = sqlite
      .query('SELECT 1 as found FROM __drizzle_migrations WHERE hash = ?')
      .get(hash);
    expect(tracked).toBeTruthy();

    const columns = (
      sqlite.query('PRAGMA table_info(`model_aliases`)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(columns).toContain('max_attempts');
    expect(columns).toContain('retry_delay_seconds');
  });

  it('applies earlier migrations when a later hash was recorded out of order', async () => {
    if (getCurrentDialect() !== 'sqlite') {
      return;
    }

    const db = getDatabase();
    const sqlite = (db as any).session.client as {
      run: (sql: string) => void;
      query: (sql: string) => {
        get: (...args: unknown[]) => unknown;
        all: (...args: unknown[]) => unknown[];
      };
      prepare: (sql: string) => { run: (...args: unknown[]) => void };
    };

    const earlierHash = await migrationHash(PI_AI_CUSTOM_MIGRATION_TAG);

    // Simulate the production hole: 0054 was marked applied while 0052 never ran.
    sqlite.prepare('DELETE FROM __drizzle_migrations WHERE hash = ?').run(earlierHash);
    sqlite.run('DROP TABLE IF EXISTS `pi_ai_custom_providers`');
    sqlite.run('DROP TABLE IF EXISTS `pi_ai_custom_models`');
    sqlite.run('DROP INDEX IF EXISTS `pi_ai_custom_providers_name_unique`');
    sqlite.run('DROP INDEX IF EXISTS `pi_ai_custom_models_name_unique`');

    await expect(runMigrations()).resolves.toBeUndefined();

    const tracked = sqlite
      .query('SELECT 1 as found FROM __drizzle_migrations WHERE hash = ?')
      .get(earlierHash);
    expect(tracked).toBeTruthy();

    const tables = (
      sqlite
        .query(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'pi_ai_custom%'`)
        .all() as Array<{ name: string }>
    ).map((t) => t.name);
    expect(tables).toContain('pi_ai_custom_providers');
    expect(tables).toContain('pi_ai_custom_models');
  });
});
