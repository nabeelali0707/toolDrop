import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { getTableName } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import pg from 'pg';
import { markDatabase, openDatabase, type DatabaseHandle, type Db, type Dialect } from './client.ts';
import { runMigrations } from './migrate.ts';
import * as pgSchema from './schema.pg.ts';

// Databases for tests, with every migration applied: SQLite in memory, and
// Postgres in memory through PGlite, Postgres compiled to WebAssembly. With
// TOOLDROP_TEST_POSTGRES_URL set, as in CI, Postgres tests use that server
// instead, through the driver self-hosted toolDrop uses. Not part of the
// published package.

/** Both databases, for tests that run on each: `describe.each(DIALECTS)`. */
export const DIALECTS: readonly Dialect[] = ['sqlite', 'postgres'];

export async function openTestDatabase(dialect: Dialect = 'sqlite'): Promise<DatabaseHandle> {
  if (dialect === 'sqlite') {
    const handle = openDatabase(':memory:');
    await runMigrations(handle.db);
    return handle;
  }
  const server = process.env.TOOLDROP_TEST_POSTGRES_URL;
  return server ? openServerDatabase(server) : openPglite();
}

let pglite: Promise<{ client: PGlite; db: Db }> | undefined;

/**
 * One migrated PGlite per test file, emptied for each test: starting one
 * takes seconds, emptying it milliseconds. Tests in a file run one at a time.
 */
async function openPglite(): Promise<DatabaseHandle> {
  pglite ??= (async () => {
    const client = new PGlite();
    const db = markDatabase(drizzle({ client, schema: pgSchema }), 'postgres');
    await runMigrations(db);
    return { client, db };
  })();
  const { client, db } = await pglite;
  const tables = Object.values(pgSchema).map((table) => getTableName(table));
  await client.exec(`truncate ${tables.join(', ')} cascade`);
  return { db, dialect: 'postgres', close: () => Promise.resolve() };
}

/** A new database on the server, migrated, and dropped on close. */
async function openServerDatabase(server: string): Promise<DatabaseHandle> {
  const name = `tooldrop_test_${randomBytes(6).toString('hex')}`;
  await admin(server, `create database ${name}`);
  const handle = openDatabase(databaseUrl(server, name));
  const close = async () => {
    await handle.close();
    await admin(server, `drop database ${name}`);
  };
  try {
    await runMigrations(handle.db);
  } catch (error) {
    await close();
    throw error;
  }
  return { ...handle, close };
}

async function admin(server: string, statement: string): Promise<void> {
  const client = new pg.Client({ connectionString: server });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

function databaseUrl(server: string, name: string): string {
  const url = new URL(server);
  url.pathname = `/${name}`;
  return url.toString();
}
