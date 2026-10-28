import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryKeyStore } from '@tooldrop/auth';
import { createApiKey, openDatabase, runMigrations, type DatabaseHandle } from '@tooldrop/db';
import { DEMO_SHOP_ACCOUNT, startDemoShopFixture } from '@tooldrop/fixture-demo-shop';
import { Engine, type JobView } from '@tooldrop/engine';
import type { RunningFixture } from '@tooldrop/fixture-kit';
import type { ChatReply, ChatRequest, LlmProvider } from '@tooldrop/llm';
import { Runtime } from '@tooldrop/runtime';
import type { FastifyInstance } from 'fastify';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from './app.ts';

// The main use case, the Demo Shop order tracker (PLAN, R9), steps 1 to 4:
// save the login, ask for a tool that lists the orders, and get an answer
// from it in under 2 seconds. Watches (step 5) and the dashboard arrive with
// Phase 4. The model is scripted, as in every CI test.

function refIn(prompt: string, element: string): string {
  const match = new RegExp(`\\[(e\\d+)\\] ${element}`).exec(prompt);
  if (!match?.[1]) throw new Error(`no ${element} in the prompt`);
  return match[1];
}

class ScriptedModel implements LlmProvider {
  readonly name = 'ollama' as const;
  readonly endpoint = 'http://127.0.0.1:11434';
  chat(request: ChatRequest): Promise<ChatReply> {
    const [system = '', prompt = ''] = request.messages.map((message) => message.content);
    let reply: unknown = { questions: [] };
    if (system.startsWith('You explore a website')) {
      reply = { action: 'extract', ref: refIn(prompt, 'table'), reason: 'the orders are listed here' };
    } else if (system.startsWith('You write toolDrop recipes')) {
      // The draft without its data step, as qwen2.5-coder:7b answered on the development
      // machine: toolDrop puts the draft's step back instead of failing the build.
      const draft = JSON.parse(prompt.split('\n').find((line) => line.startsWith('{"strategy"')) ?? '{}') as {
        steps: unknown[];
      };
      reply = { ...draft, steps: draft.steps.slice(0, -1) };
    } else if (system.startsWith('You name and describe tools')) {
      reply = {
        name: 'list_orders',
        description: 'Every Demo Shop order with its status and delivery date, newest first.',
        inputs: [],
        fields: [{ name: 'status', description: 'processing, shipped, delivered or cancelled.' }],
      };
    }
    return Promise.resolve({
      content: JSON.stringify(reply),
      prompt_tokens: 800,
      completion_tokens: 80,
      duration_ms: 1,
      truncated: false,
    });
  }
}

let browser: Browser;
let shop: RunningFixture;
let handle: DatabaseHandle;
let engine: Engine;
let app: FastifyInstance;
let dataDir: string;
let key: string;

beforeAll(async () => {
  browser = await chromium.launch();
  shop = await startDemoShopFixture();
  dataDir = mkdtempSync(join(tmpdir(), 'tooldrop-demo-'));
  handle = openDatabase(':memory:');
  runMigrations(handle.db);
  engine = new Engine({
    db: handle.db,
    dataDir,
    runtime: new Runtime({ browserWaitMs: 5_000 }),
    keyStore: () => Promise.resolve(memoryKeyStore()),
    builds: {
      browser,
      models: {
        provider: new ScriptedModel(),
        models: { code: 'qwen2.5-coder:7b', reasoning: 'llama3.1:8b' },
      },
      compiler: { rateLimit: { per_second: 200, concurrency: 4, burst: 200 }, waitMs: 5_000 },
    },
  });
  app = createServer({ engine });
  key = createApiKey(handle.db, { label: 'agent' }).key;
});

afterAll(async () => {
  await engine.builds.idle();
  await engine.heals.idle();
  await app.close();
  await engine.close();
  handle.close();
  await browser.close();
  await shop.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
});

async function rest(method: 'GET' | 'POST', url: string, payload?: object) {
  const response = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${key}` },
    ...(payload && { payload }),
  });
  return { status: response.statusCode, body: response.json<Record<string, unknown>>() };
}

describe('the Demo Shop order tracker', () => {
  it('builds list_orders behind sign-in and 2FA, and answers which orders have not arrived', async () => {
    // Step 1: the user saves their login (here through REST; `tooldrop logins add` keeps it out of the chat).
    await rest('POST', '/v1/logins', {
      site: shop.url,
      username: DEMO_SHOP_ACCOUNT.username,
      password: DEMO_SHOP_ACCOUNT.password,
      totp_secret: DEMO_SHOP_ACCOUNT.totpSecret,
    });

    // Step 2: "Build a tool that lists my Demo Shop orders with status and delivery date. Read only."
    const started = await rest('POST', '/v1/builds', {
      url: `${shop.url}/account/orders`,
      task: 'List my Demo Shop orders with status and delivery date. Read only.',
      authority: 'read',
    });
    let job = started.body.job as JobView;
    // Step 3: toolDrop signs in with TOTP, captures, finds the internal JSON API, builds and validates.
    for (let i = 0; i < 1200 && (job.status === 'queued' || job.status === 'running'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      job = (await rest('GET', `/v1/jobs/${job.id}`)).body.job as JobView;
    }
    expect(job.error).toBeNull();
    expect(job.result).toMatchObject({ tool: 'list_orders', strategy: 'http_replay' });

    // The recipe trades the session for the shop's short-lived bearer token, like the page does.
    const recipe = engine.listTools().find((tool) => tool.name === 'list_orders')?.recipe;
    expect(recipe?.steps[0]).toMatchObject({
      op: 'http',
      url: '{{site}}/api/session/token',
      save: { token: '$.token' },
    });
    expect(recipe?.steps[1]).toMatchObject({
      op: 'http',
      url: '{{site}}/api/v1/orders',
      headers: { authorization: 'Bearer {{vars.token}}' },
      paginate: { until: '$.meta.hasNextPage == false' },
    });

    // Step 4: "Which of my orders haven't been delivered yet?" The agent calls list_orders.
    const started2 = Date.now();
    const call = await rest('POST', '/v1/tools/list_orders/run', {});
    expect(Date.now() - started2).toBeLessThan(2_000);
    const orders = call.body.result as { order: string; status: string }[];
    expect(orders).toHaveLength(14);
    const notDelivered = orders.filter(
      (order) => order.status !== 'delivered' && order.status !== 'cancelled',
    );
    expect(notDelivered.map((order) => order.order)).toEqual(['ORD-2014', 'ORD-2013', 'ORD-2012']);
  }, 180_000);
});
