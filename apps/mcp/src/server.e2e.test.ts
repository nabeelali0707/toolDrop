import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  LoggingMessageNotificationSchema,
  ToolListChangedNotificationSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { memoryKeyStore } from '@tooldrop/auth';
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
let now: number;
let dataDir: string;

beforeEach(async () => {
  handle = openDatabase(':memory:');
  await runMigrations(handle.db);
  now = Date.parse('2026-10-28T12:00:00Z');
  dataDir = mkdtempSync(join(tmpdir(), 'tooldrop-mcp-'));
  engine = new Engine({
    db: handle.db,
    dataDir,
    keyStore: () => Promise.resolve(memoryKeyStore()),
    watches: { now: () => now, delivery: { backoffMs: [] } },
  });
  fixture = await startHtmlAppFixture();
  await engine.publish(searchInvoices, fixture.url);
});

afterEach(async () => {
  await engine.close();
  await fixture.close();
  await handle.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
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
      'approve_action',
      'create_watch',
      'list_watches',
      'delete_watch',
      'build_tool',
      'discover_tools',
      'get_job',
      'answer_question',
      'add_login',
      'list_logins',
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

  it('lists a workflow as a tool, whose call starts a run', async () => {
    await engine.saveWorkflow({
      name: 'first_paid_invoice',
      description: 'The number of the newest paid invoice.',
      input_schema: { type: 'object', properties: {} },
      steps: [{ id: 'paid', tool: 'search_invoices', inputs: { status: 'paid' } }],
      output: '{{steps.paid.result.0.number}}',
    });
    const { client, call } = await connect();
    const listed = (await client.listTools()).tools.find((tool) => tool.name === 'first_paid_invoice');
    expect(listed?.description).toContain('starts a run and returns its job');
    expect(listed?.annotations).toMatchObject({ readOnlyHint: true });
    const started = (await call('first_paid_invoice')).structuredContent as {
      job: { id: string; kind: string };
    };
    expect(started.job.kind).toBe('workflow');
    await engine.workflows.idle();
    expect((await engine.getJob(started.job.id)).result).toMatchObject({
      output: expect.stringMatching(/^INV-/) as string,
    });
  });

  it('tells clients when the tool list changes', async () => {
    const { client } = await connect();
    const changed = new Promise<void>((resolve) => {
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => resolve());
    });
    await engine.publish({ ...searchInvoices, name: 'search_invoices_copy' }, fixture.url);
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

  it('saves logins and lists them masked', async () => {
    const { call } = await connect();
    const password = 'fixture-password-not-real';
    const saved = await call('add_login', { site: fixture.url, username: 'fixture-user', password });
    expect(saved.structuredContent).toMatchObject({ login: { username: 'fi••••er', twofa: null } });
    const listed = await call('list_logins', {});
    expect(listed.structuredContent).toMatchObject({ logins: [{ username: 'fi••••er' }] });
    expect(JSON.stringify([saved, listed])).not.toContain(password);
  });

  it('watches a tool, and sends its changes as log notifications', async () => {
    const { client, call } = await connect();
    const events: unknown[] = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, ({ params }) => {
      if (params.logger === 'tooldrop.watches') events.push(params.data);
    });
    const created = await call('create_watch', {
      tool: 'search_invoices',
      interval_s: 300,
      key_field: 'number',
      webhook_url: 'http://127.0.0.1:9/hooks',
    });
    const { watch } = created.structuredContent as { watch: { id: string } };
    expect((await call('list_watches')).structuredContent).toMatchObject({ watches: [{ id: watch.id }] });

    await fetch(`${fixture.url}/__fixture/invoices`, { method: 'POST' });
    now += 300_000;
    await engine.watches.tick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'created', key: 'INV-1058', watch_id: watch.id }),
    );

    expect((await call('delete_watch', { watch_id: watch.id })).structuredContent).toEqual({
      deleted: watch.id,
    });
    expect((await call('list_watches')).structuredContent).toEqual({ watches: [] });
  });

  it('shows a write as a preview with a screenshot, and makes it once approved', async () => {
    await engine.publish(
      readToolFile(
        fileURLToPath(new URL('../../../fixtures/recipes/html-app.record_payment.json', import.meta.url)),
      ),
      fixture.url,
    );
    const { client, call } = await connect();
    const listed = (await client.listTools()).tools.find((tool) => tool.name === 'record_payment');
    expect(listed?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(listed?.inputSchema.properties).toHaveProperty('dry_run');

    const asked = await call('record_payment', { invoice: 'INV-1057', amount: 100 });
    expect(asked.isError).toBe(true);
    const text = asked.content.find((item) => item.type === 'text');
    const { error } = JSON.parse(text?.type === 'text' ? text.text : '{}') as {
      error: { code: string; details: { approval_id: string } };
    };
    expect(error.code).toBe('approval_required');
    expect(asked.content.find((item) => item.type === 'image')).toMatchObject({ mimeType: 'image/png' });

    const approved = await call('approve_action', {
      approval_id: error.details.approval_id,
      decision: 'approve',
    });
    expect(approved.structuredContent).toMatchObject({
      approval: { status: 'approved', decided_by: 'mcp' },
      result: 'Payment PAY-0001 recorded: INV-1057 is paid, 100.00 USD.',
    });
  }, 60_000);

  it("shows only the tools an API key's scopes allow", async () => {
    const { client, call } = await connect({ scopes: ['list_orders'] });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'find_tool',
      'run_tool',
      'approve_action',
      'create_watch',
      'list_watches',
      'delete_watch',
    ]);
    const response = await call('search_invoices', {});
    expect(JSON.parse((response.content[0] as { text: string }).text)).toMatchObject({
      error: { code: 'forbidden' },
    });
  });
});
