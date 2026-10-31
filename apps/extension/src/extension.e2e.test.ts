import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { memoryKeyStore } from '@tooldrop/auth';
import { createApiKey, openDatabase, runMigrations, type DatabaseHandle } from '@tooldrop/db';
import { Engine, type JobView } from '@tooldrop/engine';
import { startHtmlAppFixture } from '@tooldrop/fixture-html-app';
import type { RunningFixture } from '@tooldrop/fixture-kit';
import type { ChatReply, ChatRequest, LlmProvider } from '@tooldrop/llm';
import { Runtime } from '@tooldrop/runtime';
import { createServer } from '@tooldrop/server';
import { chromium, type Browser, type BrowserContext, type Worker } from 'playwright';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// SPEC's Recording criterion, through the Chrome extension: a session
// recorded on a fixture produces a working tool with zero model exploration
// calls. The extension is built and loaded unpacked, as a person loads it.
// The model is scripted, as in every CI test.

class ScriptedModel implements LlmProvider {
  readonly name = 'ollama' as const;
  readonly endpoint = 'http://127.0.0.1:11434';
  readonly systems: string[] = [];
  chat(request: ChatRequest): Promise<ChatReply> {
    const [system = '', prompt = ''] = request.messages.map((message) => message.content);
    this.systems.push(system);
    let reply: unknown = { questions: [] };
    if (system.startsWith('You write toolDrop recipes')) {
      reply = JSON.parse(prompt.split('\n').find((line) => line.startsWith('{"strategy"')) ?? '{}');
    } else if (system.startsWith('You name and describe tools')) {
      reply = {
        name: 'invoices_by_status',
        description: 'Supplier invoices with a given status, newest first.',
        inputs: [],
        fields: [],
      };
    }
    return Promise.resolve({
      content: JSON.stringify(reply),
      prompt_tokens: 500,
      completion_tokens: 50,
      duration_ms: 1,
      truncated: false,
    });
  }
}

const model = new ScriptedModel();
let extension: string;
let dataDir: string;
let handle: DatabaseHandle;
let fixture: RunningFixture;
let builder: Browser;
let engine: Engine;
let app: ReturnType<typeof createServer>;
let server: string;
let key: string;
let context: BrowserContext;
let worker: Worker;

beforeAll(async () => {
  extension = mkdtempSync(join(tmpdir(), 'tooldrop-extension-'));
  await build({
    configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
    build: { outDir: extension, emptyOutDir: true },
    logLevel: 'silent',
  });

  fixture = await startHtmlAppFixture();
  dataDir = mkdtempSync(join(tmpdir(), 'tooldrop-extension-data-'));
  handle = openDatabase(join(dataDir, 'tooldrop.db'));
  await runMigrations(handle.db);
  builder = await chromium.launch();
  engine = new Engine({
    db: handle.db,
    dataDir,
    runtime: new Runtime({ browserWaitMs: 5_000 }),
    keyStore: () => Promise.resolve(memoryKeyStore()),
    builds: {
      browser: builder,
      models: { provider: model, models: { code: 'qwen2.5-coder:7b', reasoning: 'llama3.1:8b' } },
      compiler: { rateLimit: { per_second: 200, concurrency: 4, burst: 200 }, waitMs: 5_000 },
    },
  });
  app = createServer({ engine });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  server = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  key = (await createApiKey(handle.db, { label: 'extension' })).key;

  // Extensions load in Chromium's new headless mode, which the "chromium" channel runs.
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
}, 120_000);

afterAll(async () => {
  await context.close();
  await engine.builds.idle();
  await app.close();
  await engine.close();
  await handle.close();
  await builder.close();
  await fixture.close();
  rmSync(extension, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
});

describe('the Chrome extension', () => {
  it('records a task on a fixture, uploads it, and builds a working tool without exploring', async () => {
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(`${fixture.url}/invoices`);
    const tabId = await worker.evaluate(
      async (url) => (await chrome.tabs.query({ url }))[0]?.id,
      `${fixture.url}/*`,
    );

    // The popup sends this message when the person clicks "Start recording".
    const control = await context.newPage();
    await control.goto(`chrome-extension://${extensionId}/popup.html`);
    expect(
      await control.evaluate((id) => chrome.runtime.sendMessage({ type: 'start', tabId: id }), tabId),
    ).toEqual({ ok: true });
    await page.bringToFront();

    // The task, done once: pick a status and search.
    await page.waitForSelector('#tooldrop-recorder');
    await page.selectOption('select[name=status]', 'paid');
    await page.click('[data-testid=search]');
    await page.waitForURL(/status=paid/);
    await page.waitForSelector('#tooldrop-recorder');

    // Finishing before marking the data is refused, with a hint in the bar.
    await page.locator('#tooldrop-recorder button.finish').click();
    await expect
      .poll(() => page.locator('#tooldrop-recorder .status').textContent())
      .toContain('Mark the data first');

    await page.locator('#tooldrop-recorder button.mark').click();
    await page.locator('table').click();
    const opened = context.waitForEvent('page');
    await page.locator('#tooldrop-recorder button.finish').click();
    const review = await opened;
    await review.waitForSelector('.input');
    expect(await review.textContent('#steps')).toContain('Pick "paid" in combobox "Status"');

    // The status becomes the tool's input; then upload and build.
    await review.locator('.input input[type=checkbox]').first().check();
    expect(await review.locator('.input input[type=text]').first().inputValue()).toBe('status');
    await review.fill('#task', 'List supplier invoices with a given status');
    await review.fill('#server', server);
    await review.fill('#key', key);
    await review.click('#upload');
    await expect
      .poll(() => review.textContent('#result'), { timeout: 15_000 })
      .toContain('Saved as recording');
    await review.click('#build');
    await expect.poll(() => review.textContent('#result'), { timeout: 15_000 }).toContain('Building, as job');
    const jobId = /as job (\S+)\./.exec((await review.textContent('#result')) ?? '')?.[1] ?? '';

    const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
    let job: JobView | undefined;
    for (let i = 0; i < 600 && (!job || job.status === 'queued' || job.status === 'running'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      job = ((await (await fetch(`${server}/v1/jobs/${jobId}`, { headers })).json()) as { job: JobView }).job;
    }
    expect(job?.error).toBeNull();
    expect(job?.result).toMatchObject({ tool: 'invoices_by_status' });
    expect(model.systems.some((system) => system.startsWith('You explore a website'))).toBe(false);

    const run = await fetch(`${server}/v1/tools/invoices_by_status/run`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ status: 'open' }),
    });
    const { result } = (await run.json()) as { result: { status: string }[] };
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((invoice) => invoice.status === 'open')).toBe(true);
  }, 180_000);
});
