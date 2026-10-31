import { newId, type LoginStatus, type TwofaConfig, type TwofaMethod } from '@tooldrop/core';
import { desc, eq } from 'drizzle-orm';
import { first, one, tablesOf, type Queryable } from '../client.ts';
import type { logins } from '../schema.ts';
import { ensureSite } from './tools.ts';

// Saved logins (SPEC, Authentication). The secret arrives sealed by the vault;
// this layer never sees a password.

export type LoginRow = typeof logins.$inferSelect;

export interface LoginWithSite {
  login: LoginRow;
  origin: string;
}

export async function createLogin(
  db: Queryable,
  login: {
    site: string;
    label: string;
    encrypted_secret: Buffer;
    twofa_method: TwofaMethod | null;
    twofa_config?: TwofaConfig;
  },
): Promise<LoginWithSite> {
  const { logins } = tablesOf(db);
  const site = await ensureSite(db, login.site);
  const row = one(
    await db
      .insert(logins)
      .values({
        id: newId(),
        site_id: site.id,
        label: login.label,
        encrypted_secret: login.encrypted_secret,
        twofa_method: login.twofa_method,
        twofa_config: login.twofa_config ?? null,
      })
      .returning(),
  );
  return { login: row, origin: site.origin };
}

/** Logins, newest first, optionally for one site's origin. */
export async function listLogins(db: Queryable, options: { site?: string } = {}): Promise<LoginWithSite[]> {
  const { logins, sites } = tablesOf(db);
  const origin = options.site ? new URL(options.site).origin : undefined;
  const rows = await db
    .select({ login: logins, origin: sites.origin })
    .from(logins)
    .innerJoin(sites, eq(sites.id, logins.site_id))
    .where(origin ? eq(sites.origin, origin) : undefined)
    .orderBy(desc(logins.created_at));
  return rows;
}

export async function getLogin(db: Queryable, id: string): Promise<LoginWithSite | undefined> {
  const { logins, sites } = tablesOf(db);
  return first(
    await db
      .select({ login: logins, origin: sites.origin })
      .from(logins)
      .innerJoin(sites, eq(sites.id, logins.site_id))
      .where(eq(logins.id, id)),
  );
}

export async function setLoginStatus(db: Queryable, id: string, status: LoginStatus): Promise<void> {
  const { logins } = tablesOf(db);
  await db.update(logins).set({ status }).where(eq(logins.id, id));
}

export async function deleteLogin(db: Queryable, id: string): Promise<boolean> {
  const { logins } = tablesOf(db);
  const deleted = await db.delete(logins).where(eq(logins.id, id)).returning({ id: logins.id });
  return deleted.length > 0;
}
