import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listLlmCalls, openDatabase, runMigrations, type DatabaseHandle } from '@tooldrop/db';
import { Engine, type JobView } from '@tooldrop/engine';
import { startHtmlAppFixture } from '@tooldrop/fixture-html-app';
import { startJsonApiFixture } from '@tooldrop/fixture-json-api';
import type { RunningFixture } from '@tooldrop/fixture-kit';
import { ollamaUrl, OllamaProvider, RecordingProvider } from '@tooldrop/llm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// The Phase 2 builds with real models (`pnpm test:llm`, never in CI). They use
// the local Ollama and TOOLDROP_CODE_MODEL / TOOLDROP_REASONING_MODEL, or the
// defaults. With TOOLDROP_RECORD_REPLIES=1 the replies are saved to
// fixtures/llm-replies/, which build-replay.e2e.test.ts replays in CI.

const models = {
  code: process.env.TOOLDROP_CODE_MODEL ?? 'qwen2.5-coder:7b',
  reasoning: process.env.TOOLDROP_REASONING_MODEL ?? 'llama3.1:8b',
};
const record = process.env.TOOLDROP_RECORD_REPLIES === '1';
const repliesDir = fileURLToPath(new URL('../../../fixtures/llm-replies/', import.meta.url));
// A 7B model on a CPU reads long prompts slowly; a build can take most of an hour there.
const BUILD_TIMEOUT = 60 * 60_000;

let jsonApi: RunningFixture;
let htmlApp: RunningFixture;
let handle: DatabaseHandle;
let dataDir: string;
let engine: Engine;
let provider: RecordingProvider;

beforeAll(async () => {
  jsonApi = await startJsonApiFixture();
  htmlApp = await startHtmlAppFixture();
});

afterAll(async () => {
  await jsonApi.close();
  await htmlApp.close();
});

function start(): Engine {
  handle = openDatabase(':memory:');
  runMigrations(handle.db);
  dataDir = mkdtempSync(join(tmpdir(), 'tooldrop-llm-'));
  provider = new RecordingProvider(new OllamaProvider(ollamaUrl(), { timeoutMs: BUILD_TIMEOUT }));
  engine = new Engine({ db: handle.db, dataDir, builds: { models: { provider, models } } });
  return engine;
}

afterEach(async () => {
  await engine.builds.idle();
  await engine.close();
  handle.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
});

async function finished(id: string): Promise<JobView> {
  for (;;) {
    const job = engine.getJob(id);
    if (job.status === 'succeeded' || job.status === 'failed') return job;
    if (job.status === 'waiting_for_answer') {
      // A real model may ask; the tests answer like a person who wants every row.
      const open = job.questions.find((question) => question.answer === undefined);
      if (open) engine.answerQuestion(id, open.id, open.options?.[0] ?? 'every page, all rows');
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

function report(name: string, job: JobView): void {
  const calls = listLlmCalls(handle.db, job.id).map(
    (call) => `${call.purpose}#${call.attempt}${call.ok ? '' : ' (invalid)'}`,
  );
  console.log(
    `${name}: ${job.status} in ${(job.usage.duration_ms / 1000).toFixed(0)} s of model time;`,
    calls.join(', '),
  );
  if (record) {
    mkdirSync(repliesDir, { recursive: true });
    provider.save(join(repliesDir, `${name}.json`));
  }
}

describe('builds with real models', () => {
  it(
    'Build (JSON API fixture): from a task description',
    async () => {
      start();
      const job = await finished(
        engine.startBuild({
          url: jsonApi.url,
          task: 'List my supplier invoices, filtered by status',
          authority: 'read',
        }).id,
      );
      report('json-api-explore', job);
      expect(job.error).toBeNull();
      expect(job.result).toMatchObject({ strategy: 'http_replay' });
    },
    BUILD_TIMEOUT,
  );

  it(
    'Build (HTML fixture): from a recording',
    async () => {
      start();
      const { id } = engine.saveRecording({
        version: 1,
        recorder: 'cli',
        recorded_at: Date.now(),
        actions: [
          { kind: 'goto', url: `${htmlApp.url}/invoices` },
          {
            kind: 'select',
            target: [{ kind: 'css', value: 'select[name="status"]' }],
            label: 'combobox "Status"',
            value: 'overdue',
            options: ['', 'open', 'paid', 'overdue', 'draft'].map((value) => ({
              value,
              label: value || 'All',
            })),
          },
          { kind: 'click', target: [{ kind: 'test_id', value: 'search' }], label: 'button "Search"' },
        ],
        inputs: [{ name: 'status', action: 1, example: 'overdue' }],
        target: { selector: [{ kind: 'test_id', value: 'invoices' }] },
      });
      const job = await finished(
        engine.startBuild({
          url: `${htmlApp.url}/invoices`,
          task: 'Search invoices by status',
          authority: 'read',
          recording_id: id,
        }).id,
      );
      report('html-app-recording', job);
      expect(job.error).toBeNull();
      expect(job.result).toMatchObject({ strategy: 'html_fetch' });
    },
    BUILD_TIMEOUT,
  );
});
