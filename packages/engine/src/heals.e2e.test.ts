import { readFileSync } from 'node:fs';
import { toolFileSchema } from '@tooldrop/core';
import { getJob, listVersions, openDatabase, runMigrations, type DatabaseHandle } from '@tooldrop/db';
import { startHtmlAppFixture } from '@tooldrop/fixture-html-app';
import { startJsonApiFixture } from '@tooldrop/fixture-json-api';
import type { RunningFixture } from '@tooldrop/fixture-kit';
import { FakeProvider, type ChatRequest, type FakeReply } from '@tooldrop/llm';
import { Runtime } from '@tooldrop/runtime';
import { chromium, type Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from './engine.ts';

// SPEC's Self-heal criterion and the heal paths, with scripted model replies
// (CI never calls a model). Each fixture switch is a change a real site makes.

let browser: Browser;
let htmlApp: RunningFixture;
let jsonApi: RunningFixture;
let handle: DatabaseHandle;
let engine: Engine | undefined;

beforeAll(async () => {
  browser = await chromium.launch();
  htmlApp = await startHtmlAppFixture();
  jsonApi = await startJsonApiFixture();
});
afterAll(async () => {
  await browser.close();
  await htmlApp.close();
  await jsonApi.close();
});
beforeEach(async () => {
  handle = openDatabase(':memory:');
  runMigrations(handle.db);
  for (const fixture of [htmlApp, jsonApi]) await fetch(`${fixture.url}/__fixture/reset`, { method: 'POST' });
});
afterEach(async () => {
  await engine?.heals.idle();
  await engine?.close();
  engine = undefined;
  handle.close();
});

async function flip(fixture: RunningFixture, switches: Record<string, boolean>): Promise<void> {
  await fetch(`${fixture.url}/__fixture/switches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(switches),
  });
}

function start(replies?: Record<string, FakeReply[]>, healHoldMs?: number): Engine {
  engine = new Engine({
    db: handle.db,
    runtime: new Runtime({ browserWaitMs: 3_000 }),
    ...(healHoldMs !== undefined && { healHoldMs }),
    builds: {
      browser,
      ...(replies && {
        models: {
          provider: new FakeProvider(replies),
          models: { code: 'qwen2.5-coder:7b', reasoning: 'llama3.1:8b' },
        },
      }),
    },
  });
  return engine;
}

const prompt = (request: ChatRequest) => request.messages.find((m) => m.role === 'user')?.content ?? '';
const refIn = (request: ChatRequest, element: string) => {
  const match = new RegExp(`\\[(e\\d+)\\] ${element.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).exec(
    prompt(request),
  );
  if (!match?.[1]) throw new Error(`no ${element} on the page`);
  return match[1];
};

/** A browser tool for the HTML fixture that filters by date: the case the date-filter move breaks. */
const sinceTool = toolFileSchema.parse({
  name: 'invoices_since',
  description: 'The 10 newest invoices issued on or after a date.',
  authority: 'read',
  input_schema: {
    type: 'object',
    properties: { from: { type: 'string', format: 'date' } },
    required: ['from'],
    additionalProperties: false,
  },
  output_schema: {
    type: 'array',
    items: {
      type: 'object',
      properties: { number: { type: 'string' }, issued_on: { type: 'string' } },
      required: ['number', 'issued_on'],
    },
  },
  recipe: {
    strategy: 'browser_script',
    steps: [
      { op: 'goto', url: '{{site}}/invoices' },
      { op: 'fill', target: [{ kind: 'css', value: 'input[name=from]' }], value: '{{input.from}}' },
      {
        op: 'click',
        target: [
          { kind: 'role', role: 'button', name: 'Search' },
          { kind: 'test_id', value: 'search' },
        ],
      },
      {
        op: 'extract_table',
        target: [{ kind: 'test_id', value: 'invoices' }],
        columns: { number: 'Number', issued_on: 'Date' },
      },
    ],
  },
});

describe('self-healing', () => {
  it('repairs a broken step while the call waits, publishes v2, and returns a correct result', async () => {
    const healer = start({
      heal_patch: [
        (request) => ({
          changes: [
            {
              change: 'insert_before',
              step: 1,
              add: { op: 'click', ref: refIn(request, 'summary "Search options"') },
            },
          ],
        }),
      ],
      heal_reason: [{ reason: 'The date filter moved into a new Search options panel.' }],
    });
    healer.publish(sinceTool, htmlApp.url, { test_inputs: [{ from: '2026-03-01' }] });
    await flip(htmlApp, { dateFilterMoved: true });

    const outcome = await healer.runTool('invoices_since', { from: '2026-04-01' });
    expect(outcome.meta).toMatchObject({ healed: true, recipe_version: 2, strategy: 'browser_script' });
    const rows = outcome.result as { issued_on: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.issued_on >= '2026-04-01')).toBe(true);
    expect(listVersions(handle.db, 'invoices_since')).toMatchObject([
      { version: 1, created_by: 'user', current: false },
      {
        version: 2,
        created_by: 'heal',
        change_reason: 'The date filter moved into a new Search options panel.',
        current: true,
      },
    ]);
    // The next call runs v2 directly.
    expect((await healer.runTool('invoices_since', { from: '2026-05-01' })).meta).toMatchObject({
      healed: false,
      recipe_version: 2,
    });
  }, 120_000);

  it('rebuilds a fast path that broke in the background, while the browser answers', async () => {
    const tool = toolFileSchema.parse(
      JSON.parse(
        readFileSync(
          new URL('../../../fixtures/recipes/json-api.list_invoices.json', import.meta.url),
          'utf8',
        ),
      ),
    );
    const reviewDraft: FakeReply = (request) =>
      JSON.parse(
        prompt(request)
          .split('\n')
          .find((line) => line.startsWith('{"strategy"')) ?? '{}',
      ) as Record<string, unknown>;
    const healer = start({
      write_recipe: [reviewDraft],
      heal_reason: [{ reason: 'The invoice API moved to /api/v3.' }],
    });
    healer.publish(tool, jsonApi.url, { test_inputs: [{ status: 'paid' }] });
    await flip(jsonApi, { apiMoved: true });

    const answered = await healer.runTool('list_invoices', { status: 'paid' });
    expect(answered.meta.strategy).toBe('browser_script');
    await healer.heals.idle();

    expect(listVersions(handle.db, 'list_invoices').at(-1)).toMatchObject({
      version: 2,
      created_by: 'heal',
      change_reason: 'The invoice API moved to /api/v3.',
    });
    const fast = await healer.runTool('list_invoices', { status: 'overdue' });
    expect(fast.meta).toMatchObject({ strategy: 'http_replay', recipe_version: 2 });
    expect((fast.result as { status: string }[]).every((row) => row.status === 'overdue')).toBe(true);
  }, 120_000);

  it('refreshes selectors that drifted, without a model', async () => {
    const healer = start();
    healer.publish(sinceTool, htmlApp.url, { test_inputs: [{ from: '2026-03-01' }] });
    await flip(htmlApp, { searchButtonRenamed: true });

    // "Search" is now "Find": the test id still finds the button, so the call works.
    const drifted = await healer.runTool('invoices_since', { from: '2026-03-01' });
    expect(drifted.drift).toEqual({ strategy: 'browser_script', steps: [{ step: 2, selector: 1 }] });
    await healer.heals.idle();

    const versions = listVersions(handle.db, 'invoices_since');
    expect(versions.at(-1)).toMatchObject({ version: 2, created_by: 'heal' });
    expect(versions.at(-1)?.change_reason).toContain('button "Find"');
    expect((await healer.runTool('invoices_since', { from: '2026-03-01' })).drift).toBeUndefined();
  }, 120_000);

  it('marks the tool degraded after three failed repairs, and does not retry at once', async () => {
    const wrong: FakeReply = (request) => ({
      changes: [{ change: 'retarget', step: 1, ref: refIn(request, 'heading "Invoices"') }],
    });
    const healer = start({ heal_patch: [wrong, wrong, wrong] });
    healer.publish(sinceTool, htmlApp.url, { test_inputs: [{ from: '2026-03-01' }] });
    await flip(htmlApp, { dateFilterMoved: true });

    const failed = await healer
      .runTool('invoices_since', { from: '2026-04-01' })
      .catch((error: unknown) => error);
    expect(failed).toMatchObject({
      code: 'strategy_failed',
      message: expect.stringContaining('The repair failed too') as string,
    });
    const jobId = (failed as { details: { heal_job_id: string } }).details.heal_job_id;
    expect(getJob(handle.db, jobId)).toMatchObject({ kind: 'heal', status: 'failed' });
    expect(healer.listTools().find((tool) => tool.name === 'invoices_since')?.status).toBe('degraded');

    // A second call within the hour fails without starting another repair.
    const again = await healer
      .runTool('invoices_since', { from: '2026-04-01' })
      .catch((error: unknown) => error);
    expect(again).toMatchObject({ code: 'strategy_failed' });
    expect((again as { details?: { heal_job_id?: string } }).details?.heal_job_id).toBeUndefined();
  }, 120_000);

  it('finds and repairs a broken tool in the health check, before any caller does', async () => {
    const healer = start({
      heal_patch: [
        (request) => ({
          changes: [
            {
              change: 'insert_before',
              step: 1,
              add: { op: 'click', ref: refIn(request, 'summary "Search options"') },
            },
          ],
        }),
      ],
      heal_reason: [{ reason: 'The date filter moved into a new Search options panel.' }],
    });
    healer.publish(sinceTool, htmlApp.url, { test_inputs: [{ from: '2026-03-01' }] });
    await flip(htmlApp, { dateFilterMoved: true });
    expect(await healer.healthCheck()).toEqual([{ tool: 'invoices_since', ok: true, healed: true }]);
    expect(listVersions(handle.db, 'invoices_since').at(-1)).toMatchObject({
      version: 2,
      created_by: 'heal',
    });
  }, 120_000);

  it('answers heal_timeout with the job ID when the repair takes longer than the call may wait', async () => {
    const healer = start(
      {
        heal_patch: [
          (request) => ({
            changes: [
              {
                change: 'insert_before',
                step: 1,
                add: { op: 'click', ref: refIn(request, 'summary "Search options"') },
              },
            ],
          }),
        ],
        heal_reason: [{ reason: 'The date filter moved into a new Search options panel.' }],
      },
      50,
    );
    healer.publish(sinceTool, htmlApp.url, { test_inputs: [{ from: '2026-03-01' }] });
    await flip(htmlApp, { dateFilterMoved: true });

    const timedOut = await healer
      .runTool('invoices_since', { from: '2026-04-01' })
      .catch((error: unknown) => error);
    expect(timedOut).toMatchObject({ code: 'heal_timeout' });
    // The repair goes on, and publishes when it is done.
    await healer.heals.idle();
    expect(listVersions(handle.db, 'invoices_since').at(-1)).toMatchObject({
      version: 2,
      created_by: 'heal',
    });
  }, 120_000);
});
