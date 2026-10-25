import { testClient, type RunningFixture } from '@tooldrop/fixture-kit';
import { generate } from 'otplib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FIXTURE_ACCOUNT, startLoginTotpFixture } from './server.ts';

let fixture: RunningFixture;

beforeEach(async () => {
  fixture = await startLoginTotpFixture();
});

afterEach(() => fixture.close());

const password = { username: FIXTURE_ACCOUNT.username, password: FIXTURE_ACCOUNT.password };
const code = async () => ({ code: await generate({ secret: FIXTURE_ACCOUNT.totpSecret }) });

async function signIn(client = testClient(fixture.url)) {
  await client.request('/login', { form: password });
  await client.request('/login/totp', { form: await code() });
  return client;
}

describe('login-totp fixture', () => {
  it('signs in with password and TOTP code', async () => {
    const client = testClient(fixture.url);

    const afterPassword = await client.request('/login', { form: password });
    expect(afterPassword.status).toBe(303);
    expect(afterPassword.headers.get('location')).toBe('/login/totp');

    const afterCode = await client.request('/login/totp', { form: await code() });
    expect(afterCode.status).toBe(303);
    expect(afterCode.headers.get('location')).toBe('/invoices');
    expect(client.cookies.has('pending')).toBe(false);

    expect(await (await client.request('/api/me')).json()).toEqual({ username: 'fixture-user' });
    const invoices = await (await client.request('/invoices')).text();
    expect(invoices).toContain('<span data-testid="account-menu">Signed in as fixture-user</span>');
    expect(invoices).toContain('<table id="invoices"');
  });

  it('keeps signed-out visitors out', async () => {
    const client = testClient(fixture.url);
    expect((await client.request('/api/me')).status).toBe(401);
    expect((await client.request('/invoices')).headers.get('location')).toBe('/login');
    expect((await client.request('/login/totp')).headers.get('location')).toBe('/login');
  });

  it('rejects a wrong password', async () => {
    const client = testClient(fixture.url);
    const response = await client.request('/login', { form: { ...password, password: 'guess' } });
    expect(response.status).toBe(401);
    expect(await response.text()).toContain('Wrong username or password.');
    expect(client.cookies.size).toBe(0);
  });

  it('rejects a wrong code and lets the user try again', async () => {
    const client = testClient(fixture.url);
    await client.request('/login', { form: password });

    expect((await client.request('/login/totp', { form: { code: '000000' } })).status).toBe(401);
    expect((await client.request('/login/totp', { form: await code() })).headers.get('location')).toBe(
      '/invoices',
    );
  });

  it('expires sessions on demand, and a new sign-in works', async () => {
    const client = await signIn();
    await fetch(`${fixture.url}/__fixture/expire-sessions`, { method: 'POST' });
    expect((await client.request('/api/me')).status).toBe(401);

    await signIn(client);
    expect((await client.request('/api/me')).status).toBe(200);
  });

  it('signs out', async () => {
    const client = await signIn();
    expect((await client.request('/logout', { form: {} })).headers.get('location')).toBe('/login');
    expect((await client.request('/api/me')).status).toBe(401);
  });
});
