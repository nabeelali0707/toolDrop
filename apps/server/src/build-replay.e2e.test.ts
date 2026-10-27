import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, type DatabaseHandle } from '@tooldrop/db';
import { Engine, type JobView } from '@tooldrop/engine';
import { startHtmlAppFixture } from '@tooldrop/fixture-html-app';
import { startJsonApiFixture } from '@tooldrop/fixture-json-api';
import type { RunningFixture } from '@tooldrop/fixture-kit';
import { FakeProvider } from '@tooldrop/llm';
import { Runtime } from '@tooldrop/runtime';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Replays model replies recorded from real models by build.llm.test.ts
// (TOOLDROP_RECORD_REPLIES=1 pnpm test:llm), so CI checks that toolDrop still
// builds the same tools from what real models said (DECISIONS.md, D-019).
// A reply file that is missing is skipped.

const replies = (name: string) =>
  fileURLToPath(new URL(`../../../fixtures/llm-replies/${name}.json`, import.meta.url));

let browser: Browser;
let jsonApi: RunningFixture;
let htmlApp: RunningFixture;

beforeAll(async () => {
  browser = await chromium.launch();
  jsonApi = await startJsonApiFixture();
  htmlApp = await startHtmlAppFixture();
});

afterAll(async () => {
  await browser.close();
  await jsonApi.close();
  await htmlApp.close();
});

async function replay(file: string, build: (engine: Engine) => string): Promise<JobView> {
  const handle: DatabaseHandle = openDatabase(':memory:');
  runMigrations(handle.db);
  const dataDir = mkdtempSync(join(tmpdir(), 'tooldrop-replay-'));
  const provider = FakeProvider.fromFile(file);
  const engine = new Engine({
    db: handle.db,
    dataDir,
    runtime: new Runtime({ browserWaitMs: 5_000 }),
    builds: {
      // The fake provider replays by purpose; model names do not matter to it.
      models: { provider, models: { code: 'qwen2.5-coder:7b', reasoning: 'llama3.1:8b' } },
      browser,
      compiler: { rateLimit: { per_second: 200, concurrency: 4, burst: 200 }, waitMs: 5_000 },
    },
  });
  try {
    const id = build(engine);
    for (;;) {
      const job = engine.getJob(id);
      if (job.status === 'succeeded' || job.status === 'failed') return job;
      const open = job.questions.find((question) => question.answer === undefined);
      if (job.status === 'waiting_for_answer' && open) {
        engine.answerQuestion(id, open.id, open.options?.[0] ?? 'every page, all rows');
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    await engine.builds.idle();
    await engine.close();
    handle.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
  }
}

describe('builds from recorded model replies', { timeout: 180_000 }, () => {
  it.runIf(existsSync(replies('json-api-explore')))('rebuilds the JSON API fixture tool', async () => {
    const job = await replay(
      replies('json-api-explore'),
      (engine) =>
        engine.startBuild({
          url: jsonApi.url,
          task: 'List my supplier invoices, filtered by status',
          authority: 'read',
        }).id,
    );
    expect(job.error).toBeNull();
    expect(job.result).toMatchObject({ strategy: 'http_replay' });
  });

  it.runIf(existsSync(replies('html-app-recording')))(
    'rebuilds the HTML fixture tool from its recording',
    async () => {
      const job = await replay(replies('html-app-recording'), (engine) => {
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
        return engine.startBuild({
          url: `${htmlApp.url}/invoices`,
          task: 'Search invoices by status',
          authority: 'read',
          recording_id: id,
        }).id;
      });
      expect(job.error).toBeNull();
      expect(job.result).toMatchObject({ strategy: 'html_fetch' });
    },
  );
});
