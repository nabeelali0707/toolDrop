import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { WatchEvent } from '@tooldrop/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deliver, signWebhook, verifyWebhook } from './deliver.ts';

const secret = 'test-secret-not-real';
const event: WatchEvent = {
  id: '01JTESTEVENT',
  watch_id: '01JTESTWATCH',
  tool: 'list_invoices',
  type: 'created',
  key: 'INV-1058',
  row: { number: 'INV-1058' },
  detected_at: '2026-10-28T12:00:00.000Z',
};

/** A receiver that answers each request with the next status in `answers`. */
let server: Server;
let base: string;
let answers: number[];
const received: { url: string; headers: IncomingHttpHeaders; body: string }[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      received.push({ url: request.url ?? '', headers: request.headers, body });
      const status = answers.shift() ?? 204;
      if (status === 302) response.setHeader('location', '/elsewhere');
      response.statusCode = status;
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => {
  received.length = 0;
  answers = [];
});

describe('deliver', () => {
  it('posts the event with a signature the receiver can check', async () => {
    expect(await deliver(`${base}/hook`, event, secret)).toEqual({ ok: true, attempts: 1, status: 204 });
    const [request] = received;
    expect(request?.body).toBe(JSON.stringify(event));
    expect(request?.headers['x-tooldrop-event']).toBe(event.id);
    const timestamp = String(request?.headers['x-tooldrop-timestamp']);
    const signature = String(request?.headers['x-tooldrop-signature']);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyWebhook(secret, timestamp, request?.body ?? '', signature)).toBe(true);
    expect(verifyWebhook('another-secret', timestamp, request?.body ?? '', signature)).toBe(false);
    expect(verifyWebhook(secret, timestamp, `${request?.body} `, signature)).toBe(false);
  });

  it('rejects a signed request that is more than 5 minutes old', () => {
    const then = Math.floor(Date.now() / 1000) - 301;
    expect(verifyWebhook(secret, String(then), 'x', signWebhook(secret, then, 'x'))).toBe(false);
  });

  it('tries again after a server error, and gives up on a refusal', async () => {
    answers = [503, 500, 200];
    expect(await deliver(`${base}/hook`, event, secret, { backoffMs: [0, 0, 0] })).toEqual({
      ok: true,
      attempts: 3,
      status: 200,
    });
    answers = [400];
    expect(await deliver(`${base}/hook`, event, secret, { backoffMs: [0, 0, 0] })).toMatchObject({
      ok: false,
      attempts: 1,
      error: 'the webhook answered 400',
    });
  });

  it('does not follow a redirect with a signed event', async () => {
    answers = [302];
    expect(await deliver(`${base}/hook`, event, secret, { backoffMs: [0] })).toMatchObject({
      ok: false,
      attempts: 1,
      status: 302,
    });
    expect(received.map((request) => request.url)).toEqual(['/hook']);
  });

  it('reports a receiver it cannot reach after every try', async () => {
    const result = await deliver('http://127.0.0.1:9/hook', event, secret, { backoffMs: [0, 0] });
    expect(result).toMatchObject({ ok: false, attempts: 3 });
    expect(result.error).toContain('could not be reached');
  });
});
