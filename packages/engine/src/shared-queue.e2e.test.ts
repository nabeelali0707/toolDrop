import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Recording, Step } from '@tooldrop/core';
import { openDatabase, runMigrations, type DatabaseHandle } from '@tooldrop/db';
import { startJsonApiFixture } from '@tooldrop/fixture-json-api';
import type { RunningFixture } from '@tooldrop/fixture-kit';
import { FakeProvider, type ChatRequest, type FakeReply } from '@tooldrop/llm';
import { Runtime } from '@tooldrop/runtime';
import { chromium, type Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { JobView } from './builds.ts';
import { Engine } from './engine.ts';
import type { JobQueue, QueuedJob } from './queue.ts';

// Self-hosted toolDrop runs several processes on one database and one shared
// queue (D-052). Here two engines stand for two processes: one takes a build
// request, the other runs it. A queue in memory stands in for Valkey, whose
// own tests are in apps/server.

/** A shared, durable queue: jobs wait in the bus until a worker takes them. */
class Bus {
  readonly waiting: QueuedJob[] = [];
  worker: ((job: QueuedJob) => Promise<void>) | undefined;
  readonly running = new Set<Promise<void>>();

  queue(worker: boolean): JobQueue {
    return {
      durable: true,
      process: (run) => {
        if (!worker) return;
        this.worker = run;
        this.#next();
      },
      enqueue: (job) => {
        this.waiting.push(job);
        this.#next();
        return Promise.resolve();
      },
      idle: async () => {
        while (this.running.size > 0) await Promise.all([...this.running]);
      },
      close: () => Promise.resolve(),
    };
  }

  #next(): void {
    const job = this.worker && this.waiting.shift();
    if (!job || !this.worker) return;
    const running = this.worker(job).finally(() => this.running.delete(running));
    this.running.add(running);
  }
}

const models = { code: 'qwen2.5-coder:7b', reasoning: 'llama3.1:8b' };
const prompt = (request: ChatRequest) => request.messages.find((m) => m.role === 'user')?.content ?? '';
const reviewDraft: FakeReply = (request) => {
  const line = prompt(request)
    .split('\n')
    .find((text) => text.startsWith('{"strategy"'));
  return JSON.parse(line ?? '{}') as { strategy: string; steps: Step[] };
};
const replies = {
  clarify: [{ questions: [] }],
  write_recipe: [reviewDraft],
  describe_tool: [
    {
      name: 'list_invoices',
      description: 'List supplier invoices, newest first, optionally by status.',
      inputs: [{ name: 'status', description: 'Only invoices with this status.', required: false }],
      fields: [],
    },
  ],
};
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

let browser: Browser;
let fixture: RunningFixture;
let dataDir: string;
const handles: DatabaseHandle[] = [];
const engines: Engine[] = [];

beforeAll(async () => {
  browser = await chromium.launch();
  fixture = await startJsonApiFixture();
});
afterAll(async () => {
  await browser.close();
  await fixture.close();
});
afterEach(async () => {
  for (const engine of engines) await engine.builds.idle();
  for (const engine of engines.splice(0)) await engine.close();
  for (const handle of handles.splice(0)) await handle.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
});

/** One process: its own connection to the shared database file, and the shared bus. */
async function process_(bus: Bus, worker: boolean, staleMs?: number): Promise<Engine> {
  const handle = openDatabase(join(dataDir, 'tooldrop.db'));
  await runMigrations(handle.db);
  handles.push(handle);
  const engine = new Engine({
    db: handle.db,
    dataDir,
    runtime: new Runtime({ browserWaitMs: 5_000 }),
    builds: {
      models: { provider: new FakeProvider(replies), models },
      browser,
      compiler: { rateLimit: { per_second: 200, concurrency: 4, burst: 200 }, waitMs: 5_000 },
      queue: bus.queue(worker),
      ...(staleMs !== undefined && { staleMs }),
    },
    heals: { queue: bus.queue(worker) },
  });
  engines.push(engine);
  return engine;
}

describe('a shared queue', () => {
  it('runs a build in the process that takes it, and the one that asked sees it finish', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'tooldrop-shared-'));
    const bus = new Bus();
    // The process that takes requests runs no jobs.
    const api = await process_(bus, false);
    const { id: recordingId } = api.saveRecording(recording(fixture.url));
    const started = await api.startBuild({
      url: fixture.url,
      task: 'List my invoices by status',
      authority: 'read',
      recording_id: recordingId,
    });
    expect(bus.waiting.map((job) => job.id)).toEqual([started.id]);
    // Waiting in a shared queue is not being abandoned, even to a process that takes any job it
    // does not hold for abandoned at once (staleMs 0).
    const impatient = await process_(bus, false, 0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await impatient.getJob(started.id)).status).toBe('queued');

    const worker = await process_(bus, true);
    let job: JobView = started;
    for (let i = 0; i < 1000 && (job.status === 'queued' || job.status === 'running'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      job = await api.getJob(started.id);
    }
    expect(job.error).toBeNull();
    expect(job).toMatchObject({ status: 'succeeded', result: { tool: 'list_invoices', version: 1 } });
    await worker.builds.idle();

    const { result } = await api.runTool('list_invoices', { status: 'overdue' });
    expect((result as { status: string }[]).every((row) => row.status === 'overdue')).toBe(true);
  }, 120_000);
});
