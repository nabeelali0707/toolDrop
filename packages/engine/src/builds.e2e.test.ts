import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Recording, Step } from '@tooldrop/core';
import {
  createJob,
  listCaptures,
  listLlmCalls,
  openDatabase,
  runMigrations,
  setJobStatus,
  type DatabaseHandle,
} from '@tooldrop/db';
import { startJsonApiFixture } from '@tooldrop/fixture-json-api';
import type { RunningFixture } from '@tooldrop/fixture-kit';
import { FakeProvider, type ChatRequest, type FakeReply } from '@tooldrop/llm';
import { Runtime } from '@tooldrop/runtime';
import { chromium, type Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JobView } from './builds.ts';
import { Engine } from './engine.ts';

let browser: Browser;
let fixture: RunningFixture;
let handle: DatabaseHandle;
let dataDir: string;
let engine: Engine;
let provider: FakeProvider;

const models = { code: 'qwen2.5-coder:7b', reasoning: 'llama3.1:8b' };
const fast = { per_second: 200, concurrency: 4, burst: 200 };

/** Picks a status, searches, and marks the table: what `tooldrop record` saves. */
const recording = (url: string): Recording => ({
  version: 1,
  recorder: 'cli',
  recorded_at: Date.now(),
  actions: [
    { kind: 'goto', url },
    {
      kind: 'select',
      target: [{ kind: 'css', value: 'select[name="status"]' }],
      label: 'combobox "Status"',
      value: 'paid',
      options: ['', 'open', 'paid', 'overdue', 'draft'].map((value) => ({ value, label: value || 'All' })),
    },
    { kind: 'click', target: [{ kind: 'test_id', value: 'search' }], label: 'button "Search"' },
  ],
  inputs: [{ name: 'status', action: 1, example: 'paid' }],
  target: { selector: [{ kind: 'test_id', value: 'invoices' }] },
});

const prompt = (request: ChatRequest) => request.messages.find((m) => m.role === 'user')?.content ?? '';
const reviewDraft: FakeReply = (request) => {
  const line = prompt(request)
    .split('\n')
    .find((text) => text.startsWith('{"strategy"'));
  return JSON.parse(line ?? '{}') as { strategy: string; steps: Step[] };
};
const description = {
  name: 'list_invoices',
  description: 'List supplier invoices, newest first, optionally by status.',
  inputs: [{ name: 'status', description: 'Only invoices with this status.', required: false }],
  fields: [],
};

function start(replies: Record<string, FakeReply[]>, withModels = true, staleMs?: number): void {
  provider = new FakeProvider(replies);
  engine = new Engine({
    db: handle.db,
    dataDir,
    runtime: new Runtime({ browserWaitMs: 5_000 }),
    builds: {
      ...(withModels && { models: { provider, models } }),
      browser,
      compiler: { rateLimit: fast, waitMs: 5_000 },
      ...(staleMs !== undefined && { staleMs }),
    },
  });
}

async function settle(id: string, until: JobView['status'][]): Promise<JobView> {
  for (let i = 0; i < 600; i++) {
    const job = engine.getJob(id);
    if (until.includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`job ${id} did not reach ${until.join(' or ')}`);
}

beforeAll(async () => {
  browser = await chromium.launch();
  fixture = await startJsonApiFixture();
});

afterAll(async () => {
  await browser.close();
  await fixture.close();
});

beforeEach(() => {
  handle = openDatabase(':memory:');
  runMigrations(handle.db);
  dataDir = mkdtempSync(join(tmpdir(), 'tooldrop-builds-'));
});

afterEach(async () => {
  await engine.builds.idle();
  await engine.close();
  handle.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
});

describe('build jobs', () => {
  it('builds, publishes and runs a tool, and keeps the usage and the capture', async () => {
    start({ clarify: [{ questions: [] }], write_recipe: [reviewDraft], describe_tool: [description] });
    const { id: recordingId } = engine.saveRecording(recording(fixture.url));
    const started = engine.startBuild({
      url: fixture.url,
      task: 'List my invoices by status',
      authority: 'read',
      recording_id: recordingId,
    });
    expect(started.status).toMatch(/queued|running/);

    const done = await settle(started.id, ['succeeded', 'failed']);
    expect(done.error).toBeNull();
    expect(done).toMatchObject({
      status: 'succeeded',
      step: null,
      result: { tool: 'list_invoices', version: 1, strategy: 'http_replay', attempts: 1 },
      usage: { calls: 3, retries: 0 },
    });
    expect(listLlmCalls(handle.db, started.id).map((call) => call.purpose)).toEqual([
      'clarify',
      'write_recipe',
      'describe_tool',
    ]);
    const [capture] = listCaptures(handle.db, started.id);
    expect(capture && existsSync(join(dataDir, capture.har_path))).toBe(true);

    const { result, meta } = await engine.runTool('list_invoices', { status: 'overdue' });
    expect(meta.strategy).toBe('http_replay');
    expect((result as { status: string }[]).every((row) => row.status === 'overdue')).toBe(true);
  }, 120_000);

  it('pauses on a clarifying question until it is answered', async () => {
    start({
      clarify: [
        { questions: [{ text: 'Every page, or only the first?', options: ['every page', 'first page'] }] },
      ],
      write_recipe: [reviewDraft],
      describe_tool: [description],
    });
    const { id: recordingId } = engine.saveRecording(recording(fixture.url));
    const started = engine.startBuild({
      url: fixture.url,
      task: 'List invoices',
      authority: 'read',
      recording_id: recordingId,
    });

    const waiting = await settle(started.id, ['waiting_for_answer', 'failed']);
    expect(waiting.status).toBe('waiting_for_answer');
    const [question] = waiting.questions;
    expect(question).toMatchObject({
      text: 'Every page, or only the first?',
      options: ['every page', 'first page'],
    });

    const answered = engine.answerQuestion(started.id, question?.id ?? '', 'every page');
    expect(answered.questions[0]?.answer).toBe('every page');
    expect((await settle(started.id, ['succeeded', 'failed'])).status).toBe('succeeded');
    const recipePrompt = prompt(provider.requests.find((request) => request.purpose === 'write_recipe')!);
    expect(recipePrompt).toContain('Asked: Every page, or only the first?\nAnswer: every page');
  }, 120_000);

  it('reuses a published tool that already does the task', async () => {
    start({ clarify: [{ questions: [] }], write_recipe: [reviewDraft], describe_tool: [description] });
    const { id: recordingId } = engine.saveRecording(recording(fixture.url));
    const first = engine.startBuild({
      url: fixture.url,
      task: 'List invoices',
      authority: 'read',
      recording_id: recordingId,
    });
    await settle(first.id, ['succeeded', 'failed']);

    const again = engine.startBuild({ url: `${fixture.url}/`, task: 'list invoices', authority: 'read' });
    expect(again).toMatchObject({ status: 'succeeded', result: { tool: 'list_invoices', reused: true } });
  }, 120_000);

  it('fails a job whose process stopped, and a build without a model', async () => {
    start({}, false, 0);
    const orphan = createJob(handle.db, { kind: 'build', input: {} });
    setJobStatus(handle.db, orphan.id, 'running');
    // No process of this engine runs the job, and with staleMs 0 it counts as abandoned at once.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(engine.getJob(orphan.id)).toMatchObject({ status: 'failed', error: { code: 'internal' } });

    const { id: recordingId } = engine.saveRecording(recording(fixture.url));
    const started = engine.startBuild({
      url: fixture.url,
      task: 'List invoices',
      authority: 'read',
      recording_id: recordingId,
    });
    const failed = await settle(started.id, ['failed', 'succeeded']);
    expect(failed.error).toMatchObject({
      code: 'llm_unavailable',
      message: expect.stringContaining('tooldrop init') as string,
    });
  }, 60_000);

  it('checks the request and the caller', () => {
    start({});
    expect(() => engine.startBuild({ url: 'ftp://x', task: 'x', authority: 'read' })).toThrow(
      /invalid build request/,
    );
    expect(() =>
      engine.startBuild({ url: fixture.url, task: 'x', authority: 'read' }, ['list_invoices']),
    ).toThrow(/scope/);
    expect(() => engine.getJob('01JZZZZZZZZZZZZZZZZZZZZZZZ')).toThrow(/no job/);
  });
});
