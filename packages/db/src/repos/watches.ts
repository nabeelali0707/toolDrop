import { newId } from '@tooldrop/core';
import { and, asc, eq, isNull, lte, or } from 'drizzle-orm';
import { first, one, tablesOf, type Queryable } from '../client.ts';
import type { watches } from '../schema.ts';

// Watches (SPEC, Differentiating features). The engine runs them; these
// queries keep their schedule, so processes that share a database never run
// the same watch twice.

export type WatchRow = typeof watches.$inferSelect;

/** A watch with the name of the tool it runs. */
export type WatchWithTool = WatchRow & { tool: string };

export async function createWatch(
  db: Queryable,
  watch: Pick<
    WatchRow,
    | 'tool_id'
    | 'inputs'
    | 'interval_s'
    | 'key_field'
    | 'webhook_url'
    | 'secret'
    | 'last_snapshot_hash'
    | 'row_hashes'
    | 'next_run_at'
    | 'last_run_at'
  >,
): Promise<WatchRow> {
  const { watches } = tablesOf(db);
  return one(
    await db
      .insert(watches)
      .values({ id: newId(), ...watch })
      .returning(),
  );
}

function selectWatches(db: Queryable) {
  const { tools, watches } = tablesOf(db);
  return db
    .select({ watch: watches, tool: tools.name })
    .from(watches)
    .innerJoin(tools, eq(tools.id, watches.tool_id));
}

export async function listWatches(db: Queryable): Promise<WatchWithTool[]> {
  const { watches } = tablesOf(db);
  const rows = await selectWatches(db).orderBy(asc(watches.created_at));
  return rows.map(({ watch, tool }) => ({ ...watch, tool }));
}

export async function getWatch(db: Queryable, id: string): Promise<WatchWithTool | undefined> {
  const { watches } = tablesOf(db);
  const found = first(await selectWatches(db).where(eq(watches.id, id)));
  return found && { ...found.watch, tool: found.tool };
}

export async function deleteWatch(db: Queryable, id: string): Promise<boolean> {
  const { watches } = tablesOf(db);
  const deleted = await db.delete(watches).where(eq(watches.id, id)).returning({ id: watches.id });
  return deleted.length > 0;
}

/**
 * Takes every due watch that no other process holds, and holds it until
 * `leaseUntil`. One UPDATE statement, so two processes cannot take the same
 * watch.
 */
export async function claimDueWatches(db: Queryable, now: Date, leaseUntil: Date): Promise<WatchRow[]> {
  const { watches } = tablesOf(db);
  const claimed = await db
    .update(watches)
    .set({ lease_until: leaseUntil })
    .where(
      and(
        or(isNull(watches.next_run_at), lte(watches.next_run_at, now)),
        or(isNull(watches.lease_until), lte(watches.lease_until, now)),
      ),
    )
    .returning();
  return claimed;
}

/** Saves how a run went, schedules the next one and lets go of the watch. */
export async function finishWatchRun(
  db: Queryable,
  id: string,
  run: Partial<Pick<WatchRow, 'last_snapshot_hash' | 'row_hashes'>> &
    Pick<WatchRow, 'last_run_at' | 'next_run_at' | 'last_error'>,
): Promise<void> {
  const { watches } = tablesOf(db);
  await db
    .update(watches)
    .set({ ...run, lease_until: null })
    .where(eq(watches.id, id));
}
