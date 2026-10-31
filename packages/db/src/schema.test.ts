import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId } from '@tooldrop/core';
import { eq, getTableName, sql, type SQL, type Table } from 'drizzle-orm';
import { getTableConfig as pgTableConfig } from 'drizzle-orm/pg-core';
import { migrate as migrateSqlite } from 'drizzle-orm/better-sqlite3/migrator';
import { getTableConfig as sqliteTableConfig } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { first, one, openDatabase, tablesOf, type Db, type DatabaseHandle } from './client.ts';
import { MIGRATIONS_FOLDER, runMigrations } from './migrate.ts';
import * as pgTables from './schema.pg.ts';
import * as sqliteTables from './schema.ts';
import { DIALECTS, openTestDatabase } from './testing.ts';

/** Table names from the data model in SPEC.md, so spec and schema cannot drift apart. */
function specTables(): string[] {
  const spec = readFileSync(new URL('../../../SPEC.md', import.meta.url), 'utf8');
  const start = spec.indexOf('## Data models');
  const section = spec.slice(start, spec.indexOf('**Recipe step format**', start));
  return [...section.matchAll(/^\| `([a-z_]+)` \|/gm)].map((match) => match[1] ?? '');
}

const steps = [
  { op: 'http' as const, method: 'POST' as const, url: '{{site}}/api/v2/invoices/search' },
  { op: 'map' as const, path: '$.items[*]', fields: { number: '$.invoiceNo' } },
];

/** One row in every table, linked the way the product links them. */
async function seed(db: Db) {
  const t = tablesOf(db);
  const site = one(
    await db
      .insert(t.sites)
      .values({ id: newId(), origin: 'https://supplier.example.com', name: 'Supplier portal' })
      .returning(),
  );
  const login = one(
    await db
      .insert(t.logins)
      .values({
        id: newId(),
        site_id: site.id,
        label: 'accounts payable',
        encrypted_secret: Buffer.from([1, 2, 3]),
        twofa_method: 'sms',
        twofa_config: { sender: '+15550100', code_pattern: '(\\d{6})' },
      })
      .returning(),
  );
  const session = one(
    await db
      .insert(t.sessions)
      .values({ id: newId(), login_id: login.id, storage_state: Buffer.from('sealed') })
      .returning(),
  );
  const tool = one(
    await db
      .insert(t.tools)
      .values({
        id: newId(),
        site_id: site.id,
        name: 'list_invoices',
        description: 'List invoices by status and date.',
        authority: 'read',
        input_schema: { type: 'object', properties: { status: { type: 'string' } } },
        output_schema: { type: 'array' },
        current_version: 1,
      })
      .returning(),
  );
  const recipe = one(
    await db
      .insert(t.recipe_versions)
      .values({
        id: newId(),
        tool_id: tool.id,
        version: 1,
        strategy: 'http_replay',
        steps,
        test_inputs: [{ status: 'open' }],
        created_by: 'build',
      })
      .returning(),
  );
  const job = one(
    await db
      .insert(t.jobs)
      .values({ id: newId(), kind: 'heal', input: { tool_id: tool.id } })
      .returning(),
  );
  const run = one(
    await db
      .insert(t.runs)
      .values({
        id: newId(),
        tool_id: tool.id,
        recipe_version: 1,
        strategy_used: 'browser_script',
        duration_ms: 4200,
        ok: true,
        healed: true,
        heal_job_id: job.id,
      })
      .returning(),
  );
  const llmCall = one(
    await db
      .insert(t.llm_calls)
      .values({
        id: newId(),
        job_id: job.id,
        provider: 'ollama',
        model: 'qwen2.5-coder:7b',
        role: 'code',
        prompt_tokens: 3100,
        completion_tokens: 420,
        duration_ms: 9800,
        attempt: 2,
        ok: false,
        error_code: 'llm_invalid_output',
      })
      .returning(),
  );
  const watch = one(
    await db
      .insert(t.watches)
      .values({
        id: newId(),
        tool_id: tool.id,
        inputs: { status: 'open' },
        interval_s: 300,
        key_field: 'number',
        webhook_url: 'https://hooks.example.com/invoices',
        secret: Buffer.from('sealed'),
      })
      .returning(),
  );
  const approval = one(
    await db
      .insert(t.approvals)
      .values({
        id: newId(),
        tool_id: tool.id,
        version: 1,
        inputs: { amount: 90 },
        preview: { url: 'https://supplier.example.com/pay', action: 'click Pay', fields: [] },
        expires_at: new Date(Date.now() + 86_400_000),
        run_id: run.id,
      })
      .returning(),
  );
  const capture = one(
    await db
      .insert(t.captures)
      .values({
        id: newId(),
        job_id: job.id,
        har_path: 'captures/one.har',
        ax_trees: ['captures/one.ax.json'],
      })
      .returning(),
  );
  return { site, login, session, tool, recipe, job, run, llmCall, watch, approval, capture };
}

/** The database's own error behind a failed statement. Drizzle wraps errors, keeping the driver's as the cause. */
async function databaseError(statement: () => Promise<unknown>): Promise<string> {
  try {
    await statement();
  } catch (error) {
    let inner: unknown = error;
    while (inner instanceof Error && inner.cause instanceof Error) inner = inner.cause;
    return inner instanceof Error ? inner.message : String(inner);
  }
  throw new Error('expected the statement to fail');
}

async function tableNames(handle: DatabaseHandle): Promise<string[]> {
  if (handle.dialect === 'sqlite') {
    return handle.db
      .all<{ name: string }>(sql`select name from sqlite_master where type = 'table'`)
      .map((row) => row.name);
  }
  const pgDb = handle.db as unknown as { execute(query: SQL): Promise<{ rows: { name: string }[] }> };
  const result = await pgDb.execute(
    sql`select table_name as name from information_schema.tables where table_schema = 'public'`,
  );
  return result.rows.map((row) => row.name);
}

describe.each(DIALECTS)('on %s', (dialect) => {
  let handle: DatabaseHandle;

  beforeEach(async () => {
    handle = await openTestDatabase(dialect);
  });

  afterEach(() => handle.close());

  /** The message each database gives for a broken constraint. */
  const broken = (messages: { sqlite: RegExp; postgres: RegExp }) => messages[dialect];

  describe('migrations', () => {
    it("create every table in SPEC's data model", async () => {
      expect(specTables()).toHaveLength(11);
      expect(await tableNames(handle)).toEqual(expect.arrayContaining(specTables()));
    });
  });

  describe('schema', () => {
    it('round-trips JSON, booleans, blobs and timestamps', async () => {
      const rows = await seed(handle.db);
      const { db } = handle;
      const t = tablesOf(db);

      const site = first(await db.select().from(t.sites).where(eq(t.sites.id, rows.site.id)));
      expect(site?.approved_auth_origins).toEqual([]);
      expect(site?.rate_limit).toEqual({ per_second: 1, concurrency: 2 });
      expect(site?.created_at).toBeInstanceOf(Date);
      expect(site?.created_at).toEqual(rows.site.created_at);

      const login = first(await db.select().from(t.logins).where(eq(t.logins.id, rows.login.id)));
      expect(login?.encrypted_secret).toEqual(Buffer.from([1, 2, 3]));
      expect(Buffer.isBuffer(login?.encrypted_secret)).toBe(true);
      expect(login?.twofa_config).toEqual({ sender: '+15550100', code_pattern: '(\\d{6})' });
      expect(login?.status).toBe('unchecked');

      const recipe = first(
        await db.select().from(t.recipe_versions).where(eq(t.recipe_versions.id, rows.recipe.id)),
      );
      expect(recipe?.steps).toEqual(steps);
      expect(recipe?.test_inputs).toEqual([{ status: 'open' }]);

      const job = first(await db.select().from(t.jobs).where(eq(t.jobs.id, rows.job.id)));
      expect(job).toMatchObject({ status: 'queued', questions: [], answers: [], result: null });

      const run = first(await db.select().from(t.runs).where(eq(t.runs.id, rows.run.id)));
      expect(run).toMatchObject({ ok: true, healed: true, heal_job_id: rows.job.id });

      const llmCall = first(await db.select().from(t.llm_calls).where(eq(t.llm_calls.id, rows.llmCall.id)));
      expect(llmCall).toMatchObject({ ok: false, attempt: 2, prompt_tokens: 3100 });

      const approval = first(await db.select().from(t.approvals).where(eq(t.approvals.id, rows.approval.id)));
      expect(approval?.status).toBe('pending');
      expect(approval?.expires_at).toEqual(rows.approval.expires_at);

      const capture = first(await db.select().from(t.captures).where(eq(t.captures.id, rows.capture.id)));
      expect(capture).toMatchObject({ dom_snapshots: [], ax_trees: ['captures/one.ax.json'], actions: [] });
    });

    it('enforces foreign keys', async () => {
      const { logins } = tablesOf(handle.db);
      const orphan = { id: newId(), site_id: newId(), label: 'x', encrypted_secret: Buffer.from('x') };
      expect(await databaseError(() => handle.db.insert(logins).values(orphan))).toMatch(
        broken({
          sqlite: /^FOREIGN KEY constraint failed$/,
          postgres: /violates foreign key constraint "logins_site_id_sites_id_fk"/,
        }),
      );
    });

    it('keeps enum columns to their values', async () => {
      const { tool } = await seed(handle.db);
      const { tools } = tablesOf(handle.db);
      const update = () =>
        handle.db
          .update(tools)
          .set({ status: 'broken' as 'live' })
          .where(eq(tools.id, tool.id));
      expect(await databaseError(update)).toMatch(
        broken({
          sqlite: /^CHECK constraint failed: tools_status$/,
          postgres: /violates check constraint "tools_status"/,
        }),
      );
    });

    it('allows one row per tool version', async () => {
      const { recipe } = await seed(handle.db);
      const { recipe_versions } = tablesOf(handle.db);
      const again = { ...recipe, id: newId() };
      expect(await databaseError(() => handle.db.insert(recipe_versions).values(again))).toMatch(
        broken({
          sqlite: /^UNIQUE constraint failed: recipe_versions.tool_id, recipe_versions.version$/,
          postgres: /violates unique constraint "recipe_versions_tool_version_unique"/,
        }),
      );
    });

    it('rejects watches more frequent than every 5 minutes', async () => {
      const { watch } = await seed(handle.db);
      const { watches } = tablesOf(handle.db);
      const tooOften = { ...watch, id: newId(), interval_s: 60 };
      expect(await databaseError(() => handle.db.insert(watches).values(tooOften))).toMatch(
        broken({
          sqlite: /^CHECK constraint failed: watches_min_interval$/,
          postgres: /violates check constraint "watches_min_interval"/,
        }),
      );
    });

    it("deletes a site's logins, sessions and tools with it", async () => {
      const { site } = await seed(handle.db);
      const t = tablesOf(handle.db);
      await handle.db.delete(t.sites).where(eq(t.sites.id, site.id));
      for (const table of [
        t.logins,
        t.sessions,
        t.tools,
        t.recipe_versions,
        t.runs,
        t.watches,
        t.approvals,
      ]) {
        expect(await handle.db.select().from(table)).toEqual([]);
      }
    });

    it('keeps run history when its heal job is deleted', async () => {
      const { job, run } = await seed(handle.db);
      const t = tablesOf(handle.db);
      await handle.db.delete(t.jobs).where(eq(t.jobs.id, job.id));
      const kept = first(await handle.db.select().from(t.runs).where(eq(t.runs.id, run.id)));
      expect(kept?.heal_job_id).toBeNull();
    });
  });
});

// The Postgres tables must match the SQLite ones, which the repository
// functions are typed against (client.ts): the same rows in TypeScript, and
// the same columns, keys, indexes and checks in the database.

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Rows<T> = { [K in keyof T]: T[K] extends { $inferSelect: infer Row } ? Row : never };
type Inserts<T> = { [K in keyof T]: T[K] extends { $inferInsert: infer Row } ? Row : never };
const sameRows: Same<Rows<typeof sqliteTables>, Rows<typeof pgTables>> = true;
const sameInserts: Same<Inserts<typeof sqliteTables>, Inserts<typeof pgTables>> = true;

interface TableShape {
  columns: { name: string; notNull: boolean; primary: boolean; hasDefault: boolean; enumValues?: string[] }[];
  indexes: { name: string; unique: boolean; columns: string[] }[];
  checks: string[];
  foreignKeys: { columns: string[]; table: string; foreignColumns: string[]; onDelete?: string }[];
}

type AnyTableConfig = ReturnType<typeof sqliteTableConfig> | ReturnType<typeof pgTableConfig>;

function shapeOf(config: AnyTableConfig): TableShape {
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  return {
    columns: config.columns
      .map((column) => {
        const values = column.enumValues as readonly string[] | undefined;
        return {
          name: column.name,
          notNull: column.notNull,
          primary: column.primary,
          hasDefault: column.hasDefault,
          enumValues: values?.length ? [...values] : undefined,
        };
      })
      .sort(byName),
    indexes: config.indexes
      .map((index) => ({
        name: index.config.name ?? '',
        unique: index.config.unique,
        columns: index.config.columns.map((column) => ('name' in column ? String(column.name) : '?')),
      }))
      .sort(byName),
    checks: config.checks.map((check) => check.name).sort(),
    foreignKeys: config.foreignKeys
      .map((key) => {
        const reference = key.reference();
        return {
          columns: reference.columns.map((column) => column.name),
          table: getTableName(reference.foreignTable as Table),
          foreignColumns: reference.foreignColumns.map((column) => column.name),
          onDelete: key.onDelete,
        };
      })
      .sort((a, b) => a.columns.join().localeCompare(b.columns.join())),
  };
}

describe('Postgres tables', () => {
  it('match the SQLite tables', () => {
    expect(sameRows && sameInserts).toBe(true);
    const sqliteNames = Object.values(sqliteTables).map((table) => getTableName(table));
    const pgNames = Object.values(pgTables).map((table) => getTableName(table));
    expect(pgNames.sort()).toEqual(sqliteNames.sort());
    for (const [name, table] of Object.entries(sqliteTables)) {
      const pgTable = pgTables[name as keyof typeof pgTables];
      expect(shapeOf(pgTableConfig(pgTable)), name).toEqual(shapeOf(sqliteTableConfig(table)));
    }
  });
});

describe('the SQLite upgrade that adds workflows (0006)', () => {
  it("keeps every job's model calls, captures and heal links while jobs is rebuilt", async () => {
    // A database as the version before had it: every migration up to 0005.
    const folder = mkdtempSync(join(tmpdir(), 'tooldrop-migrations-'));
    cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
    const journalPath = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
    journal.entries = journal.entries.filter((entry) => entry.tag < '0006');
    writeFileSync(journalPath, JSON.stringify(journal));
    const handle = openDatabase(':memory:');
    try {
      migrateSqlite(handle.db, { migrationsFolder: folder });
      const rows = await seed(handle.db);

      await runMigrations(handle.db);
      const t = tablesOf(handle.db);
      expect(await handle.db.select().from(t.llm_calls)).toHaveLength(1);
      expect(await handle.db.select().from(t.captures)).toHaveLength(1);
      const run = first(await handle.db.select().from(t.runs).where(eq(t.runs.id, rows.run.id)));
      expect(run?.heal_job_id).toBe(rows.job.id);
      // The new kind, and the foreign keys still checked.
      await handle.db.insert(t.jobs).values({ id: newId(), kind: 'workflow', input: {} });
      expect(
        await databaseError(() =>
          handle.db.insert(t.llm_calls).values({ ...rows.llmCall, id: newId(), job_id: newId() }),
        ),
      ).toBe('FOREIGN KEY constraint failed');
    } finally {
      await handle.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
