import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApiKey, openDatabase, runMigrations, type DatabaseHandle } from '@tooldrop/db';
import { Engine, readToolFile } from '@tooldrop/engine';
import { startHtmlAppFixture } from '@tooldrop/fixture-html-app';
import type { RunningFixture } from '@tooldrop/fixture-kit';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from './app.ts';

let handle: DatabaseHandle;
let engine: Engine;
let fixture: RunningFixture;
let app: FastifyInstance;
let key: string;
let dataDir: string;

beforeEach(async () => {
  handle = openDatabase(':memory:');
  runMigrations(handle.db);
  dataDir = mkdtempSync(join(tmpdir(), 'tooldrop-server-'));
  engine = new Engine({ db: handle.db, dataDir });
  fixture = await startHtmlAppFixture();
  engine.publish(
    readToolFile(
      fileURLToPath(new URL('../../../fixtures/recipes/html-app.search_invoices.json', import.meta.url)),
    ),
    fixture.url,
  );
  app = createServer({ engine, version: '1.2.3' });
  key = createApiKey(handle.db, { label: 'test' }).key;
});

afterEach(async () => {
  await app.close();
  await engine.close();
  await fixture.close();
  handle.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const auth = () => ({ authorization: `Bearer ${key}` });

describe('REST API', () => {
  it('answers /health without a key', async () => {
    const response = await app.inject({ url: '/health' });
    expect(response.json()).toEqual({ ok: true, version: '1.2.3' });
  });

  it('needs a valid API key everywhere else', async () => {
    expect((await app.inject({ url: '/v1/tools' })).statusCode).toBe(401);
    const wrong = await app.inject({ url: '/v1/tools', headers: { authorization: 'Bearer td_wrong' } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ error: { code: 'unauthorized' } });
  });

  it('lists tools with their schemas', async () => {
    const response = await app.inject({ url: '/v1/tools', headers: auth() });
    expect(response.json()).toMatchObject({
      tools: [{ name: 'search_invoices', authority: 'read', site: fixture.url, version: 1 }],
    });
  });

  it('runs a tool and returns its result with meta', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/tools/search_invoices/run',
      headers: auth(),
      payload: { status: 'overdue' },
    });
    expect(response.statusCode).toBe(200);
    const { result, meta } = response.json<{ result: { status: string }[]; meta: { strategy: string } }>();
    expect(result.every((invoice) => invoice.status === 'overdue')).toBe(true);
    expect(meta.strategy).toBe('html_fetch');
  });

  it('maps errors to HTTP statuses with one error shape', async () => {
    const run = (name: string, payload: unknown, headers = auth()) =>
      app.inject({ method: 'POST', url: `/v1/tools/${name}/run`, headers, payload: payload as object });

    const invalid = await run('search_invoices', { status: 'lost' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: 'invalid_input' } });

    expect((await run('nope', {})).statusCode).toBe(404);

    const scoped = createApiKey(handle.db, { label: 'scoped', scopes: ['list_orders'] }).key;
    expect((await run('search_invoices', {}, { authorization: `Bearer ${scoped}` })).statusCode).toBe(403);
  });
});

describe('builds', () => {
  it('starts builds as jobs, reports them and checks answers', async () => {
    const started = await app.inject({
      method: 'POST',
      url: '/v1/builds',
      headers: auth(),
      payload: { url: fixture.url, task: 'search invoices', authority: 'read' },
    });
    expect(started.statusCode).toBe(202);
    const { job } = started.json<{ job: { id: string } }>();
    expect(job).toMatchObject({ status: 'succeeded', result: { tool: 'search_invoices', reused: true } });

    const fetched = await app.inject({ url: `/v1/jobs/${job.id}`, headers: auth() });
    expect(fetched.json()).toMatchObject({ job: { id: job.id, usage: { calls: 0 } } });

    const answer = (payload: object) =>
      app.inject({ method: 'POST', url: `/v1/jobs/${job.id}/answers`, headers: auth(), payload });
    expect((await answer({})).statusCode).toBe(400);
    const notWaiting = await answer({ question_id: '01JZZZZZZZZZZZZZZZZZZZZZZZ', answer: 'yes' });
    expect(notWaiting.json()).toMatchObject({
      error: { code: 'invalid_input', message: expect.stringContaining('not waiting') as string },
    });

    const missing = await app.inject({ url: '/v1/jobs/01JZZZZZZZZZZZZZZZZZZZZZZZ', headers: auth() });
    expect(missing.statusCode).toBe(404);
    const scoped = createApiKey(handle.db, { label: 'scoped', scopes: ['search_invoices'] }).key;
    const forbidden = await app.inject({
      url: `/v1/jobs/${job.id}`,
      headers: { authorization: `Bearer ${scoped}` },
    });
    expect(forbidden.statusCode).toBe(403);
  });
});

describe('recordings', () => {
  const recording = (url: string) => ({
    version: 1,
    recorder: 'cli',
    recorded_at: 1_790_000_000_000,
    actions: [
      { kind: 'goto', url: `${url}/invoices` },
      {
        kind: 'select',
        target: [{ kind: 'css', value: 'select[name="status"]' }],
        label: 'combobox "Status"',
        value: 'paid',
        options: [{ value: 'paid', label: 'Paid' }],
      },
    ],
    inputs: [{ name: 'status', action: 1, example: 'paid' }],
    target: { selector: [{ kind: 'test_id', value: 'invoices' }] },
    har: {
      log: {
        version: '1.2',
        creator: { name: 'recorder', version: '1' },
        entries: [
          {
            startedDateTime: '2026-10-26T10:00:00.000Z',
            time: 5,
            request: {
              method: 'GET',
              url: `${url}/invoices`,
              httpVersion: 'HTTP/1.1',
              headers: [{ name: 'Cookie', value: 'sid=session-value-0123456789' }],
              queryString: [],
              headersSize: -1,
              bodySize: 0,
            },
            response: {
              status: 200,
              statusText: 'OK',
              httpVersion: 'HTTP/1.1',
              headers: [],
              content: { size: 9, mimeType: 'text/html', text: 'sid=session-value-0123456789' },
              redirectURL: '',
              headersSize: -1,
              bodySize: 9,
            },
            cache: {},
            timings: { send: 0, wait: 5, receive: 0 },
          },
        ],
      },
    },
  });

  it('stores an uploaded recording, with its network log masked', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/recordings',
      headers: auth(),
      payload: recording(fixture.url),
    });
    expect(response.statusCode).toBe(201);
    const { id } = response.json<{ id: string }>();
    const stored = engine.getRecording(id);
    expect(stored.inputs).toEqual([{ name: 'status', action: 1, example: 'paid' }]);
    expect(JSON.stringify(stored.har)).not.toContain('session-value-0123456789');
  });

  it('rejects a recording that does not follow the format', async () => {
    const broken = { ...recording(fixture.url), inputs: [{ name: 'status', action: 0, example: 'x' }] };
    const response = await app.inject({
      method: 'POST',
      url: '/v1/recordings',
      headers: auth(),
      payload: broken,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'invalid_input' } });
  });

  it('needs a key with access to every tool', async () => {
    const scoped = createApiKey(handle.db, { label: 'scoped', scopes: ['search_invoices'] }).key;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/recordings',
      headers: { authorization: `Bearer ${scoped}` },
      payload: recording(fixture.url),
    });
    expect(response.statusCode).toBe(403);
    expect(() => engine.getRecording('01JZZZZZZZZZZZZZZZZZZZZZZZ')).toThrow(/no recording/);
    expect(() => engine.getRecording('../tooldrop')).toThrow(/no recording/);
  });
});

describe('MCP over Streamable HTTP', () => {
  it('works from a remote MCP client with an API key', async () => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const client = new Client({ name: 'remote-client', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: auth() },
      }),
    );
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('search_invoices');
    const response = await client.callTool({ name: 'search_invoices', arguments: { status: 'paid' } });
    expect(response.isError).toBeFalsy();
    await client.close();
  });

  it('refuses MCP requests without a key', async () => {
    const response = await app.inject({ method: 'POST', url: '/mcp', payload: {} });
    expect(response.statusCode).toBe(401);
  });
});
