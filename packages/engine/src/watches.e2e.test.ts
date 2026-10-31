import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { memoryKeyStore } from '@tooldrop/auth';
import type { WatchEvent } from '@tooldrop/core';
import { openDatabase, runMigrations, type DatabaseHandle } from '@tooldrop/db';
import { startJsonApiFixture } from '@tooldrop/fixture-json-api';
import type { RunningFixture } from '@tooldrop/fixture-kit';
import { verifyWebhook } from '@tooldrop/watches';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from './engine.ts';
import { readToolFile } from './tool-files.ts';

// SPEC's Watches criterion: adding a row to a fixture emits exactly one
// signed `created` webhook within one interval. The clock moves forward
// instead of waiting 5 minutes.

const listInvoices = readToolFile(
  fileURLToPath(new URL('../../../fixtures/recipes/json-api.list_invoices.json', import.meta.url)),
);
const FIVE_MINUTES = 300_000;

/** A webhook receiver that answers with `answer`. */
let receiver: Server;
let hooks: string;
let answer = 204;
const received: { headers: IncomingHttpHeaders; body: string }[] = [];

let dir: string;
let handle: DatabaseHandle;
let fixture: RunningFixture;
let now: number;
const engines: Engine[] = [];

function start(): Engine {
  const engine = new Engine({
    db: handle.db,
    keyStore: () => Promise.resolve(memoryKeyStore()),
    watches: { now: () => now, delivery: { backoffMs: [0, 0] } },
  });
  engines.push(engine);
  return engine;
}

beforeAll(async () => {
  receiver = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      received.push({ headers: request.headers, body });
      response.statusCode = answer;
      response.end();
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const address = receiver.address();
  hooks = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/hooks/invoices`;
});
afterAll(() => new Promise((resolve) => receiver.close(resolve)));

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tooldrop-watches-'));
  handle = openDatabase(join(dir, 'tooldrop.db'));
  await runMigrations(handle.db);
  fixture = await startJsonApiFixture();
  now = Date.parse('2026-10-28T12:00:00Z');
  answer = 204;
  received.length = 0;
});
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  await fixture.close();
  await handle.close();
  rmSync(dir, { recursive: true, force: true });
});

const newInvoice = () => fetch(`${fixture.url}/__fixture/invoices`, { method: 'POST' });
const watchInvoices = { tool: 'list_invoices', interval_s: 300, key_field: 'number', webhook_url: '' };

describe('watches', () => {
  it('sends exactly one signed created webhook for a new row, within one interval', async () => {
    const engine = start();
    await engine.publish(listInvoices, fixture.url);
    const events: WatchEvent[] = [];
    engine.watches.onEvent((event) => events.push(event));
    const { watch, secret } = await engine.createWatch({ ...watchInvoices, webhook_url: hooks });
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(await engine.listWatches()).toEqual([watch]);
    expect(JSON.stringify(await engine.listWatches())).not.toContain(secret);

    // Nothing is due yet, and the first run was only the baseline.
    await engine.watches.tick();
    expect(received).toHaveLength(0);

    expect((await newInvoice()).status).toBe(201);
    now += FIVE_MINUTES;
    await engine.watches.tick();
    expect(received).toHaveLength(1);
    const [hook] = received;
    const event = JSON.parse(hook?.body ?? '{}') as WatchEvent;
    expect(event).toMatchObject({
      watch_id: watch.id,
      tool: 'list_invoices',
      type: 'created',
      key: 'INV-1058',
      row: { number: 'INV-1058', supplier: 'Acme Paper', status: 'open' },
    });
    const timestamp = String(hook?.headers['x-tooldrop-timestamp']);
    const signature = String(hook?.headers['x-tooldrop-signature']);
    expect(verifyWebhook(secret, timestamp, hook?.body ?? '', signature)).toBe(true);
    expect(events).toEqual([event]);

    // No change, no webhook.
    now += FIVE_MINUTES;
    await engine.watches.tick();
    expect(received).toHaveLength(1);
    expect((await engine.listWatches())[0]).toMatchObject({ last_error: null });
  }, 60_000);

  it('sends a change again on the next run when its webhook failed', async () => {
    const engine = start();
    await engine.publish(listInvoices, fixture.url);
    await engine.createWatch({ ...watchInvoices, webhook_url: hooks });
    await newInvoice();

    answer = 503;
    now += FIVE_MINUTES;
    await engine.watches.tick();
    expect(received).toHaveLength(3);
    expect((await engine.listWatches())[0]).toMatchObject({ last_error: 'the webhook answered 503' });

    answer = 204;
    received.length = 0;
    now += FIVE_MINUTES;
    await engine.watches.tick();
    expect(received.map((hook) => (JSON.parse(hook.body) as WatchEvent).key)).toEqual(['INV-1058']);
    expect((await engine.listWatches())[0]).toMatchObject({ last_error: null });
  }, 60_000);

  it('runs a due watch in one process only, when several share the database', async () => {
    const [first, second] = [start(), start()];
    await first.publish(listInvoices, fixture.url);
    await first.createWatch({ ...watchInvoices, webhook_url: hooks });
    await newInvoice();
    now += FIVE_MINUTES;
    await Promise.all([first.watches.tick(), second.watches.tick()]);
    expect(received).toHaveLength(1);
  }, 60_000);

  it('refuses a watch that could not work, and says why', async () => {
    const engine = start();
    await engine.publish(listInvoices, fixture.url);
    await expect(
      engine.createWatch({ ...watchInvoices, key_field: 'status', webhook_url: hooks }),
    ).rejects.toThrow('"status" is not unique');
    await expect(
      engine.createWatch({ ...watchInvoices, interval_s: 60, webhook_url: hooks }),
    ).rejects.toThrow(/invalid watch: interval_s/);
    await expect(
      engine.createWatch({ ...watchInvoices, webhook_url: 'ftp://example.test/hook' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      engine.createWatch({ ...watchInvoices, webhook_url: hooks }, ['other_tool']),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(await engine.listWatches()).toEqual([]);
  }, 60_000);

  it('deletes a watch', async () => {
    const engine = start();
    await engine.publish(listInvoices, fixture.url);
    const { watch } = await engine.createWatch({ ...watchInvoices, webhook_url: hooks });
    await expect(engine.deleteWatch(watch.id, ['other_tool'])).rejects.toThrow(`no watch ${watch.id}`);
    await engine.deleteWatch(watch.id);
    expect(await engine.listWatches()).toEqual([]);
  }, 60_000);
});
