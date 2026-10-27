import { newId, type LoginStatus, type TwofaConfig, type TwofaMethod } from '@tooldrop/core';
import { desc, eq } from 'drizzle-orm';
import type { Queryable } from '../client.ts';
import { logins, sites } from '../schema.ts';
import { ensureSite } from './tools.ts';

// Saved logins (SPEC, Authentication). The secret arrives sealed by the vault;
// this layer never sees a password.

export type LoginRow = typeof logins.$inferSelect;

export interface LoginWithSite {
  login: LoginRow;
  origin: string;
}

export function createLogin(
  db: Queryable,
  login: {
    site: string;
    label: string;
    encrypted_secret: Buffer;
    twofa_method: TwofaMethod | null;
    twofa_config?: TwofaConfig;
  },
): LoginWithSite {
  const site = ensureSite(db, login.site);
  const row = db
    .insert(logins)
    .values({
      id: newId(),
      site_id: site.id,
      label: login.label,
      encrypted_secret: login.encrypted_secret,
      twofa_method: login.twofa_method,
      twofa_config: login.twofa_config ?? null,
    })
    .returning()
    .get();
  return { login: row, origin: site.origin };
}

/** Logins, newest first, optionally for one site's origin. */
export function listLogins(db: Queryable, options: { site?: string } = {}): LoginWithSite[] {
  const query = db
    .select({ login: logins, origin: sites.origin })
    .from(logins)
    .innerJoin(sites, eq(sites.id, logins.site_id));
  const origin = options.site ? new URL(options.site).origin : undefined;
  return (origin ? query.where(eq(sites.origin, origin)) : query).orderBy(desc(logins.created_at)).all();
}

export function getLogin(db: Queryable, id: string): LoginWithSite | undefined {
  return db
    .select({ login: logins, origin: sites.origin })
    .from(logins)
    .innerJoin(sites, eq(sites.id, logins.site_id))
    .where(eq(logins.id, id))
    .get();
}

export function setLoginStatus(db: Queryable, id: string, status: LoginStatus): void {
  db.update(logins).set({ status }).where(eq(logins.id, id)).run();
}

export function deleteLogin(db: Queryable, id: string): boolean {
  return db.delete(logins).where(eq(logins.id, id)).returning({ id: logins.id }).all().length > 0;
}
