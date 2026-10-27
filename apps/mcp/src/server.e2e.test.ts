import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { openDatabase, runMigrations, type DatabaseHandle } from '@tooldrop/db';
import { Engine, readToolFile } from '@tooldrop/engine';
import { startHtmlAppFixture } from '@tooldrop/fixture-html-app';
import type { RunningFixture } from '@tooldrop/fixture-kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMcpServer, type McpOptions } from './server.ts';

const searchInvoices = readToolFile(
  fileURLToPath(new URL('../../../fixtures/recipes/html-app.search_invoices.json', import.meta.url)),
);

let handle: DatabaseHandle;
let engine: Engine;
let fixture: RunningFixture;

beforeEach(async () => {
  handle = openDatabase(':memory:');
  runMigrations(handle.db);
  engine = new Engine({ db: handle.db });
  fixture = await startHtmlAppFixture();
  engine.publish(searchInvoices, fixture.url);
});

afterEach(async () => {
  await engine.close();
  await fixture.close();
  handle.close();
});

/** An MCP client connected to toolDrop's server, as Claude Desktop would be. */
async function connect(options: McpOptions = {}) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(engine, options).connect(serverSide);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { client, call };
}

describe('MCP server', () => {
  it('lists the management tools and one tool per published recipe', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'find_tool',
      'run_tool',
      'build_tool',
      'get_job',
      'answer_question',
      'search_invoices',
    ]);

    const tool = tools.find((candidate) => candidate.name === 'search_invoices');
    expect(tool?.inputSchema.properties).toHaveProperty('status');
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true });
  });

  it('runs a published tool as its own MCP tool, with structured results', async () => {
    const { call } = await connect();
    const response = await call('search_invoices', { status: 'paid' });
    expect(response.isError).toBeFalsy();
    const { result, meta } = response.structuredContent as { result: { status: string }[]; meta: unknown };
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((invoice) => invoice.status === 'paid')).toBe(true);
    expect(meta).toMatchObject({ strategy: 'html_fetch', recipe_version: 1, healed: false });
  });

  it('finds tools and runs them by name', async () => {
    const { call } = await connect();
    const found = (await call('find_tool', { task: 'search invoices' })).structuredContent as {
      tools: { name: string }[];
    };
    expect(found.tools.map((tool) => tool.name)).toEqual(['search_invoices']);

    const ran = await call('run_tool', { name: 'search_invoices', input: { status: 'draft' } });
    expect((ran.structuredContent as { meta: { strategy: string } }).meta.strategy).toBe('html_fetch');
  });

  it('returns errors as tool errors the agent can read', async () => {
    const { call } = await connect();
    const response = await call('search_invoices', { status: 'lost' });
    expect(response.isError).toBe(true);
    expect(JSON.parse((response.content[0] as { text: string }).text)).toMatchObject({
      error: { code: 'invalid_input' },
    });
  });

  it('tells clients when the tool list changes', async () => {
    const { client } = await connect();
    const changed = new Promise<void>((resolve) => {
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => resolve());
    });
    engine.publish({ ...searchInvoices, name: 'search_invoices_copy' }, fixture.url);
    await changed;
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('search_invoices_copy');
  });

  it('starts builds and reports their jobs', async () => {
    const { call } = await connect();
    // A task a published tool already does finishes at once.
    const reused = (
      await call('build_tool', { url: fixture.url, task: 'search invoices', authority: 'read' })
    ).structuredContent as { job: { status: string; result: unknown } };
    expect(reused.job).toMatchObject({
      status: 'succeeded',
      result: { tool: 'search_invoices', reused: true },
    });

    // Without a model the build fails, and get_job says why.
    const started = (
      await call('build_tool', { url: fixture.url, task: 'list suppliers', authority: 'read' })
    ).structuredContent as { job: { id: string } };
    let job: { status: string; error: unknown } = { status: 'queued', error: null };
    for (let i = 0; i < 100 && job.status !== 'failed'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      job = ((await call('get_job', { job_id: started.job.id })).structuredContent as { job: typeof job })
        .job;
    }
    expect(job).toMatchObject({ status: 'failed', error: { code: 'llm_unavailable' } });

    const answer = await call('answer_question', {
      job_id: started.job.id,
      question_id: 'nope',
      answer: 'yes',
    });
    expect(answer.isError).toBe(true);
    expect((await call('build_tool', { url: 'not a url', task: 'x', authority: 'read' })).isError).toBe(true);
  });

  it("shows only the tools an API key's scopes allow", async () => {
    const { client, call } = await connect({ scopes: ['list_orders'] });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['find_tool', 'run_tool']);
    const response = await call('search_invoices', {});
    expect(JSON.parse((response.content[0] as { text: string }).text)).toMatchObject({
      error: { code: 'forbidden' },
    });
  });
});
