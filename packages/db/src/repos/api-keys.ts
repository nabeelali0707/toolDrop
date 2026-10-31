import { createHash, randomBytes } from 'node:crypto';
import { newId } from '@tooldrop/core';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { first, tablesOf, type Queryable } from '../client.ts';

// API keys (DECISIONS.md, D-021).

const KEY_PREFIX = 'td_';

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Creates a key. The returned `key` is the only time it is ever shown. */
export async function createApiKey(
  db: Queryable,
  options: { label: string; scopes?: string[] },
): Promise<{ id: string; key: string }> {
  const { api_keys } = tablesOf(db);
  const key = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  const id = newId();
  await db
    .insert(api_keys)
    .values({ id, label: options.label, key_hash: hashApiKey(key), scopes: options.scopes ?? ['*'] });
  return { id, key };
}

/** The key's record when it is valid and not revoked. */
export async function verifyApiKey(
  db: Queryable,
  key: string,
): Promise<{ id: string; label: string; scopes: string[] } | undefined> {
  if (!key.startsWith(KEY_PREFIX)) return undefined;
  const { api_keys } = tablesOf(db);
  const row = first(
    await db
      .select()
      .from(api_keys)
      .where(and(eq(api_keys.key_hash, hashApiKey(key)), isNull(api_keys.revoked_at))),
  );
  if (!row) return undefined;
  await db.update(api_keys).set({ last_used_at: new Date() }).where(eq(api_keys.id, row.id));
  return { id: row.id, label: row.label, scopes: row.scopes };
}

export async function revokeApiKey(db: Queryable, id: string): Promise<void> {
  const { api_keys } = tablesOf(db);
  await db.update(api_keys).set({ revoked_at: new Date() }).where(eq(api_keys.id, id));
}

/** Whether a key's scopes allow running a tool. */
export function keyAllows(scopes: string[], toolName: string): boolean {
  return scopes.includes('*') || scopes.includes(toolName);
}

/** Every key's label, scopes and dates; never the key or its hash. */
export async function listApiKeys(db: Queryable) {
  const { api_keys } = tablesOf(db);
  const rows = await db
    .select({
      id: api_keys.id,
      label: api_keys.label,
      scopes: api_keys.scopes,
      created_at: api_keys.created_at,
      last_used_at: api_keys.last_used_at,
      revoked_at: api_keys.revoked_at,
    })
    .from(api_keys)
    .orderBy(desc(api_keys.created_at));
  return rows;
}
