import { createHash, randomBytes } from 'node:crypto';
import { newId } from '@tooldrop/core';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Queryable } from '../client.ts';
import { api_keys } from '../schema.ts';

// API keys (DECISIONS.md, D-021).

const KEY_PREFIX = 'td_';

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Creates a key. The returned `key` is the only time it is ever shown. */
export function createApiKey(
  db: Queryable,
  options: { label: string; scopes?: string[] },
): { id: string; key: string } {
  const key = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  const id = newId();
  db.insert(api_keys)
    .values({ id, label: options.label, key_hash: hashApiKey(key), scopes: options.scopes ?? ['*'] })
    .run();
  return { id, key };
}

/** The key's record when it is valid and not revoked. */
export function verifyApiKey(
  db: Queryable,
  key: string,
): { id: string; label: string; scopes: string[] } | undefined {
  if (!key.startsWith(KEY_PREFIX)) return undefined;
  const row = db
    .select()
    .from(api_keys)
    .where(and(eq(api_keys.key_hash, hashApiKey(key)), isNull(api_keys.revoked_at)))
    .get();
  if (!row) return undefined;
  db.update(api_keys).set({ last_used_at: new Date() }).where(eq(api_keys.id, row.id)).run();
  return { id: row.id, label: row.label, scopes: row.scopes };
}

export function revokeApiKey(db: Queryable, id: string): void {
  db.update(api_keys).set({ revoked_at: new Date() }).where(eq(api_keys.id, id)).run();
}

/** Whether a key's scopes allow running a tool. */
export function keyAllows(scopes: string[], toolName: string): boolean {
  return scopes.includes('*') || scopes.includes(toolName);
}

/** Every key's label, scopes and dates; never the key or its hash. */
export function listApiKeys(db: Queryable) {
  return db
    .select({
      id: api_keys.id,
      label: api_keys.label,
      scopes: api_keys.scopes,
      created_at: api_keys.created_at,
      last_used_at: api_keys.last_used_at,
      revoked_at: api_keys.revoked_at,
    })
    .from(api_keys)
    .orderBy(desc(api_keys.created_at))
    .all();
}
