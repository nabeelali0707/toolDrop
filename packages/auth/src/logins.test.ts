import type { DatabaseHandle } from '@tooldrop/db';
import { openTestDatabase } from '@tooldrop/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addLogin, loginSecret, maskUsername, requireLogin, viewLogins } from './logins.ts';
import { memoryKeyStore } from './vault/key-store.ts';
import { Vault } from './vault/vault.ts';

// Fixture-only values (DECISIONS.md, D-026): never real credentials.
const password = 'fixture-password-not-real';
const totpSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

let handle: DatabaseHandle;
let vault: Vault;
beforeEach(async () => {
  handle = await openTestDatabase();
  vault = await Vault.open(memoryKeyStore());
});
afterEach(() => handle.close());

describe('saved logins', () => {
  it('seals the values and shows only a masked view', async () => {
    const view = await addLogin(handle.db, vault, {
      site: 'http://127.0.0.1:4103/login',
      username: 'fixture-user',
      password,
      totp_secret: totpSecret.toLowerCase(),
    });
    expect(view).toMatchObject({
      site: 'http://127.0.0.1:4103',
      label: 'fi••••er',
      username: 'fi••••er',
      twofa: 'totp',
      status: 'unchecked',
    });
    expect(JSON.stringify(view)).not.toContain(password);

    const { login } = await requireLogin(handle.db, view.id);
    expect(login.encrypted_secret.toString('latin1')).not.toContain(password);
    expect(loginSecret(vault, login.encrypted_secret)).toEqual({
      username: 'fixture-user',
      password,
      totp_secret: totpSecret,
    });
  });

  it('takes the authenticator secret as a setup page shows it, in groups', async () => {
    const grouped = 'GEZD GNBV-GY3T QOJQ  GEZD GNBV GY3T QOJQ';
    const view = await addLogin(handle.db, vault, {
      site: 'http://127.0.0.1:4103',
      username: 'grouped-user',
      password,
      totp_secret: grouped,
    });
    const { login } = await requireLogin(handle.db, view.id);
    expect(loginSecret(vault, login.encrypted_secret).totp_secret).toBe(totpSecret);
    expect(view.twofa).toBe('totp');

    // A real mistake is still refused, and the answer still says which field, never its value.
    const refused = await addLogin(handle.db, vault, {
      site: 'http://127.0.0.1:4103',
      username: 'typo-user',
      password,
      totp_secret: 'not a base32 secret 0189',
    }).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: 'invalid_input', details: { fields: ['totp_secret'] } });
    expect(String((refused as Error).message)).not.toContain('0189');
  });

  it('lists logins by site, newest first', async () => {
    await addLogin(handle.db, vault, { site: 'http://127.0.0.1:4103', username: 'fixture-user', password });
    await addLogin(handle.db, vault, {
      site: 'http://127.0.0.1:4104',
      username: 'demo-shopper',
      password,
      label: 'shop',
      twofa: 'human',
    });
    expect((await viewLogins(handle.db, vault)).map((login) => login.label)).toEqual(['shop', 'fi••••er']);
    expect(await viewLogins(handle.db, vault, { site: 'http://127.0.0.1:4104/orders' })).toEqual([
      expect.objectContaining({ label: 'shop', twofa: 'human' }),
    ]);
  });

  it('reports bad input by field, never repeating a value', async () => {
    let message = '';
    try {
      await addLogin(handle.db, vault, {
        site: 'not a site',
        username: 'u',
        password,
        totp_secret: 'not base32!!',
      });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toBe('the login is not valid; check site, totp_secret');
    expect(message).not.toContain(password);
  });

  it('masks short and long usernames', () => {
    expect(maskUsername('ann')).toBe('a••••');
    expect(maskUsername('ana.lopez@example.test')).toBe('an••••st');
  });
});
