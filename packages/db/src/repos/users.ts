import { newId, ToolDropError, type Role } from '@tooldrop/core';
import { and, desc, eq, lt } from 'drizzle-orm';
import { first, one, tablesOf, type Queryable } from '../client.ts';
import type { audit_events, users } from '../schema.ts';

// Users and the audit log of self-hosted toolDrop (DECISIONS.md, D-057).

export type UserRow = typeof users.$inferSelect;
export type AuditRow = typeof audit_events.$inferSelect;

export async function createUser(db: Queryable, user: { name: string; role: Role }): Promise<UserRow> {
  const { users } = tablesOf(db);
  if (await getUser(db, user.name))
    throw new ToolDropError('conflict', `there is already a user ${user.name}`);
  return one(
    await db
      .insert(users)
      .values({ id: newId(), ...user })
      .returning(),
  );
}

export async function getUser(db: Queryable, name: string): Promise<UserRow | undefined> {
  const { users } = tablesOf(db);
  return first(await db.select().from(users).where(eq(users.name, name)));
}

/** By name. */
export async function listUsers(db: Queryable): Promise<UserRow[]> {
  const { users } = tablesOf(db);
  const rows = await db.select().from(users).orderBy(users.name);
  return rows;
}

export async function setUserRole(db: Queryable, name: string, role: Role): Promise<UserRow> {
  const { users } = tablesOf(db);
  const updated = first(await db.update(users).set({ role }).where(eq(users.name, name)).returning());
  if (!updated) throw new ToolDropError('not_found', `no user ${name}`);
  return updated;
}

/** Removes a user and every API key of theirs. */
export async function deleteUser(db: Queryable, name: string): Promise<boolean> {
  const { api_keys, users } = tablesOf(db);
  const user = await getUser(db, name);
  if (!user) return false;
  await db.delete(api_keys).where(eq(api_keys.user_id, user.id));
  await db.delete(users).where(eq(users.id, user.id));
  return true;
}

export async function recordAudit(
  db: Queryable,
  event: { actor: string; action: string; target?: string | null; status?: number | null },
): Promise<void> {
  const { audit_events } = tablesOf(db);
  await db.insert(audit_events).values({
    id: newId(),
    actor: event.actor,
    action: event.action,
    target: event.target ?? null,
    status: event.status ?? null,
  });
}

/** Newest first, optionally one actor's only, and before a time to page back. */
export async function listAudit(
  db: Queryable,
  options: { actor?: string; before?: Date; limit?: number } = {},
): Promise<AuditRow[]> {
  const { audit_events } = tablesOf(db);
  const conditions = [
    ...(options.actor ? [eq(audit_events.actor, options.actor)] : []),
    ...(options.before ? [lt(audit_events.created_at, options.before)] : []),
  ];
  const rows = await db
    .select()
    .from(audit_events)
    .where(and(...conditions))
    .orderBy(desc(audit_events.created_at))
    .limit(options.limit ?? 100);
  return rows;
}
