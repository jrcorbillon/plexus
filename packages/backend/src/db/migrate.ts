import { sql } from 'drizzle-orm';
import { getDatabase, getCurrentDialect } from './client';
import { logger } from '../utils/logger';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sqliteJournal from '../../drizzle/migrations/meta/_journal.json';
import pgJournal from '../../drizzle/migrations_pg/meta/_journal.json';

const DRIZZLE_MIGRATIONS_SCHEMA = 'drizzle';
const DRIZZLE_MIGRATIONS_TABLE = '__drizzle_migrations';

// Bun types embeddedFiles as Blob[] but the runtime objects are BunFile with a name property.
type EmbeddedFile = Blob & { name: string };

// Populated at startup in a compiled binary; empty when running from source.
const embedded = new Map((Bun.embeddedFiles as EmbeddedFile[]).map((f) => [f.name, f]));

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

// Filesystem paths used as a fallback in dev/source mode.
const DEV_MIGRATIONS_DIR = {
  sqlite: path.join(moduleDir, '../../drizzle/migrations'),
  postgres: path.join(moduleDir, '../../drizzle/migrations_pg'),
} as const;

// Shape expected by db.dialect.migrate() — mirrors drizzle-orm's internal MigrationMeta.
interface MigrationMeta {
  sql: string[];
  bps: boolean;
  folderMillis: number;
  hash: string;
}

type Journal = { entries: Array<{ tag: string; when: number; breakpoints: boolean }> };

type SqliteClient = {
  run: (sql: string) => void;
  query: (sql: string) => {
    get: (...args: unknown[]) => unknown;
    all: (...args: unknown[]) => unknown[];
  };
  prepare: (sql: string) => { run: (...args: unknown[]) => void };
};

async function readSql(
  tag: string,
  devDir: string
): Promise<{ content: string; source: 'embedded' | 'filesystem' }> {
  const asset = embedded.get(`${tag}.sql`);
  if (asset) return { content: await asset.text(), source: 'embedded' };
  return { content: await Bun.file(path.join(devDir, `${tag}.sql`)).text(), source: 'filesystem' };
}

async function buildMigrations(journal: Journal, devDir: string): Promise<MigrationMeta[]> {
  const results = await Promise.all(
    journal.entries.map(async (entry) => {
      const { content, source } = await readSql(entry.tag, devDir);
      return {
        meta: { tag: entry.tag, source },
        migration: {
          sql: content.split('--> statement-breakpoint'),
          bps: entry.breakpoints,
          folderMillis: entry.when,
          hash: crypto.createHash('sha256').update(content).digest('hex'),
        },
      };
    })
  );

  const sources = new Set(results.map((r) => r.meta.source));
  logger.debug(
    `Loaded ${results.length} migrations from ${sources.size === 1 ? [...sources][0] : 'mixed'} source`
  );

  return results.map((r) => r.migration);
}

function toIdempotentStatement(statement: string): string {
  if (
    /ALTER\s+TABLE[\s\S]+ADD\s+COLUMN/i.test(statement) &&
    !/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/i.test(statement)
  ) {
    return statement.replace(/ADD\s+COLUMN\s+/i, 'ADD COLUMN IF NOT EXISTS ');
  }
  return statement;
}

// Make a SQLite DDL statement safer by inserting IF NOT EXISTS guards.
// ALTER TABLE ADD COLUMN is left unchanged because bun:sqlite doesn't support
// ADD COLUMN IF NOT EXISTS; duplicate-column errors are ignored by the runner.
function toIdempotentSQLiteStatement(statement: string): string {
  let s = statement;
  s = s.replace(/(CREATE\s+TABLE\s+)(`[\w]+`|\w+)/i, '$1IF NOT EXISTS $2');
  s = s.replace(/(CREATE\s+(?:UNIQUE\s+)?INDEX\s+)(`[\w]+`|\w+)/i, '$1IF NOT EXISTS $2');
  return s;
}

function getSqliteClient(db: any): SqliteClient {
  const sqlite = db?.session?.client as SqliteClient | undefined;
  if (!sqlite?.run || !sqlite?.query || !sqlite?.prepare) {
    throw new Error('Cannot access underlying Bun SQLite client via db.session.client');
  }
  return sqlite;
}

function isIgnorableSqliteDdlError(error: any): boolean {
  const msg = String(error?.message ?? error?.cause?.message ?? '').toLowerCase();
  return msg.includes('already exists') || msg.includes('duplicate column');
}

/**
 * Apply SQLite migrations statement-by-statement without wrapping in a transaction.
 *
 * Drizzle's built-in migrator:
 * 1. Wraps each migration in BEGIN/COMMIT and ROLLBACKs on failure — SQLite can still
 *    leave ALTER TABLE ADD COLUMN effects behind, causing "duplicate column" on retry.
 * 2. Tracks progress via max(created_at) only — if a later migration hash is recorded
 *    while earlier ones never ran (partial repair / drift), those earlier migrations
 *    are skipped forever (e.g. missing pi_ai_custom_providers after 0054 was marked).
 *
 * This runner applies any migration whose hash is not yet recorded, ignores duplicate
 * column / already-exists DDL conflicts, and records the hash afterward.
 */
function runSqliteMigrationsIdempotently(
  db: any,
  migrations: MigrationMeta[],
  journal: Journal
): void {
  const sqlite = getSqliteClient(db);

  sqlite.run(`
    CREATE TABLE IF NOT EXISTS ${DRIZZLE_MIGRATIONS_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL,
      created_at numeric
    )
  `);

  // Hash-based pending check — do NOT use max(created_at), which skips holes in history.
  const appliedHashes = new Set(
    (
      sqlite.query(`SELECT hash FROM ${DRIZZLE_MIGRATIONS_TABLE}`).all() as Array<{ hash: string }>
    ).map((row) => row.hash)
  );

  for (let i = 0; i < migrations.length; i++) {
    const migration = migrations[i]!;
    const entry = journal.entries[i]!;
    if (appliedHashes.has(migration.hash)) continue;

    logger.info(`Applying SQLite migration ${entry.tag}`);

    for (const statement of migration.sql) {
      const trimmed = statement.trim();
      if (!trimmed) continue;
      const idempotent = toIdempotentSQLiteStatement(trimmed);
      try {
        sqlite.run(idempotent);
      } catch (err: any) {
        if (isIgnorableSqliteDdlError(err)) {
          logger.warn(
            `Ignoring idempotent DDL conflict in ${entry.tag}: ${err?.message ?? String(err)}`
          );
          continue;
        }
        throw err;
      }
    }

    sqlite
      .prepare(`INSERT INTO ${DRIZZLE_MIGRATIONS_TABLE} (hash, created_at) VALUES (?, ?)`)
      .run(migration.hash, migration.folderMillis);
    appliedHashes.add(migration.hash);
  }
}

function isIgnorablePostgresDdlError(statement: string, error: any): boolean {
  const code = error?.cause?.code ?? error?.code;
  if (code === '42701') return /ALTER\s+TABLE[\s\S]+ADD\s+COLUMN/i.test(statement);
  if (code === '42P07') return /^CREATE\s+(?:(?:UNIQUE\s+)?INDEX|TABLE)\b/i.test(statement);
  if (code === '42710') {
    return (
      /^CREATE\s+TYPE\b/i.test(statement) ||
      /ALTER\s+TABLE[\s\S]+ADD\s+CONSTRAINT/i.test(statement) ||
      /ALTER\s+TYPE[\s\S]+ADD\s+VALUE/i.test(statement)
    );
  }
  return false;
}

/** Track hashes rather than a timestamp watermark so fork histories cannot skip migrations. */
async function runPostgresMigrationsIdempotently(
  db: any,
  migrations: MigrationMeta[],
  journal: Journal
): Promise<void> {
  await db.execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS "${DRIZZLE_MIGRATIONS_SCHEMA}"`));
  await db.execute(
    sql.raw(`
    CREATE TABLE IF NOT EXISTS "${DRIZZLE_MIGRATIONS_SCHEMA}"."${DRIZZLE_MIGRATIONS_TABLE}" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `)
  );

  const tracked = await db.execute(sql`SELECT hash FROM "drizzle"."__drizzle_migrations"`);
  const appliedHashes = new Set<string>(
    (Array.isArray(tracked) ? tracked : tracked.rows).map((row: { hash: string }) => row.hash)
  );

  for (let i = 0; i < migrations.length; i++) {
    const migration = migrations[i]!;
    const entry = journal.entries[i]!;
    if (appliedHashes.has(migration.hash)) continue;
    // Commit each migration together with its hash. A later duplicate must never
    // roll back earlier DDL and then advance a timestamp past that missing DDL.
    await db.transaction(async (tx: any) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(1347175768)`);
      const applied = await tx.execute(sql`
        SELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE hash = ${migration.hash} LIMIT 1
      `);
      if ((Array.isArray(applied) ? applied : applied.rows).length > 0) return;

      logger.info(`Applying PostgreSQL migration ${entry.tag}`);
      for (const statement of migration.sql) {
        const trimmed = statement.trim();
        if (!trimmed) continue;
        await tx.execute(sql.raw('SAVEPOINT plexus_migration_statement'));
        try {
          await tx.execute(sql.raw(toIdempotentStatement(trimmed)));
        } catch (error: any) {
          if (!isIgnorablePostgresDdlError(trimmed, error)) throw error;
          // PostgreSQL aborts the transaction even for harmless duplicate DDL.
          await tx.execute(sql.raw('ROLLBACK TO SAVEPOINT plexus_migration_statement'));
          logger.warn(
            `Ignoring idempotent DDL conflict in ${entry.tag}: ${error?.cause?.message ?? error?.message}`
          );
        }
        await tx.execute(sql.raw('RELEASE SAVEPOINT plexus_migration_statement'));
      }
      await tx.execute(sql`
        INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at)
        VALUES (${migration.hash}, ${migration.folderMillis})
      `);
    });
    appliedHashes.add(migration.hash);
  }
}

export async function runMigrations() {
  try {
    const db = getDatabase();
    const dialect = getCurrentDialect();

    logger.debug(`Running ${dialect} migrations...`);

    if (dialect === 'sqlite') {
      // In dev/source mode, re-read the journal from disk so that migrations
      // generated at runtime (e.g. by drizzle-kit generate in test setup) are
      // included. In compiled binaries, the static import is authoritative.
      const journal =
        embedded.size > 0
          ? (sqliteJournal as Journal)
          : (JSON.parse(
              await Bun.file(path.join(DEV_MIGRATIONS_DIR.sqlite, 'meta', '_journal.json')).text()
            ) as Journal);
      const migrations = await buildMigrations(journal, DEV_MIGRATIONS_DIR.sqlite);
      runSqliteMigrationsIdempotently(db, migrations, journal);
    } else {
      const journal =
        embedded.size > 0
          ? (pgJournal as Journal)
          : (JSON.parse(
              await Bun.file(path.join(DEV_MIGRATIONS_DIR.postgres, 'meta', '_journal.json')).text()
            ) as Journal);
      const migrations = await buildMigrations(journal, DEV_MIGRATIONS_DIR.postgres);
      await runPostgresMigrationsIdempotently(db, migrations, journal);
    }

    logger.debug('Migrations completed successfully');
  } catch (error: any) {
    logger.error('Migration failed', error);
    throw error;
  }
}
