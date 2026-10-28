import { readFileSync } from 'node:fs';
import { isToolDropError, toolFileSchema } from '@tooldrop/core';
import { startHtmlAppFixture } from '@tooldrop/fixture-html-app';
import { startJsonApiFixture } from '@tooldrop/fixture-json-api';
import type { RunningFixture } from '@tooldrop/fixture-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Runtime, type RunnableTool } from './runtime.ts';

/** A hand-written tool from fixtures/recipes, pointed at a running fixture. */
function fixtureTool(file: string, site: string, extra: Partial<RunnableTool> = {}): RunnableTool {
  const raw: unknown = JSON.parse(
    readFileSync(new URL(`../../../fixtures/recipes/${file}`, import.meta.url), 'utf8'),
  );
  // Tests run many calls back to back; real sites keep the default limits.
  return {
    ...toolFileSchema.parse(raw),
    version: 1,
    site,
    rate_limit: { per_second: 200, concurrency: 4, burst: 200 },
    ...extra,
  };
}

async function flip(fixture: RunningFixture, switches: Record<string, boolean>): Promise<void> {
  await fetch(`${fixture.url}/__fixture/switches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(switches),
  });
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isToolDropError(error)) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

interface Invoice {
  number: string;
  amount: number;
  status: string;
  issued_on: string;
}

let runtime: Runtime;
let fixture: RunningFixture;

beforeAll(() => {
  runtime = new Runtime({ browserWaitMs: 5_000 });
});

afterAll(() => runtime.close());

afterEach(() => fixture.close());

describe('http_replay with a browser fallback (json-api fixture)', () => {
  const start = async () => {
    fixture = await startJsonApiFixture();
    return fixtureTool('json-api.list_invoices.json', fixture.url);
  };

  it('replays the JSON API: page token, every page, mapped fields', async () => {
    const tool = await start();
    const { result, meta } = await runtime.run(tool, {});
    expect(meta).toMatchObject({ strategy: 'http_replay', recipe_version: 1, healed: false });
    expect(result).toHaveLength(57);
    expect((result as Invoice[])[0]).toEqual({
      number: 'INV-1057',
      supplier: 'Brightline Logistics',
      issued_on: expect.any(String) as string,
      amount: 844.64,
      status: 'open',
    });
  });

  it('passes inputs through as filters', async () => {
    const tool = await start();
    const { result } = await runtime.run(tool, { status: 'paid', from: '2026-03-01' });
    const invoices = result as Invoice[];
    expect(invoices.length).toBeGreaterThan(0);
    for (const invoice of invoices) {
      expect(invoice.status).toBe('paid');
      expect(invoice.issued_on >= '2026-03-01').toBe(true);
    }
  });

  it(
    'falls back to the browser when the JSON API moves, with the same answer',
    { timeout: 60_000 },
    async () => {
      const tool = await start();
      const viaApi = (await runtime.run(tool, { status: 'open' })).result;
      await flip(fixture, { apiMoved: true });

      const viaBrowser = await runtime.run(tool, { status: 'open' });
      expect(viaBrowser.meta.strategy).toBe('browser_script');
      expect(viaBrowser.attempts[0]).toMatchObject({ strategy: 'http_replay', ok: false });
      expect(viaBrowser.attempts[0]?.error?.message).toContain('answered 410');
      expect(viaBrowser.result).toEqual(viaApi);
    },
  );

  it('finds a renamed button by its next selector', { timeout: 60_000 }, async () => {
    const tool = await start();
    await flip(fixture, { apiMoved: true, searchButtonRenamed: true });
    const { meta, result } = await runtime.run(tool, { status: 'draft' });
    expect(meta.strategy).toBe('browser_script');
    expect((result as Invoice[]).every((invoice) => invoice.status === 'draft')).toBe(true);
  });

  it('fails with every attempt listed when no strategy works', { timeout: 60_000 }, async () => {
    const tool = await start();
    // The API moved, and the date filter now hides in a collapsed panel: a heal's job.
    await flip(fixture, { apiMoved: true, dateFilterMoved: true });
    const error = await failure(runtime.run(tool, { from: '2026-02-01' }));
    expect(error.code).toBe('strategy_failed');
    const attempts = (error.details as { attempts: { strategy: string; ok: boolean }[] }).attempts;
    expect(attempts.map((attempt) => [attempt.strategy, attempt.ok])).toEqual([
      ['http_replay', false],
      ['browser_script', false],
    ]);
  });
});

describe('html_fetch with a browser fallback (html-app fixture)', () => {
  const start = async () => {
    fixture = await startHtmlAppFixture();
    return fixtureTool('html-app.search_invoices.json', fixture.url);
  };

  it('parses the server-rendered table into typed rows', async () => {
    const tool = await start();
    const { result, meta } = await runtime.run(tool, { status: 'overdue' });
    expect(meta.strategy).toBe('html_fetch');
    const invoices = result as Invoice[];
    expect(invoices.length).toBeGreaterThan(0);
    expect(invoices.length).toBeLessThanOrEqual(10);
    for (const invoice of invoices) {
      expect(invoice.status).toBe('overdue');
      expect(typeof invoice.amount).toBe('number');
    }
  });

  it('keeps working when the columns are reordered', async () => {
    const tool = await start();
    const before = (await runtime.run(tool, {})).result;
    await flip(fixture, { columnsReordered: true });
    expect((await runtime.run(tool, {})).result).toEqual(before);
  });

  it('fetches an HTML page once, even when its recipe asks to page it', async () => {
    // The recipe qwen2.5-coder:7b wrote for this fixture: a JSON paging condition
    // on an HTML page, which used to repeat the same request 50 times.
    fixture = await startHtmlAppFixture();
    const tool = fixtureTool('html-app.search_invoices.json', fixture.url);
    tool.output_schema = { type: 'array' };
    tool.recipe = {
      strategy: 'html_fetch',
      steps: [
        {
          op: 'http',
          method: 'GET',
          url: '{{site}}/invoices',
          query: { status: '{{input.status}}' },
          paginate: { var: 'page', until: '$.hasMore == false', start: 1 },
        },
        {
          op: 'extract_table',
          target: [{ kind: 'test_id', value: 'invoices' }],
          columns: { number: 'Number', amount: 'Amount', status: 'Status' },
        },
      ],
    };
    const { result, meta } = await runtime.run(tool, { status: 'paid' });
    expect(meta.duration_ms).toBeLessThan(5_000);
    expect((result as Invoice[]).every((invoice) => invoice.status === 'paid')).toBe(true);
  });

  it('accepts an empty result once the browser agrees', { timeout: 60_000 }, async () => {
    const tool = await start();
    const { result, meta, attempts } = await runtime.run(tool, { from: '2099-01-01' });
    expect(result).toEqual([]);
    expect(meta.strategy).toBe('html_fetch');
    expect(attempts.map((attempt) => attempt.strategy)).toEqual(['html_fetch', 'browser_script']);
  });
});

describe('before any strategy runs', () => {
  it('rejects input that does not match the schema', async () => {
    fixture = await startHtmlAppFixture();
    const tool = fixtureTool('html-app.search_invoices.json', fixture.url);
    const error = await failure(runtime.run(tool, { status: 'lost' }));
    expect(error.code).toBe('invalid_input');
  });

  it('refuses to run a write tool directly: writes go through safe mode', async () => {
    fixture = await startHtmlAppFixture();
    const tool = fixtureTool('html-app.search_invoices.json', fixture.url, { authority: 'write' });
    expect((await failure(runtime.run(tool, {}))).code).toBe('approval_required');
  });

  it('serves repeated calls from the cache when the tool has one', async () => {
    fixture = await startHtmlAppFixture();
    const tool = fixtureTool('html-app.search_invoices.json', fixture.url, { cache_ttl_ms: 60_000 });
    const first = await runtime.run(tool, { status: 'paid' });
    await flip(fixture, { columnsReordered: true });
    const second = await runtime.run(tool, { status: 'paid' });
    expect(second).toBe(first);
  });
});
