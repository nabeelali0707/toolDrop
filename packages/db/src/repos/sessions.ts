import { newId, type LoginRecipe, type RecipeOrigin } from '@tooldrop/core';
import { desc, eq, max } from 'drizzle-orm';
import type { Queryable } from '../client.ts';
import { login_recipes, logins, sessions, sites } from '../schema.ts';
import type { LoginWithSite } from './logins.ts';
import { ensureSite } from './tools.ts';

// Login recipes and saved sessions (SPEC, Authentication). A session's
// storage state arrives sealed by the vault, like every secret.

export type SessionRow = typeof sessions.$inferSelect;

/** Publishes a site's login recipe as its next version, and makes it the one in use. */
export function saveLoginRecipe(
  db: Queryable,
  site: string,
  recipe: LoginRecipe,
  createdBy: RecipeOrigin,
): { id: string; version: number } {
  return db.transaction((tx) => {
    const row = ensureSite(tx, site);
    const latest = tx
      .select({ version: max(login_recipes.version) })
      .from(login_recipes)
      .where(eq(login_recipes.site_id, row.id))
      .get();
    const version = (latest?.version ?? 0) + 1;
    const id = newId();
    tx.insert(login_recipes).values({ id, site_id: row.id, version, recipe, created_by: createdBy }).run();
    tx.update(sites).set({ login_recipe_id: id }).where(eq(sites.id, row.id)).run();
    return { id, version };
  });
}

/** The login recipe a site uses, if it has one. */
export function getLoginRecipe(db: Queryable, site: string): LoginRecipe | undefined {
  return db
    .select({ recipe: login_recipes.recipe })
    .from(sites)
    .innerJoin(login_recipes, eq(login_recipes.id, sites.login_recipe_id))
    .where(eq(sites.origin, new URL(site).origin))
    .get()?.recipe;
}

/** Identity providers a person allowed a site's login to be typed on (SPEC, sites.approved_auth_origins). */
export function approvedAuthOrigins(db: Queryable, site: string): string[] {
  return (
    db
      .select({ origins: sites.approved_auth_origins })
      .from(sites)
      .where(eq(sites.origin, new URL(site).origin))
      .get()?.origins ?? []
  );
}

/** Allows a site's login to be typed on another origin from now on. */
export function approveAuthOrigin(db: Queryable, site: string, origin: string): void {
  const row = ensureSite(db, site);
  const allowed = new URL(origin).origin;
  if (row.approved_auth_origins.includes(allowed)) return;
  db.update(sites)
    .set({ approved_auth_origins: [...row.approved_auth_origins, allowed] })
    .where(eq(sites.id, row.id))
    .run();
}

/** The login a site signs in with: a verified one first, then the newest. */
export function siteLogin(db: Queryable, site: string): LoginWithSite | undefined {
  const rows = db
    .select({ login: logins, origin: sites.origin })
    .from(logins)
    .innerJoin(sites, eq(sites.id, logins.site_id))
    .where(eq(sites.origin, new URL(site).origin))
    .orderBy(desc(logins.created_at))
    .all();
  return rows.find((row) => row.login.status === 'verified') ?? rows[0];
}

/** Keeps one session per login: a new one replaces the old. */
export function saveSession(
  db: Queryable,
  session: { login_id: string; storage_state: Buffer; expires_at?: Date | null },
): string {
  return db.transaction((tx) => {
    tx.delete(sessions).where(eq(sessions.login_id, session.login_id)).run();
    const id = newId();
    tx.insert(sessions)
      .values({
        id,
        login_id: session.login_id,
        storage_state: session.storage_state,
        expires_at: session.expires_at ?? null,
        last_verified_at: new Date(),
      })
      .run();
    return id;
  });
}

export function latestSession(db: Queryable, loginId: string): SessionRow | undefined {
  return db
    .select()
    .from(sessions)
    .where(eq(sessions.login_id, loginId))
    .orderBy(desc(sessions.created_at))
    .get();
}

export function deleteSessions(db: Queryable, loginId: string): void {
  db.delete(sessions).where(eq(sessions.login_id, loginId)).run();
}
