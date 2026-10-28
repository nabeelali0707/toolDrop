import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryKeyStore } from '@tooldrop/auth';
import { createApiKey, openDatabase, runMigrations, type DatabaseHandle } from '@tooldrop/db';
import { Engine, type JobView } from '@tooldrop/engine';
import type { RunningFixture } from '@tooldrop/fixture-kit';
import { FIXTURE_ACCOUNT, startLoginTotpFixture } from '@tooldrop/fixture-login-totp';
import type { ChatReply, ChatRequest, LlmProvider } from '@tooldrop/llm';
import { Runtime } from '@tooldrop/runtime';
import type { FastifyInstance } from 'fastify';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from './app.ts';

// SPEC's Security criterion: no API, log, error or model prompt ever holds a
// plain-text credential. A whole signed-in flow runs with the login
// fixture's test account; then everything toolDrop sent or kept is searched
// for the account's values. toolDrop writes no request logs, so what it
// keeps is the database, the capture files and the jobs.

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

function refIn(prompt: string, element: string): string {
  const match = new RegExp(`\\[(e\\d+)\\] ${element}`).exec(prompt);
  if (!match?.[1]) throw new Error(`no ${element} in the prompt`);
  return match[1];
}

/** A local model that explores straight to the table and keeps the drafts it is given. */
class ScriptedModel implements LlmProvider {
  readonly name = 'ollama' as const;
  readonly endpoint = 'http://127.0.0.1:11434';
  readonly requests: ChatRequest[] = [];
  chat(request: ChatRequest): Promise<ChatReply> {
    this.requests.push(request);
    const [system = '', prompt = ''] = request.messages.map((message) => message.content);
    let reply: unknown = { questions: [] };
    if (system.startsWith('You explore a website')) {
      reply = { action: 'extract', ref: refIn(prompt, 'table'), reason: 'the invoices' };
    } else if (system.startsWith('You write toolDrop recipes')) {
      reply = JSON.parse(prompt.split('\n').find((line) => line.startsWith('{"strategy"')) ?? '{}');
    } else if (system.startsWith('You name and describe tools')) {
      reply = {
        name: 'my_invoices',
        description: 'The invoices on the signed-in invoice page.',
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

let browser: Browser;
let fixture: RunningFixture;
let handle: DatabaseHandle;
let engine: Engine;
let app: FastifyInstance;
let dataDir: string;
let key: string;
const model = new ScriptedModel();
const responses: string[] = [];

beforeAll(async () => {
  browser = await chromium.launch();
  fixture = await startLoginTotpFixture();
  dataDir = mkdtempSync(join(tmpdir(), 'tooldrop-security-'));
  handle = openDatabase(join(dataDir, 'tooldrop.db'));
  runMigrations(handle.db);
  engine = new Engine({
    db: handle.db,
    dataDir,
    runtime: new Runtime({ browserWaitMs: 5_000 }),
    keyStore: () => Promise.resolve(memoryKeyStore()),
    builds: {
      browser,
      models: { provider: model, models: { code: 'qwen2.5-coder:7b', reasoning: 'llama3.1:8b' } },
      compiler: { rateLimit: { per_second: 200, concurrency: 4, burst: 200 }, waitMs: 5_000 },
    },
  });
  app = createServer({ engine });
  key = createApiKey(handle.db, { label: 'test' }).key;
});

afterAll(async () => {
  await engine.builds.idle();
  await engine.heals.idle();
  await app.close();
  await engine.close();
  handle.close();
  await browser.close();
  await fixture.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
});

async function rest(method: 'GET' | 'POST', url: string, payload?: object) {
  const response = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${key}` },
    ...(payload && { payload }),
  });
  responses.push(response.body);
  return { status: response.statusCode, body: response.json<Record<string, unknown>>() };
}

/** Every file under a folder, as text that holds any readable bytes. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [readFileSync(path).toString('latin1')];
  });
}

describe('security', () => {
  it('never shows, sends or stores a credential in plain text', async () => {
    const saved = await rest('POST', '/v1/logins', {
      site: fixture.url,
      username: FIXTURE_ACCOUNT.username,
      password: FIXTURE_ACCOUNT.password,
      totp_secret: FIXTURE_ACCOUNT.totpSecret,
    });
    expect(saved.status).toBe(201);

    // Build by exploring the signed-in page: signing in with TOTP comes first.
    const { body } = await rest('POST', '/v1/builds', {
      url: `${fixture.url}/invoices`,
      task: 'List my invoices',
      authority: 'read',
    });
    let job = body.job as JobView;
    for (let i = 0; i < 900 && (job.status === 'queued' || job.status === 'running'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      job = (await rest('GET', `/v1/jobs/${job.id}`)).body.job as JobView;
    }
    expect(job.error).toBeNull();
    expect(job.result).toMatchObject({ tool: 'my_invoices', strategy: 'html_fetch' });

    expect((await rest('POST', '/v1/tools/my_invoices/run', {})).status).toBe(200);
    // Every session ends; the next call signs in again.
    await fetch(`${fixture.url}/__fixture/expire-sessions`, { method: 'POST' });
    expect((await rest('POST', '/v1/tools/my_invoices/run', {})).status).toBe(200);
    await rest('GET', '/v1/logins');

    const prompts = model.requests.map((request) =>
      request.messages.map((message) => message.content).join('\n'),
    );
    expect(prompts.length).toBeGreaterThanOrEqual(4);
    const database = ['tooldrop.db', 'tooldrop.db-wal']
      .map((file) => join(dataDir, file))
      .filter((path) => existsSync(path))
      .map((path) => readFileSync(path).toString('latin1'));
    const captures = existsSync(join(dataDir, 'captures')) ? filesUnder(join(dataDir, 'captures')) : [];
    expect(captures.length).toBeGreaterThan(0);

    const everywhere = { prompts, responses, database, captures };
    for (const [where, texts] of Object.entries(everywhere)) {
      for (const text of texts) {
        expect(text, where).not.toContain(FIXTURE_ACCOUNT.password);
        expect(text, where).not.toContain(FIXTURE_ACCOUNT.totpSecret);
        expect(text, where).not.toContain(FIXTURE_ACCOUNT.username);
      }
    }
    // The session cookie is a UUID: no prompt, response or capture file holds one.
    for (const text of [...prompts, ...responses, ...captures]) expect(text).not.toMatch(UUID);
  }, 180_000);
});
