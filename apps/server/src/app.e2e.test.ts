import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { memoryKeyStore } from '@tooldrop/auth';
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
  await runMigrations(handle.db);
  dataDir = mkdtempSync(join(tmpdir(), 'tooldrop-server-'));
  engine = new Engine({ db: handle.db, dataDir, keyStore: () => Promise.resolve(memoryKeyStore()) });
  fixture = await startHtmlAppFixture();
  await engine.publish(
    readToolFile(
      fileURLToPath(new URL('../../../fixtures/recipes/html-app.search_invoices.json', import.meta.url)),
    ),
    fixture.url,
  );
  app = createServer({ engine, version: '1.2.3' });
  key = (await createApiKey(handle.db, { label: 'test' })).key;
});

afterEach(async () => {
  await app.close();
  await engine.close();
  await fixture.close();
  await handle.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const auth = () => ({ authorization: `Bearer ${key}` });

describe('REST API', () => {
  it('answers /health without a key', async () => {
    const response = await app.inject({ url: '/health' });
    expect(response.json()).toEqual({ ok: true, version: '1.2.3' });
  });

  it('needs a valid API key for the API, but not for the pages', async () => {
    expect((await app.inject({ url: '/v1/tools' })).statusCode).toBe(401);
    const wrong = await app.inject({ url: '/v1/tools', headers: { authorization: 'Bearer td_wrong' } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ error: { code: 'unauthorized' } });
    // Without a built dashboard, the root says where the API is.
    const root = await app.inject({ url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('the REST API is at /v1');
    const unknown = await app.inject({ url: '/v1/nothing-here', headers: auth() });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: { code: 'not_found' } });
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

    const scoped = (await createApiKey(handle.db, { label: 'scoped', scopes: ['list_orders'] })).key;
    expect((await run('search_invoices', {}, { authorization: `Bearer ${scoped}` })).statusCode).toBe(403);
  });
});

describe('versions', () => {
  it("lists a tool's versions and rolls back", async () => {
    const versions = await app.inject({ url: '/v1/tools/search_invoices/versions', headers: auth() });
    expect(versions.json()).toMatchObject({ versions: [{ version: 1, current: true, created_by: 'user' }] });

    const rollback = (payload: object) =>
      app.inject({ method: 'POST', url: '/v1/tools/search_invoices/rollback', headers: auth(), payload });
    expect((await rollback({ version: 1 })).json()).toMatchObject({
      tool: { name: 'search_invoices', version: 1 },
    });
    expect((await rollback({})).statusCode).toBe(400);
    expect((await rollback({ version: 7 })).statusCode).toBe(404);
  });
});

describe('safe mode', () => {
  beforeEach(async () => {
    await engine.publish(
      readToolFile(
        fileURLToPath(new URL('../../../fixtures/recipes/html-app.record_payment.json', import.meta.url)),
      ),
      fixture.url,
    );
  });

  it('answers a write with 409 and a preview, and records who rejected it', async () => {
    const called = await app.inject({
      method: 'POST',
      url: '/v1/tools/record_payment/run',
      headers: auth(),
      payload: { invoice: 'INV-1057', amount: 100 },
    });
    expect(called.statusCode).toBe(409);
    const { error } = called.json<{ error: { code: string; details: { approval_id: string } } }>();
    expect(error.code).toBe('approval_required');
    const id = error.details.approval_id;

    const pending = await app.inject({ url: '/v1/approvals?status=pending', headers: auth() });
    expect(pending.json()).toMatchObject({ approvals: [{ id, tool: 'record_payment', status: 'pending' }] });
    const screenshot = await app.inject({ url: `/v1/approvals/${id}/screenshot`, headers: auth() });
    expect(screenshot.headers['content-type']).toBe('image/png');

    const decide = (decision: string) =>
      app.inject({ method: 'POST', url: `/v1/approvals/${id}`, headers: auth(), payload: { decision } });
    expect((await decide('maybe')).statusCode).toBe(400);
    expect((await decide('reject')).json()).toMatchObject({
      approval: { status: 'rejected', decided_by: 'api-key:test' },
    });
    expect((await decide('approve')).statusCode).toBe(409);
    const payments = (await fetch(`${fixture.url}/__fixture/payments`).then((r) => r.json())) as unknown[];
    expect(payments).toEqual([]);
  }, 60_000);

  it('manages policies with a full-access key only', async () => {
    const policy = { tool: 'record_payment', field: 'amount', op: '<', value: 100 };
    const created = await app.inject({
      method: 'POST',
      url: '/v1/policies',
      headers: auth(),
      payload: policy,
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json<{ policy: { id: string } }>().policy;
    expect((await app.inject({ url: '/v1/policies', headers: auth() })).json()).toMatchObject({
      policies: [{ id, ...policy }],
    });

    const scoped = (await createApiKey(handle.db, { label: 'scoped', scopes: ['record_payment'] })).key;
    const refused = await app.inject({
      method: 'POST',
      url: '/v1/policies',
      headers: { authorization: `Bearer ${scoped}` },
      payload: policy,
    });
    expect(refused.statusCode).toBe(403);
    expect(
      (await app.inject({ method: 'DELETE', url: `/v1/policies/${id}`, headers: auth() })).statusCode,
    ).toBe(204);
  });
});

describe('watches', () => {
  it('creates a watch, shows its secret once, lists and deletes it', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/watches',
      headers: auth(),
      payload: {
        tool: 'search_invoices',
        interval_s: 300,
        key_field: 'number',
        webhook_url: 'http://127.0.0.1:9/hooks',
      },
    });
    expect(created.statusCode).toBe(201);
    const { watch, secret } = created.json<{ watch: { id: string }; secret: string }>();
    expect(watch).toMatchObject({ tool: 'search_invoices', key_field: 'number', last_error: null });

    const listed = await app.inject({ url: '/v1/watches', headers: auth() });
    expect(listed.json()).toEqual({ watches: [watch] });
    expect(listed.body).not.toContain(secret);

    const remove = () => app.inject({ method: 'DELETE', url: `/v1/watches/${watch.id}`, headers: auth() });
    expect((await remove()).statusCode).toBe(204);
    expect((await remove()).statusCode).toBe(404);
    const tooOften = await app.inject({
      method: 'POST',
      url: '/v1/watches',
      headers: auth(),
      payload: {
        tool: 'search_invoices',
        interval_s: 60,
        key_field: 'number',
        webhook_url: 'http://127.0.0.1:9/',
      },
    });
    expect(tooOften.statusCode).toBe(400);
  });
});

describe('logins', () => {
  const password = 'fixture-password-not-real';

  it('saves a login and lists it masked, never returning a value', async () => {
    const saved = await app.inject({
      method: 'POST',
      url: '/v1/logins',
      headers: auth(),
      payload: { site: fixture.url, username: 'fixture-user', password, label: 'test account' },
    });
    expect(saved.statusCode).toBe(201);
    expect(saved.json()).toMatchObject({
      login: { label: 'test account', username: 'fi••••er', status: 'unchecked' },
    });

    const listed = await app.inject({
      url: `/v1/logins?site=${encodeURIComponent(fixture.url)}`,
      headers: auth(),
    });
    expect(listed.json<{ logins: unknown[] }>().logins).toHaveLength(1);
    for (const body of [saved.body, listed.body]) expect(body).not.toContain(password);

    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/logins',
      headers: auth(),
      payload: { site: 'x', password },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).not.toContain(password);

    const scoped = (await createApiKey(handle.db, { label: 'scoped', scopes: ['search_invoices'] })).key;
    const forbidden = await app.inject({ url: '/v1/logins', headers: { authorization: `Bearer ${scoped}` } });
    expect(forbidden.statusCode).toBe(403);
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
    const scoped = (await createApiKey(handle.db, { label: 'scoped', scopes: ['search_invoices'] })).key;
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
    const scoped = (await createApiKey(handle.db, { label: 'scoped', scopes: ['search_invoices'] })).key;
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
