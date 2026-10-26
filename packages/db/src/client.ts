import Database, { type RunResult } from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import * as schema from './schema.ts';

export type Db = BetterSQLite3Database<typeof schema>;

/** A database or a transaction on it: what the repository functions accept. */
export type Queryable = BaseSQLiteDatabase<'sync', RunResult, typeof schema>;

export interface DatabaseHandle {
  db: Db;
  close(): void;
}

/** Opens or creates a SQLite database file. Pass ":memory:" in tests. */
export function openDatabase(filename: string): DatabaseHandle {
  const sqlite = new Database(filename);
  // WAL lets the stdio MCP server, `tooldrop serve` and the CLI share one
  // database file (DECISIONS.md, D-015).
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  return { db: drizzle({ client: sqlite, schema }), close: () => sqlite.close() };
}
