import { fileURLToPath } from 'node:url';
import { isToolDropError } from '@tooldrop/core';
import { openDatabase, runMigrations, type DatabaseHandle } from '@tooldrop/db';
import { startHtmlAppFixture } from '@tooldrop/fixture-html-app';
import type { RunningFixture } from '@tooldrop/fixture-kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from './engine.ts';
import { readToolFile } from './tool-files.ts';

const searchInvoices = fileURLToPath(
  new URL('../../../fixtures/recipes/html-app.search_invoices.json', import.meta.url),
);

let handle: DatabaseHandle;
let engine: Engine;
let fixture: RunningFixture;

beforeEach(async () => {
  handle = openDatabase(':memory:');
  runMigrations(handle.db);
  engine = new Engine({ db: handle.db });
  fixture = await startHtmlAppFixture();
});

afterEach(async () => {
  await engine.close();
  await fixture.close();
  handle.close();
});

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isToolDropError(error)) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

describe('Engine', () => {
  it('publishes a tool file and runs it by name, recording the run', async () => {
    let changes = 0;
    engine.onToolsChanged(() => changes++);
    engine.publish(readToolFile(searchInvoices), fixture.url);
    expect(changes).toBe(1);

    const { result, meta } = await engine.runTool('search_invoices', { status: 'paid' });
    expect(meta).toMatchObject({ strategy: 'html_fetch', recipe_version: 1 });
    expect((result as { status: string }[]).every((invoice) => invoice.status === 'paid')).toBe(true);

    const runs = handle.db.query.runs.findMany().sync();
    expect(runs).toMatchObject([{ ok: true, strategy_used: 'html_fetch', recipe_version: 1 }]);
  });

  it('reports unknown tools and keys without the scope', async () => {
    engine.publish(readToolFile(searchInvoices), fixture.url);
    expect((await failure(engine.runTool('nope', {}))).code).toBe('not_found');
    expect((await failure(engine.runTool('search_invoices', {}, ['list_orders']))).code).toBe('forbidden');
    expect(engine.listTools(['list_orders'])).toEqual([]);
  });

  it('explains what is wrong with a broken tool file', () => {
    const broken = fileURLToPath(new URL('../package.json', import.meta.url));
    // Every problem is listed at once: the name, the missing schemas, the missing recipe.
    expect(() => readToolFile(broken)).toThrow(/not a valid tool file: name: .*input_schema: .*recipe: /);
  });
});
