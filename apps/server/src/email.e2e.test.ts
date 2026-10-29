import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryKeyStore } from '@tooldrop/auth';
import { openDatabase, runMigrations, type DatabaseHandle } from '@tooldrop/db';
import { Engine } from '@tooldrop/engine';
import type { RunningFixture } from '@tooldrop/fixture-kit';
import { FIXTURE_ACCOUNT, startLoginTotpFixture } from '@tooldrop/fixture-login-totp';
import { Runtime } from '@tooldrop/runtime';
import hoodiecrow from 'hoodiecrow-imap';
import { ImapFlow } from 'imapflow';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Email codes end to end (SPEC, 2FA step 2): the login fixture sends its code,
// a relay in this test delivers it as an email to a local IMAP server
// (Hoodiecrow, in memory, account testuser / testpass), and toolDrop reads it
// from there while signing in.

const SENDER = 'codes@invoices.example.test';

let browser: Browser;
let fixture: RunningFixture;
let imap: ReturnType<typeof hoodiecrow>;
let relay: Server;
let dataDir: string;
let handle: DatabaseHandle;
let engine: Engine;

/** Delivers the fixture's code as an email, the way the site's mail would arrive. */
async function deliver(text: string): Promise<void> {
  const client = new ImapFlow({
    host: '127.0.0.1',
    port: imap.address().port,
    secure: false,
    auth: { user: 'testuser', pass: 'testpass' },
    logger: false,
  });
  await client.connect();
  const message = [`From: Example Invoices <${SENDER}>`, 'Subject: Your sign-in code', '', text, ''].join(
    '\r\n',
  );
  await client.append('INBOX', message, [], new Date());
  await client.logout();
}

beforeAll(async () => {
  browser = await chromium.launch();
  fixture = await startLoginTotpFixture();
  imap = hoodiecrow();
  await new Promise<void>((resolve) => imap.listen(0, '127.0.0.1', resolve));
  relay = createHttpServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      const { text } = JSON.parse(body) as { text: string };
      void deliver(text).finally(() => response.end());
    });
  });
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  const address = relay.address();
  const relayUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`;
  await fetch(`${fixture.url}/__fixture/switches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ smsCode: true }),
  });
  await fetch(`${fixture.url}/__fixture/sms-forwarder`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: relayUrl, secret: 'relay-not-checked' }),
  });

  dataDir = mkdtempSync(join(tmpdir(), 'tooldrop-email-'));
  handle = openDatabase(join(dataDir, 'tooldrop.db'));
  runMigrations(handle.db);
  engine = new Engine({
    db: handle.db,
    dataDir,
    runtime: new Runtime({ browserWaitMs: 5_000 }),
    keyStore: () => Promise.resolve(memoryKeyStore()),
    builds: { browser },
  });
}, 60_000);

afterAll(async () => {
  await engine.close();
  handle.close();
  await browser.close();
  await fixture.close();
  await new Promise((resolve) => relay.close(resolve));
  await new Promise<void>((resolve) => imap.close(resolve));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
});

describe('email codes', () => {
  it('signs in with the code the site sends by email', async () => {
    await expect(
      engine.connectMailbox({
        host: '127.0.0.1',
        port: imap.address().port,
        user: 'testuser',
        password: 'wrong',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await engine.connectMailbox({
      host: '127.0.0.1',
      port: imap.address().port,
      user: 'testuser',
      password: 'testpass',
    });
    await engine.addLogin({
      site: fixture.url,
      username: FIXTURE_ACCOUNT.username,
      password: FIXTURE_ACCOUNT.password,
      twofa: 'email',
      twofa_config: { sender: SENDER },
    });
    expect(await engine.signIn(fixture.url)).toBe(true);
  }, 120_000);
});
