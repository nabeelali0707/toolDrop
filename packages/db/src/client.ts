import { AsyncLocalStorage } from 'node:async_hooks';
import { ToolDropError } from '@tooldrop/core';
import Database from 'better-sqlite3';
import { sql, type SQL } from 'drizzle-orm';
import { drizzle as sqliteDrizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle as pgDrizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as pgSchema from './schema.pg.ts';
import * as schema from './schema.ts';

// toolDrop's database (SPEC, Data models; DECISIONS.md, D-015 and D-051):
// SQLite locally, Postgres when self-hosted. One set of repository functions
// serves both. They use only what Drizzle offers on both, awaited, and take
// their tables from `tablesOf`, since each database has its own.

export type Dialect = 'sqlite' | 'postgres';
export type Tables = typeof schema;

/**
 * A database, typed as SQLite's Drizzle instance whichever it is: the
 * repository functions are written once against these types, and the
 * parity test keeps the Postgres tables the same shape.
 */
export type Db = BetterSQLite3Database<Tables>;
/** What the repository functions accept: a database, or a transaction on it. */
export type Queryable = Db;

export interface DatabaseHandle {
  db: Db;
  dialect: Dialect;
  close(): Promise<void>;
}

const DIALECT = Symbol.for('tooldrop.db.dialect');
const TABLES = Symbol.for('tooldrop.db.tables');
const TURNS = Symbol.for('tooldrop.db.turns');

interface Marked {
  [DIALECT]: Dialect;
  [TABLES]: Tables;
  /** SQLite transactions in this process take turns (see transaction). */
  [TURNS]?: { last: Promise<unknown> };
}

/** Labels a Drizzle instance with its dialect and tables. */
export function markDatabase(db: object, dialect: Dialect): Db {
  const tables = (dialect === 'postgres' ? pgSchema : schema) as unknown as Tables;
  return Object.assign(db, {
    [DIALECT]: dialect,
    [TABLES]: tables,
    ...(dialect === 'sqlite' && { [TURNS]: { last: Promise.resolve() } }),
  }) as unknown as Db;
}

export function dialectOf(db: Queryable): Dialect {
  return (db as unknown as Marked)[DIALECT];
}

/** The tables of this database: SQLite's or Postgres's, the same shape either way. */
export function tablesOf(db: Queryable): Tables {
  return (db as unknown as Marked)[TABLES];
}

/** The first row of a result, for queries that expect one at most. */
export function first<T>(rows: T[]): T | undefined {
  return rows[0];
}

/** The row of a statement that always returns one, such as an INSERT ... RETURNING. */
export function one<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new ToolDropError('internal', 'the database returned no row');
  return row;
}

/** The SQLite database whose transaction the current work is in, so a nested one joins it. */
const openTransaction = new AsyncLocalStorage<Queryable>();

/**
 * Runs `work` in one transaction. Postgres uses a transaction of its own
 * connection. better-sqlite3 runs transactions synchronously, so on SQLite
 * this begins one on the shared connection, awaits the work and commits;
 * transactions in this process take turns, and a transaction inside another
 * joins it. Each query finishes before the next line runs, so other work can
 * only slip a statement in between two of the transaction's, and the
 * repository transactions are a few statements long.
 */
export async function transaction<T>(db: Queryable, work: (tx: Queryable) => Promise<T>): Promise<T> {
  const marked = db as unknown as Marked;
  if (marked[DIALECT] === 'postgres') {
    const pgDb = db as unknown as { transaction<R>(run: (tx: object) => Promise<R>): Promise<R> };
    return pgDb.transaction((tx) => work(markDatabase(tx, 'postgres')));
  }
  if (openTransaction.getStore() === db) return work(db);
  const turns = marked[TURNS] ?? { last: Promise.resolve() };
  const run = () =>
    openTransaction.run(db, async () => {
      db.run(sql`begin immediate`);
      try {
        const result = await work(db);
        db.run(sql`commit`);
        return result;
      } catch (error) {
        db.run(sql`rollback`);
        throw error;
      }
    });
  const next = turns.last.then(run, run);
  turns.last = next.catch(() => undefined);
  return next;
}

/**
 * Inside a transaction, waits until no other transaction holds `key`, then
 * holds it until this one ends: for read-then-write steps, such as numbering
 * the next version. A SQLite transaction holds the whole database already
 * (BEGIN IMMEDIATE); Postgres takes an advisory lock.
 */
export async function lockKey(tx: Queryable, key: string): Promise<void> {
  if (dialectOf(tx) !== 'postgres') return;
  const pgTx = tx as unknown as { execute(query: SQL): Promise<unknown> };
  await pgTx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
}

/**
 * Opens a database: a Postgres URL (postgres://...) when self-hosted, or
 * else a SQLite file, created when missing. Pass ":memory:" in tests.
 */
export function openDatabase(target: string): DatabaseHandle {
  if (/^postgres(ql)?:\/\//.test(target)) {
    const pool = new pg.Pool({ connectionString: target });
    return {
      db: markDatabase(pgDrizzle({ client: pool, schema: pgSchema }), 'postgres'),
      dialect: 'postgres',
      close: () => pool.end(),
    };
  }
  const sqlite = new Database(target);
  // WAL lets the stdio MCP server, `tooldrop serve` and the CLI share one
  // database file (DECISIONS.md, D-015).
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  return {
    db: markDatabase(sqliteDrizzle({ client: sqlite, schema }), 'sqlite'),
    dialect: 'sqlite',
    close: () => {
      sqlite.close();
      return Promise.resolve();
    },
  };
}
