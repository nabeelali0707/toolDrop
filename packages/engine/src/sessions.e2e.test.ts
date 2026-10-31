import { memoryKeyStore, type KeyStore } from '@tooldrop/auth';
import { toolFileSchema } from '@tooldrop/core';
import {
  approvedAuthOrigins,
  latestSession,
  listLogins,
  openDatabase,
  runMigrations,
  type DatabaseHandle,
} from '@tooldrop/db';
import type { RunningFixture } from '@tooldrop/fixture-kit';
import { CAPTCHA_SOLVED, FIXTURE_ACCOUNT, startLoginTotpFixture } from '@tooldrop/fixture-login-totp';
import { Runtime } from '@tooldrop/runtime';
import { generate } from 'otplib';
import { chromium, type Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from './engine.ts';

// SPEC's Login + 2FA criterion: the TOTP fixture signs in unattended, and an
// expired session refreshes without failing the call. Fixture-only account.

let browser: Browser;
let fixture: RunningFixture;
let handle: DatabaseHandle;
let keyStore: KeyStore;
const engines: Engine[] = [];

/** The fixture's protected invoice page, as a hand-written tool. */
const protectedInvoices = toolFileSchema.parse({
  name: 'protected_invoices',
  description: 'The 10 newest invoices on the signed-in page.',
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
});

function start(): Engine {
  const engine = new Engine({
    db: handle.db,
    runtime: new Runtime({ browserWaitMs: 5_000 }),
    keyStore: () => Promise.resolve(keyStore),
    builds: { browser },
  });
  engines.push(engine);
  return engine;
}

beforeAll(async () => {
  browser = await chromium.launch();
  fixture = await startLoginTotpFixture();
});
afterAll(async () => {
  await browser.close();
  await fixture.close();
});
beforeEach(async () => {
  handle = openDatabase(':memory:');
  await runMigrations(handle.db);
  keyStore = memoryKeyStore();
});
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  await handle.close();
  await fetch(`${fixture.url}/__fixture/reset`, { method: 'POST' });
});

const flip = (switches: Record<string, boolean>) =>
  fetch(`${fixture.url}/__fixture/switches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(switches),
  });

describe('signed-in sites', () => {
  it('signs in unattended with TOTP, and refreshes an expired session within the call', async () => {
    const engine = start();
    await engine.addLogin({
      site: fixture.url,
      username: FIXTURE_ACCOUNT.username,
      password: FIXTURE_ACCOUNT.password,
      totp_secret: FIXTURE_ACCOUNT.totpSecret,
    });
    await engine.publish(protectedInvoices, fixture.url);

    const first = await engine.runTool('protected_invoices', {});
    expect(first.result).toHaveLength(10);
    const [login] = await listLogins(handle.db);
    expect(login?.login.status).toBe('verified');
    const session = await latestSession(handle.db, login?.login.id ?? '');
    expect(session?.storage_state.toString('latin1')).not.toContain('session');

    // The site forgets every session; the next call signs in again and still answers.
    await fetch(`${fixture.url}/__fixture/expire-sessions`, { method: 'POST' });
    const second = await engine.runTool('protected_invoices', {});
    expect(second.result).toHaveLength(10);
    expect((await latestSession(handle.db, login?.login.id ?? ''))?.id).not.toBe(session?.id);

    // After a restart, the saved session is used as it is.
    const kept = (await latestSession(handle.db, login?.login.id ?? ''))?.id;
    const restarted = start();
    expect((await restarted.runTool('protected_invoices', {})).result).toHaveLength(10);
    expect((await latestSession(handle.db, login?.login.id ?? ''))?.id).toBe(kept);
  }, 120_000);

  it('asks a person for the code when the login has no authenticator secret', async () => {
    const engine = start();
    await engine.addLogin({
      site: fixture.url,
      username: FIXTURE_ACCOUNT.username,
      password: FIXTURE_ACCOUNT.password,
      twofa: 'human',
    });
    await engine.publish(protectedInvoices, fixture.url);
    // Without a person to ask, a call cannot sign in.
    await expect(engine.runTool('protected_invoices', {})).rejects.toMatchObject({
      code: 'session_expired',
      message: expect.stringContaining('one-time code') as string,
    });

    // The person reads the code from their authenticator app.
    const questions: string[] = [];
    const ask = async (question: { text: string }) => {
      questions.push(question.text);
      return generate({ secret: FIXTURE_ACCOUNT.totpSecret });
    };
    expect(await engine.signIn(fixture.url, { ask })).toBe(true);
    expect(questions).toEqual([`Enter the sign-in code ${fixture.url} just sent you.`]);
    expect((await engine.runTool('protected_invoices', {})).result).toHaveLength(10);
  }, 120_000);

  it('marks a login that no longer works, and says so', async () => {
    const engine = start();
    await engine.addLogin({
      site: fixture.url,
      username: FIXTURE_ACCOUNT.username,
      password: 'wrong-password-not-real',
      totp_secret: FIXTURE_ACCOUNT.totpSecret,
    });
    await engine.publish(protectedInvoices, fixture.url);
    await expect(engine.runTool('protected_invoices', {})).rejects.toMatchObject({ code: 'session_expired' });
    expect((await listLogins(handle.db))[0]?.login.status).toBe('needs_attention');
  }, 60_000);

  it('asks once before typing the login on an identity provider, and remembers the answer', async () => {
    await flip({ ssoLogin: true });
    const engine = start();
    await engine.addLogin({
      site: fixture.url,
      username: FIXTURE_ACCOUNT.username,
      password: FIXTURE_ACCOUNT.password,
    });
    const provider = `http://localhost:${new URL(fixture.url).port}`;
    await expect(engine.signIn(fixture.url)).rejects.toMatchObject({
      code: 'human_needed',
      details: { approve_origin: provider },
    });

    const questions: string[] = [];
    const ask = ({ text }: { text: string }) => {
      questions.push(text);
      return Promise.resolve('allow');
    };
    expect(await engine.signIn(fixture.url, { ask })).toBe(true);
    expect(questions).toEqual([
      `Signing in to ${fixture.url} goes through ${provider}, another site. Should toolDrop type the saved login there from now on?`,
    ]);
    expect(await approvedAuthOrigins(handle.db, fixture.url)).toEqual([provider]);

    // Allowed once: the next sign-in asks nothing.
    expect(await engine.signIn(fixture.url)).toBe(true);
    await engine.publish(protectedInvoices, fixture.url);
    expect(((await engine.runTool('protected_invoices', {})).result as unknown[]).length).toBe(10);
  }, 120_000);

  it('keeps a session a person signed in to by hand, past a captcha', async () => {
    await flip({ captcha: true });
    const engine = start();
    await engine.addLogin({
      site: fixture.url,
      username: FIXTURE_ACCOUNT.username,
      password: FIXTURE_ACCOUNT.password,
    });
    await engine.publish(protectedInvoices, fixture.url);
    await expect(engine.runTool('protected_invoices', {})).rejects.toMatchObject({
      code: 'human_needed',
      details: { by_hand: true },
    });

    // The person: signs in and solves the captcha, as `tooldrop logins verify --by-hand` lets them.
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${fixture.url}/login`);
    await page.getByLabel('Username').fill(FIXTURE_ACCOUNT.username);
    await page.getByLabel('Password').fill(FIXTURE_ACCOUNT.password);
    await page.locator('input[name="g-recaptcha-response"]').evaluate((input, answer) => {
      (input as HTMLInputElement).value = answer;
    }, CAPTCHA_SOLVED);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByLabel('Code').fill(await generate({ secret: FIXTURE_ACCOUNT.totpSecret }));
    await page.getByRole('button', { name: 'Verify' }).click();
    await page.waitForURL('**/invoices');
    await engine.sessions.saveByHand(fixture.url, {
      state: await context.storageState(),
      signInUrl: `${fixture.url}/login`,
      landingUrl: page.url(),
    });
    await context.close();

    expect(((await engine.runTool('protected_invoices', {})).result as unknown[]).length).toBe(10);
    // When that session ends, toolDrop asks for a person again instead of trying the captcha.
    await fetch(`${fixture.url}/__fixture/expire-sessions`, { method: 'POST' });
    await expect(engine.runTool('protected_invoices', {})).rejects.toThrow('is done by a person');
  }, 120_000);

  it('gives prompts every value to mask, except a username that is a plain word', async () => {
    const engine = start();
    const secret = 'pw-not-real-123';
    await engine.addLogin({ site: 'http://127.0.0.1:1', username: 'admin', password: secret });
    await engine.addLogin({ site: 'http://127.0.0.1:2', username: 'ana@example.test', password: secret });
    expect(await engine.sessions.secretsFor('http://127.0.0.1:1/admin')).toEqual([secret]);
    expect(await engine.sessions.secretsFor('http://127.0.0.1:2')).toEqual(['ana@example.test', secret]);
    expect(await engine.sessions.secretsFor('http://127.0.0.1:3')).toEqual([]);
  });
});
