import { readFileSync } from 'node:fs';
import { newId } from '@tooldrop/core';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db, type DatabaseHandle } from './client.ts';
import { runMigrations } from './migrate.ts';
import * as t from './schema.ts';

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
function seed(db: Db) {
  const site = db
    .insert(t.sites)
    .values({ id: newId(), origin: 'https://supplier.example.com', name: 'Supplier portal' })
    .returning()
    .get();
  const login = db
    .insert(t.logins)
    .values({
      id: newId(),
      site_id: site.id,
      label: 'accounts payable',
      encrypted_secret: Buffer.from([1, 2, 3]),
      twofa_method: 'sms',
      twofa_config: { sender: '+15550100', code_pattern: '(\\d{6})' },
    })
    .returning()
    .get();
  const session = db
    .insert(t.sessions)
    .values({ id: newId(), login_id: login.id, storage_state: Buffer.from('sealed') })
    .returning()
    .get();
  const tool = db
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
    .returning()
    .get();
  const recipe = db
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
    .returning()
    .get();
  const job = db
    .insert(t.jobs)
    .values({ id: newId(), kind: 'heal', input: { tool_id: tool.id } })
    .returning()
    .get();
  const run = db
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
    .returning()
    .get();
  const llmCall = db
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
    .returning()
    .get();
  const watch = db
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
    .returning()
    .get();
  const approval = db
    .insert(t.approvals)
    .values({ id: newId(), run_id: run.id, preview: { fields: { amount: 90 } } })
    .returning()
    .get();
  const capture = db
    .insert(t.captures)
    .values({ id: newId(), job_id: job.id, har_path: 'captures/one.har', ax_trees: ['captures/one.ax.json'] })
    .returning()
    .get();
  return { site, login, session, tool, recipe, job, run, llmCall, watch, approval, capture };
}

/** The SQLite error behind a failed statement. Drizzle wraps some errors, keeping SQLite's as the cause. */
function sqliteError(statement: () => unknown): string {
  try {
    statement();
  } catch (error) {
    let inner: unknown = error;
    while (inner instanceof Error && inner.cause instanceof Error) inner = inner.cause;
    return inner instanceof Error ? inner.message : String(inner);
  }
  throw new Error('expected the statement to fail');
}

let handle: DatabaseHandle;

beforeEach(() => {
  handle = openDatabase(':memory:');
  runMigrations(handle.db);
});

afterEach(() => handle.close());

describe('migrations', () => {
  it("create every table in SPEC's data model", () => {
    const tables = handle.db
      .all<{ name: string }>(sql`select name from sqlite_master where type = 'table'`)
      .map((row) => row.name);
    expect(specTables()).toHaveLength(11);
    expect(tables).toEqual(expect.arrayContaining(specTables()));
  });
});

describe('schema', () => {
  it('round-trips JSON, booleans, blobs and timestamps', () => {
    const rows = seed(handle.db);
    const { db } = handle;

    const site = db.select().from(t.sites).where(eq(t.sites.id, rows.site.id)).get();
    expect(site?.approved_auth_origins).toEqual([]);
    expect(site?.rate_limit).toEqual({ per_second: 1, concurrency: 2 });
    expect(site?.created_at).toBeInstanceOf(Date);

    const login = db.select().from(t.logins).where(eq(t.logins.id, rows.login.id)).get();
    expect(login?.encrypted_secret).toEqual(Buffer.from([1, 2, 3]));
    expect(login?.twofa_config).toEqual({ sender: '+15550100', code_pattern: '(\\d{6})' });
    expect(login?.status).toBe('unchecked');

    const recipe = db.select().from(t.recipe_versions).where(eq(t.recipe_versions.id, rows.recipe.id)).get();
    expect(recipe?.steps).toEqual(steps);
    expect(recipe?.test_inputs).toEqual([{ status: 'open' }]);

    const job = db.select().from(t.jobs).where(eq(t.jobs.id, rows.job.id)).get();
    expect(job).toMatchObject({ status: 'queued', questions: [], answers: [], result: null });

    const run = db.select().from(t.runs).where(eq(t.runs.id, rows.run.id)).get();
    expect(run).toMatchObject({ ok: true, healed: true, heal_job_id: rows.job.id });

    const llmCall = db.select().from(t.llm_calls).where(eq(t.llm_calls.id, rows.llmCall.id)).get();
    expect(llmCall).toMatchObject({ ok: false, attempt: 2, prompt_tokens: 3100 });

    const approval = db.select().from(t.approvals).where(eq(t.approvals.id, rows.approval.id)).get();
    expect(approval?.status).toBe('pending');

    const capture = db.select().from(t.captures).where(eq(t.captures.id, rows.capture.id)).get();
    expect(capture).toMatchObject({ dom_snapshots: [], ax_trees: ['captures/one.ax.json'], actions: [] });
  });

  it('enforces foreign keys', () => {
    const orphan = { id: newId(), site_id: newId(), label: 'x', encrypted_secret: Buffer.from('x') };
    expect(sqliteError(() => handle.db.insert(t.logins).values(orphan).run())).toBe(
      'FOREIGN KEY constraint failed',
    );
  });

  it('keeps enum columns to their values', () => {
    const { tool } = seed(handle.db);
    const update = () => handle.db.run(sql`update tools set status = 'broken' where id = ${tool.id}`);
    expect(sqliteError(update)).toBe('CHECK constraint failed: tools_status');
  });

  it('allows one row per tool version', () => {
    const { recipe } = seed(handle.db);
    const again = { ...recipe, id: newId() };
    expect(sqliteError(() => handle.db.insert(t.recipe_versions).values(again).run())).toBe(
      'UNIQUE constraint failed: recipe_versions.tool_id, recipe_versions.version',
    );
  });

  it('rejects watches more frequent than every 5 minutes', () => {
    const { watch } = seed(handle.db);
    const tooOften = { ...watch, id: newId(), interval_s: 60 };
    expect(sqliteError(() => handle.db.insert(t.watches).values(tooOften).run())).toBe(
      'CHECK constraint failed: watches_min_interval',
    );
  });

  it("deletes a site's logins, sessions and tools with it", () => {
    const { site } = seed(handle.db);
    handle.db.delete(t.sites).where(eq(t.sites.id, site.id)).run();
    for (const table of [t.logins, t.sessions, t.tools, t.recipe_versions, t.runs, t.watches, t.approvals]) {
      expect(handle.db.select().from(table).all()).toEqual([]);
    }
  });

  it('keeps run history when its heal job is deleted', () => {
    const { job, run } = seed(handle.db);
    handle.db.delete(t.jobs).where(eq(t.jobs.id, job.id)).run();
    const kept = handle.db.select().from(t.runs).where(eq(t.runs.id, run.id)).get();
    expect(kept?.heal_job_id).toBeNull();
  });
});
