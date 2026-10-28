import { newId } from '@tooldrop/core';
import { and, asc, eq, isNull, lte, or } from 'drizzle-orm';
import type { Queryable } from '../client.ts';
import { tools, watches } from '../schema.ts';

// Watches (SPEC, Differentiating features). The engine runs them; these
// queries keep their schedule, so processes that share a database never run
// the same watch twice.

export type WatchRow = typeof watches.$inferSelect;

/** A watch with the name of the tool it runs. */
export type WatchWithTool = WatchRow & { tool: string };

export function createWatch(
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
): WatchRow {
  return db
    .insert(watches)
    .values({ id: newId(), ...watch })
    .returning()
    .get();
}

function selectWatches(db: Queryable) {
  return db
    .select({ watch: watches, tool: tools.name })
    .from(watches)
    .innerJoin(tools, eq(tools.id, watches.tool_id));
}

export function listWatches(db: Queryable): WatchWithTool[] {
  return selectWatches(db)
    .orderBy(asc(watches.created_at))
    .all()
    .map(({ watch, tool }) => ({ ...watch, tool }));
}

export function getWatch(db: Queryable, id: string): WatchWithTool | undefined {
  const found = selectWatches(db).where(eq(watches.id, id)).get();
  return found && { ...found.watch, tool: found.tool };
}

export function deleteWatch(db: Queryable, id: string): boolean {
  return db.delete(watches).where(eq(watches.id, id)).run().changes > 0;
}

/**
 * Takes every due watch that no other process holds, and holds it until
 * `leaseUntil`. One UPDATE statement, so two processes cannot take the same
 * watch.
 */
export function claimDueWatches(db: Queryable, now: Date, leaseUntil: Date): WatchRow[] {
  return db
    .update(watches)
    .set({ lease_until: leaseUntil })
    .where(
      and(
        or(isNull(watches.next_run_at), lte(watches.next_run_at, now)),
        or(isNull(watches.lease_until), lte(watches.lease_until, now)),
      ),
    )
    .returning()
    .all();
}

/** Saves how a run went, schedules the next one and lets go of the watch. */
export function finishWatchRun(
  db: Queryable,
  id: string,
  run: Partial<Pick<WatchRow, 'last_snapshot_hash' | 'row_hashes'>> &
    Pick<WatchRow, 'last_run_at' | 'next_run_at' | 'last_error'>,
): void {
  db.update(watches)
    .set({ ...run, lease_until: null })
    .where(eq(watches.id, id))
    .run();
}
