import type { RunningFixture } from '@tooldrop/fixture-kit';
import { generate } from 'otplib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FIXTURE_ACCOUNT, startLoginTotpFixture } from './server.ts';

let fixture: RunningFixture;

beforeEach(async () => {
  fixture = await startLoginTotpFixture();
});

afterEach(() => fixture.close());

/** A minimal browser: keeps cookies, never follows redirects on its own. */
function browser() {
  const jar = new Map<string, string>();
  const request = async (path: string, form?: Record<string, string>) => {
    const response = await fetch(`${fixture.url}${path}`, {
      method: form ? 'POST' : 'GET',
      redirect: 'manual',
      headers: {
        cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
        ...(form && { 'content-type': 'application/x-www-form-urlencoded' }),
      },
      ...(form && { body: new URLSearchParams(form).toString() }),
    });
    for (const header of response.headers.getSetCookie()) {
      const [pair = '', ...attributes] = header.split(';');
      const [name = '', value = ''] = pair.split('=');
      if (attributes.some((attribute) => attribute.trim() === 'Max-Age=0')) jar.delete(name);
      else jar.set(name, value);
    }
    return response;
  };
  return { request, cookies: jar };
}

async function signIn(b = browser()) {
  await b.request('/login', { username: FIXTURE_ACCOUNT.username, password: FIXTURE_ACCOUNT.password });
  await b.request('/login/totp', { code: await generate({ secret: FIXTURE_ACCOUNT.totpSecret }) });
  return b;
}

describe('login-totp fixture', () => {
  it('signs in with password and TOTP code', async () => {
    const b = browser();

    const afterPassword = await b.request('/login', {
      username: FIXTURE_ACCOUNT.username,
      password: FIXTURE_ACCOUNT.password,
    });
    expect(afterPassword.status).toBe(303);
    expect(afterPassword.headers.get('location')).toBe('/login/totp');

    const code = await generate({ secret: FIXTURE_ACCOUNT.totpSecret });
    const afterCode = await b.request('/login/totp', { code });
    expect(afterCode.status).toBe(303);
    expect(afterCode.headers.get('location')).toBe('/invoices');
    expect(b.cookies.has('pending')).toBe(false);

    expect(await (await b.request('/api/me')).json()).toEqual({ username: 'fixture-user' });
    const invoices = await (await b.request('/invoices')).text();
    expect(invoices).toContain('<span data-testid="account-menu">Signed in as fixture-user</span>');
    expect(invoices).toContain('<table id="invoices"');
  });

  it('keeps signed-out visitors out', async () => {
    const b = browser();
    expect((await b.request('/api/me')).status).toBe(401);
    expect((await b.request('/invoices')).headers.get('location')).toBe('/login');
    expect((await b.request('/login/totp')).headers.get('location')).toBe('/login');
  });

  it('rejects a wrong password', async () => {
    const b = browser();
    const response = await b.request('/login', { username: FIXTURE_ACCOUNT.username, password: 'guess' });
    expect(response.status).toBe(401);
    expect(await response.text()).toContain('Wrong username or password.');
    expect(b.cookies.size).toBe(0);
  });

  it('rejects a wrong code and lets the user try again', async () => {
    const b = browser();
    await b.request('/login', { username: FIXTURE_ACCOUNT.username, password: FIXTURE_ACCOUNT.password });

    const wrong = await b.request('/login/totp', { code: '000000' });
    expect(wrong.status).toBe(401);

    const code = await generate({ secret: FIXTURE_ACCOUNT.totpSecret });
    expect((await b.request('/login/totp', { code })).headers.get('location')).toBe('/invoices');
  });

  it('expires sessions on demand, and a new sign-in works', async () => {
    const b = await signIn();
    await fetch(`${fixture.url}/__fixture/expire-sessions`, { method: 'POST' });
    expect((await b.request('/api/me')).status).toBe(401);

    await signIn(b);
    expect((await b.request('/api/me')).status).toBe(200);
  });

  it('signs out', async () => {
    const b = await signIn();
    expect((await b.request('/logout', {})).headers.get('location')).toBe('/login');
    expect((await b.request('/api/me')).status).toBe(401);
  });
});
