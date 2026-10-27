import { recipeSchema } from '@tooldrop/core';
import { DEMO_SHOP_ACCOUNT, startDemoShopFixture } from '@tooldrop/fixture-demo-shop';
import type { RunningFixture } from '@tooldrop/fixture-kit';
import { FIXTURE_ACCOUNT, startLoginTotpFixture } from '@tooldrop/fixture-login-totp';
import { Runtime } from '@tooldrop/runtime';
import { generate } from 'otplib';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildLoginRecipe } from './build-login.ts';

// Signing in to the login fixtures with their test accounts (DECISIONS.md,
// D-026): never real credentials. The TOTP secret is RFC 6238's public one.

let browser: Browser;
let runtime: Runtime;
let login: RunningFixture;
let shop: RunningFixture;

beforeAll(async () => {
  browser = await chromium.launch();
  runtime = new Runtime({ browserWaitMs: 5_000 });
  login = await startLoginTotpFixture();
  shop = await startDemoShopFixture();
});

afterAll(async () => {
  await runtime.close();
  await browser.close();
  await login.close();
  await shop.close();
});

const account = {
  username: FIXTURE_ACCOUNT.username,
  password: FIXTURE_ACCOUNT.password,
  otp: () => generate({ secret: FIXTURE_ACCOUNT.totpSecret }),
};

/** The fixture's protected invoice page as an html_fetch tool. */
const invoices = (site: string) => ({
  name: 'list_invoices',
  authority: 'read' as const,
  input_schema: { type: 'object' },
  output_schema: { type: 'array' },
  version: 1,
  site,
  login: { url: `${site}/login` },
  recipe: recipeSchema.parse({
    strategy: 'html_fetch',
    steps: [
      { op: 'http', method: 'GET', url: '{{site}}/invoices' },
      {
        op: 'extract_table',
        target: [{ kind: 'test_id', value: 'invoices' }],
        columns: { number: 'Number' },
      },
    ],
  }),
});

describe('login recipes', () => {
  it('builds a login recipe with a TOTP step by signing in once', async () => {
    const { recipe, state } = await buildLoginRecipe(login.url, account, { browser });
    expect(recipe.url).toBe('{{site}}/login');
    expect(recipe.steps.map((step) => step.op)).toEqual(['goto', 'fill', 'fill', 'click', 'fill', 'click']);
    expect(recipe.steps.filter((step) => step.op === 'fill').map((step) => step.value)).toEqual([
      '{{input.username}}',
      '{{input.password}}',
      '{{input.otp}}',
    ]);
    expect(recipe.check).toEqual({ kind: 'page', url: '{{site}}/invoices' });
    expect(JSON.stringify(recipe)).not.toContain(FIXTURE_ACCOUNT.password);
    expect(state.cookies.map((cookie) => cookie.name)).toContain('session');
  }, 60_000);

  it('signs in again from the recipe, and notices when the session expires', async () => {
    const { recipe } = await buildLoginRecipe(login.url, account, { browser });
    const state = await runtime.signIn(recipe, login.url, {
      username: FIXTURE_ACCOUNT.username,
      password: FIXTURE_ACCOUNT.password,
      otp: await account.otp(),
    });
    await runtime.useSession(login.url, state);
    const signedIn = await runtime.run(invoices(login.url));
    expect((signedIn.result as unknown[]).length).toBe(10);

    await fetch(`${login.url}/__fixture/expire-sessions`, { method: 'POST' });
    await expect(runtime.run(invoices(login.url))).rejects.toMatchObject({ code: 'session_expired' });
  }, 60_000);

  it('finds the sign-in link first when the start page has no form', async () => {
    const { recipe } = await buildLoginRecipe(
      shop.url,
      {
        username: DEMO_SHOP_ACCOUNT.username,
        password: DEMO_SHOP_ACCOUNT.password,
        otp: () => generate({ secret: DEMO_SHOP_ACCOUNT.totpSecret }),
      },
      { browser },
    );
    expect(recipe.url).toBe('{{site}}/signin');
    expect(recipe.steps.map((step) => step.op)).toEqual([
      'goto',
      'click',
      'fill',
      'fill',
      'click',
      'fill',
      'click',
    ]);
    expect(recipe.check).toEqual({ kind: 'page', url: '{{site}}/account/orders' });
  }, 60_000);

  it('reports a wrong password instead of saving a broken recipe', async () => {
    await expect(
      buildLoginRecipe(login.url, { ...account, password: 'wrong-password-not-real' }, { browser }),
    ).rejects.toMatchObject({ code: 'session_expired' });
  }, 60_000);
});
