import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createApiKey,
  listCaptures,
  listLlmCalls,
  openDatabase,
  runMigrations,
  type DatabaseHandle,
} from '@tooldrop/db';
import { Engine, type JobView } from '@tooldrop/engine';
import { startHtmlAppFixture } from '@tooldrop/fixture-html-app';
import { startJsonApiFixture, supplierContact } from '@tooldrop/fixture-json-api';
import type { RunningFixture } from '@tooldrop/fixture-kit';
import { createMcpServer } from '@tooldrop/mcp';
import {
  isLocalEndpoint,
  OpenAiCompatibleProvider,
  type ChatReply,
  type ChatRequest,
  type LlmProvider,
} from '@tooldrop/llm';
import { Runtime } from '@tooldrop/runtime';
import type { FastifyInstance } from 'fastify';
import { chromium, type Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from './app.ts';

// Phase 2's acceptance criteria (SPEC, Testing and acceptance criteria), end
// to end through the REST API. CI never calls a model (DECISIONS.md, D-019):
// a scripted model answers each prompt as a well-behaved local model would,
// reading the page list and the draft out of the prompt it is given.

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const fast = { per_second: 200, concurrency: 4, burst: 200 };

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

function refIn(prompt: string, element: string): string {
  const escaped = element.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`\\[(e\\d+)\\] ${escaped}`).exec(prompt);
  if (!match?.[1]) throw new Error(`no ${element} in the prompt`);
  return match[1];
}

/** What a reviewing model answers to each of toolDrop's prompts. */
function answer(system: string, prompt: string, broken: boolean): unknown {
  if (system.startsWith('You explore a website')) {
    if (!prompt.includes('Actions so far')) {
      return {
        action: 'select',
        ref: refIn(prompt, 'combobox "Status"'),
        value: 'Paid',
        input: 'status',
        reason: 'filter',
      };
    }
    if (!/^\d+\. click /m.test(prompt))
      return { action: 'click', ref: refIn(prompt, 'button "Search"'), reason: 'search' };
    return { action: 'extract', ref: refIn(prompt, 'table'), reason: 'the invoices' };
  }
  if (system.startsWith('You write toolDrop recipes')) {
    if (broken) return { strategy: 'http_replay' };
    return JSON.parse(prompt.split('\n').find((line) => line.startsWith('{"strategy"')) ?? '{}') as unknown;
  }
  if (system.startsWith('You name and describe tools')) {
    return {
      name: 'list_invoices',
      description: 'List supplier invoices, newest first, optionally only those with a given status.',
      inputs: [{ name: 'status', description: 'Only invoices with this status.', required: false }],
      fields: [{ name: 'number', description: 'The invoice number.' }],
    };
  }
  if (system.startsWith('You check whether')) return { questions: [] };
  return { fields: [] };
}

/** A local model that answers every prompt, for the build tests. */
class ScriptedModel implements LlmProvider {
  readonly name = 'ollama' as const;
  readonly endpoint = 'http://127.0.0.1:11434';
  readonly requests: ChatRequest[] = [];
  readonly broken: boolean;
  constructor(broken = false) {
    this.broken = broken;
  }
  chat(request: ChatRequest): Promise<ChatReply> {
    this.requests.push(request);
    const [system, prompt] = request.messages.map((message) => message.content);
    const content = JSON.stringify(answer(system ?? '', prompt ?? '', this.broken));
    return Promise.resolve({
      content,
      prompt_tokens: 1000,
      completion_tokens: 100,
      duration_ms: 5,
      truncated: false,
    });
  }
}

interface Setup {
  handle: DatabaseHandle;
  engine: Engine;
  app: FastifyInstance;
  key: string;
  dataDir: string;
}

let setup: Setup | undefined;

function start(provider: LlmProvider): Setup {
  const handle = openDatabase(':memory:');
  runMigrations(handle.db);
  const dataDir = mkdtempSync(join(tmpdir(), 'tooldrop-gate-'));
  const engine = new Engine({
    db: handle.db,
    dataDir,
    runtime: new Runtime({ browserWaitMs: 5_000 }),
    builds: {
      models: { provider, models: { code: 'qwen2.5-coder:7b', reasoning: 'llama3.1:8b' } },
      browser,
      compiler: { rateLimit: fast, waitMs: 5_000 },
    },
  });
  const app = createServer({ engine });
  setup = { handle, engine, app, key: createApiKey(handle.db, { label: 'test' }).key, dataDir };
  return setup;
}

afterEach(async () => {
  if (!setup) return;
  await setup.engine.builds.idle();
  await setup.app.close();
  await setup.engine.close();
  setup.handle.close();
  rmSync(setup.dataDir, { recursive: true, force: true, maxRetries: 3 });
  setup = undefined;
});

async function rest(s: Setup, method: 'GET' | 'POST', url: string, payload?: object) {
  const response = await s.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${s.key}` },
    ...(payload && { payload }),
  });
  return { status: response.statusCode, body: response.json<Record<string, unknown>>() };
}

async function finished(s: Setup, id: string): Promise<JobView> {
  for (let i = 0; i < 1200; i++) {
    const { body } = await rest(s, 'GET', `/v1/jobs/${id}`);
    const job = body.job as JobView;
    if (job.status === 'succeeded' || job.status === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`job ${id} did not finish`);
}

const htmlRecording = (url: string) => ({
  version: 1,
  recorder: 'cli',
  recorded_at: Date.now(),
  actions: [
    { kind: 'goto', url: `${url}/invoices` },
    {
      kind: 'select',
      target: [{ kind: 'css', value: 'select[name="status"]' }],
      label: 'combobox "Status"',
      value: 'overdue',
      options: ['', 'open', 'paid', 'overdue', 'draft'].map((value) => ({ value, label: value || 'All' })),
    },
    { kind: 'click', target: [{ kind: 'test_id', value: 'search' }], label: 'button "Search"' },
  ],
  inputs: [{ name: 'status', action: 1, example: 'overdue' }],
  target: { selector: [{ kind: 'test_id', value: 'invoices' }] },
});

describe('Phase 2 acceptance', { timeout: 180_000 }, () => {
  it('Build (JSON API fixture): a task description becomes an http_replay tool that answers in under a second', async () => {
    const s = start(new ScriptedModel());
    const started = Date.now();
    const { status, body } = await rest(s, 'POST', '/v1/builds', {
      url: jsonApi.url,
      task: 'List my supplier invoices, filtered by status',
      authority: 'read',
    });
    expect(status).toBe(202);
    const job = await finished(s, (body.job as JobView).id);
    expect(job.error).toBeNull();
    expect(job.result).toMatchObject({ tool: 'list_invoices', strategy: 'http_replay' });
    expect(Date.now() - started).toBeLessThan(180_000);

    const call = await rest(s, 'POST', '/v1/tools/list_invoices/run', { status: 'overdue' });
    expect(call.status).toBe(200);
    const meta = call.body.meta as { strategy: string; duration_ms: number };
    expect(meta.strategy).toBe('http_replay');
    expect(meta.duration_ms).toBeLessThan(1_000);
    expect((call.body.result as { status: string }[]).every((row) => row.status === 'overdue')).toBe(true);

    // The new tool is an MCP tool too.
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer(s.engine).connect(serverSide);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientSide);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('list_invoices');
    await client.close();
  });

  it('Build (HTML fixture) and Recording: an uploaded recording becomes an html_fetch tool, with no exploring', async () => {
    const s = start(new ScriptedModel());
    const uploaded = await rest(s, 'POST', '/v1/recordings', htmlRecording(htmlApp.url));
    expect(uploaded.status).toBe(201);
    const { body } = await rest(s, 'POST', '/v1/builds', {
      url: `${htmlApp.url}/invoices`,
      task: 'Search invoices by status',
      authority: 'read',
      recording_id: uploaded.body.id,
    });
    const job = await finished(s, (body.job as JobView).id);
    expect(job.result).toMatchObject({ tool: 'list_invoices', strategy: 'html_fetch' });
    const purposes = listLlmCalls(s.handle.db, job.id).map((call) => call.purpose);
    expect(purposes).not.toContain('explore');
    expect(purposes).toEqual(['clarify', 'write_recipe', 'describe_tool']);

    // Output matches the schema on three input sets: the runtime checks it on every call.
    for (const input of [{ status: 'overdue' }, { status: 'open' }, {}]) {
      const call = await rest(s, 'POST', '/v1/tools/list_invoices/run', input);
      expect(call.status).toBe(200);
      expect((call.body.result as unknown[]).length).toBeGreaterThan(0);
    }
  });

  it('LLM output: a reply that keeps failing its schema fails the job after four tries, with the error', async () => {
    const s = start(new ScriptedModel(true));
    const uploaded = await rest(s, 'POST', '/v1/recordings', htmlRecording(htmlApp.url));
    const { body } = await rest(s, 'POST', '/v1/builds', {
      url: `${htmlApp.url}/invoices`,
      task: 'Search invoices by status',
      authority: 'read',
      recording_id: uploaded.body.id,
    });
    const job = await finished(s, (body.job as JobView).id);
    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({ code: 'llm_invalid_output' });
    expect(job.error?.message).toMatch(
      /write_recipe reply did not match its schema after 4 tries: steps: Invalid input/,
    );
    const attempts = listLlmCalls(s.handle.db, job.id).filter((call) => call.purpose === 'write_recipe');
    expect(attempts.map((call) => [call.attempt, call.ok])).toEqual([
      [1, false],
      [2, false],
      [3, false],
      [4, false],
    ]);
  });

  it('Privacy: by default only the fixture and the local model are contacted', async () => {
    const s = start(new ScriptedModel());
    expect(isLocalEndpoint('http://127.0.0.1:11434')).toBe(true);
    const { body } = await rest(s, 'POST', '/v1/builds', {
      url: jsonApi.url,
      task: 'List invoices by status',
      authority: 'read',
    });
    const job = await finished(s, (body.job as JobView).id);
    expect(job.status).toBe('succeeded');
    const [capture] = listCaptures(s.handle.db, job.id);
    const har = JSON.parse(readFileSync(join(s.dataDir, capture?.har_path ?? ''), 'utf8')) as {
      log: { entries: { request: { url: string } }[] };
    };
    expect(har.log.entries.length).toBeGreaterThan(0);
    expect(har.log.entries.every((entry) => entry.request.url.startsWith(jsonApi.url))).toBe(true);
  });

  it('Privacy: nothing sent to an external API contains fixture emails, phone numbers, tokens or cookies', async () => {
    const sent: string[] = [];
    const external = new OpenAiCompatibleProvider('https://llm.example.test/v1', {
      fetch: (_url, init) => {
        const body = typeof init?.body === 'string' ? init.body : '';
        sent.push(body);
        const { messages } = JSON.parse(body) as { messages: { content: string }[] };
        const content = JSON.stringify(answer(messages[0]?.content ?? '', messages[1]?.content ?? '', false));
        return Promise.resolve(
          Response.json({
            choices: [{ message: { content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1000, completion_tokens: 100 },
          }),
        );
      },
    });
    const s = start(external);
    const { body } = await rest(s, 'POST', '/v1/builds', {
      url: jsonApi.url,
      task: 'List invoices by status',
      authority: 'read',
    });
    const job = await finished(s, (body.job as JobView).id);
    expect(job.error).toBeNull();

    const everything = sent.join('\n');
    expect(sent.length).toBeGreaterThanOrEqual(5);
    // The supplier contacts were in the API's response; they reached the prompts only as placeholders.
    expect(everything).toContain('[email]');
    for (const supplier of [
      'Acme Paper',
      'Brightline Logistics',
      'Cedar Office Supply',
      'Delta Cleaning',
      'Evergreen IT',
    ]) {
      const { email, phone } = supplierContact(supplier);
      expect(everything).not.toContain(email);
      expect(everything).not.toContain(phone);
    }
    // The CSRF token and the session cookie are UUIDs; none was ever sent.
    expect(everything).not.toMatch(UUID);
  });
});
