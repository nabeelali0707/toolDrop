import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryKeyStore } from '@tooldrop/auth';
import { toolFileSchema } from '@tooldrop/core';
import { openDatabase, runMigrations, type DatabaseHandle } from '@tooldrop/db';
import { Engine } from '@tooldrop/engine';
import type { RunningFixture } from '@tooldrop/fixture-kit';
import { FIXTURE_ACCOUNT, FIXTURE_SMS_SENDER, startLoginTotpFixture } from '@tooldrop/fixture-login-totp';
import { Runtime } from '@tooldrop/runtime';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, createSmsServer } from './app.ts';

// SPEC's SMS 2FA criterion: a signed forwarded SMS completes the login
// fixture's SMS sign-in; an unsigned, stale or duplicate one is rejected. The
// fixture plays the phone: it sends its code to toolDrop's webhook the way
// SMS to URL Forwarder does.

let browser: Browser;
let fixture: RunningFixture;
let dataDir: string;
let handle: DatabaseHandle;
let engine: Engine;
let app: ReturnType<typeof createServer>;
let base: string;
let secret: string;

beforeAll(async () => {
  browser = await chromium.launch();
  fixture = await startLoginTotpFixture();
  dataDir = mkdtempSync(join(tmpdir(), 'tooldrop-sms-'));
  handle = openDatabase(join(dataDir, 'tooldrop.db'));
  await runMigrations(handle.db);
  engine = new Engine({
    db: handle.db,
    dataDir,
    runtime: new Runtime({ browserWaitMs: 5_000 }),
    keyStore: () => Promise.resolve(memoryKeyStore()),
    builds: { browser },
  });
  app = createServer({ engine });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  secret = await engine.enableSms();
}, 60_000);

afterAll(async () => {
  await app.close();
  await engine.close();
  await handle.close();
  await browser.close();
  await fixture.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
});

/** Posts an SMS to the webhook, signed with `key`, or unsigned with null. */
function forward(body: object, key: string | null = secret) {
  const text = JSON.stringify(body);
  return fetch(`${base}/v1/sms/inbound`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key && { 'x-signature': createHmac('sha256', key).update(text).digest('hex') }),
    },
    body: text,
  });
}

describe('SMS codes', () => {
  it('signs in with the code the site sends by SMS, through the forwarder', async () => {
    await fetch(`${fixture.url}/__fixture/switches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ smsCode: true }),
    });
    await fetch(`${fixture.url}/__fixture/sms-forwarder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `${base}/v1/sms/inbound`, secret }),
    });
    await engine.addLogin({
      site: fixture.url,
      username: FIXTURE_ACCOUNT.username,
      password: FIXTURE_ACCOUNT.password,
      twofa: 'sms',
      twofa_config: { sender: FIXTURE_SMS_SENDER },
    });
    expect(await engine.signIn(fixture.url)).toBe(true);

    await engine.publish(
      toolFileSchema.parse({
        name: 'protected_invoices',
        description: 'The newest invoices on the signed-in page.',
        authority: 'read',
        input_schema: { type: 'object', properties: {} },
        output_schema: { type: 'array' },
        recipe: {
          strategy: 'html_fetch',
          steps: [
            { op: 'http', method: 'GET', url: '{{site}}/invoices' },
            {
              op: 'extract_table',
              target: [{ kind: 'test_id', value: 'invoices' }],
              columns: { number: 'Number' },
            },
          ],
        },
      }),
      fixture.url,
    );
    expect(((await engine.runTool('protected_invoices', {})).result as unknown[]).length).toBe(10);
  }, 120_000);

  it('rejects an unsigned, stale or repeated message', async () => {
    const message = { from: FIXTURE_SMS_SENDER, text: 'Code 482913', receivedStamp: String(Date.now()) };
    expect((await forward(message, null)).status).toBe(401);
    expect((await forward(message, 'another-secret')).status).toBe(401);
    expect((await forward({ ...message, receivedStamp: String(Date.now() - 6 * 60_000) })).status).toBe(400);
    expect((await forward(message)).status).toBe(204);
    expect((await forward(message)).status).toBe(409);
  });

  it('takes the secret as a bearer token, for forwarders that cannot sign', async () => {
    const response = await fetch(`${base}/v1/sms/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ from: 'Bank', text: 'Code 135790', receivedStamp: String(Date.now()) }),
    });
    expect(response.status).toBe(204);
  });

  it('serves nothing but the webhook on the local network listener', async () => {
    const lan = createSmsServer({ engine });
    expect((await lan.inject({ url: '/v1/tools' })).statusCode).toBe(404);
    expect((await lan.inject({ url: '/' })).statusCode).toBe(404);
    const unsigned = await lan.inject({
      method: 'POST',
      url: '/v1/sms/inbound',
      payload: { from: 'x', text: '1234' },
    });
    expect(unsigned.statusCode).toBe(401);
    await lan.close();
  });
});
