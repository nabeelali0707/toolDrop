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

beforeEach(async () => {
  handle = openDatabase(':memory:');
  runMigrations(handle.db);
  engine = new Engine({ db: handle.db });
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
