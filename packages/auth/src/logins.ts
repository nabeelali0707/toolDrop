import { addLoginSchema, ToolDropError, type AddLogin, type LoginView } from '@tooldrop/core';
import { createLogin, getLogin, listLogins, type LoginWithSite, type Queryable } from '@tooldrop/db';
import { z } from 'zod';
import type { Vault } from './vault/vault.ts';

// Saved logins (SPEC, Authentication): the username, password and TOTP secret
// are sealed together in the vault. Every API returns only a masked view.

/** What the vault holds for a login. */
export interface LoginSecret {
  username: string;
  password: string;
  totp_secret?: string;
}

/** Hides most of a username: "fixture-user" becomes "fi••••er". */
export function maskUsername(username: string): string {
  if (username.length < 6) return `${username.slice(0, 1)}••••`;
  return `${username.slice(0, 2)}••••${username.slice(-2)}`;
}

export function addLogin(db: Queryable, vault: Vault, input: unknown): LoginView {
  const parsed = addLoginSchema.safeParse(input);
  if (!parsed.success) {
    // Never echo the values: the issues name the fields only.
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || 'login'))];
    throw new ToolDropError('invalid_input', `the login is not valid; check ${fields.join(', ')}`, {
      details: { fields },
    });
  }
  const login: AddLogin = parsed.data;
  const secret: LoginSecret = {
    username: login.username,
    password: login.password,
    ...(login.totp_secret && { totp_secret: login.totp_secret.toUpperCase().replace(/=+$/, '') }),
  };
  const created = createLogin(db, {
    site: login.site,
    label: login.label ?? maskUsername(login.username),
    encrypted_secret: vault.sealJson(secret),
    twofa_method: login.totp_secret ? 'totp' : (login.twofa ?? null),
  });
  return viewLogin(vault, created);
}

export function viewLogin(vault: Vault, { login, origin }: LoginWithSite): LoginView {
  return {
    id: login.id,
    site: origin,
    label: login.label,
    username: maskUsername(loginSecret(vault, login.encrypted_secret).username),
    twofa: login.twofa_method,
    status: login.status,
    created_at: login.created_at.toISOString(),
  };
}

export function viewLogins(db: Queryable, vault: Vault, options: { site?: string } = {}): LoginView[] {
  return listLogins(db, options).map((row) => viewLogin(vault, row));
}

const secretSchema = z.object({
  username: z.string(),
  password: z.string(),
  totp_secret: z.string().optional(),
});

/** The login's values, for signing in. Never returned by an API. */
export function loginSecret(vault: Vault, sealed: Uint8Array): LoginSecret {
  const secret = secretSchema.parse(vault.openJson(sealed));
  return {
    username: secret.username,
    password: secret.password,
    ...(secret.totp_secret !== undefined && { totp_secret: secret.totp_secret }),
  };
}

export function requireLogin(db: Queryable, id: string): LoginWithSite {
  const login = getLogin(db, id);
  if (!login) throw new ToolDropError('not_found', `no login ${id}`);
  return login;
}
