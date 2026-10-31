import { randomBytes } from 'node:crypto';
import { createWatchSchema, newId, ToolDropError, type WatchEvent, type WatchView } from '@tooldrop/core';
import {
  claimDueWatches,
  createWatch,
  deleteWatch,
  finishWatchRun,
  getTool,
  getWatch,
  keyAllows,
  listWatches,
  type WatchRow,
  type WatchWithTool,
} from '@tooldrop/db';
import { formatIssues } from '@tooldrop/llm';
import { applyChange, deliver, diff, rowsByKey, snapshotOf, type DeliveryOptions } from '@tooldrop/watches';
import type { Engine, Scopes } from './engine.ts';

// Watches (SPEC, Differentiating features): run a read tool on an interval,
// diff its result by a key field, and send each change to the watch's
// webhook and to MCP clients. Processes that keep running (`tooldrop serve`
// and `tooldrop mcp`) run the scheduler; a lease in the database keeps two of
// them from running the same watch.

export interface WatchOptions {
  /** The clock. Tests move it forward instead of waiting for an interval. */
  now?: () => number;
  /** How often the scheduler looks for due watches (default 30 s). */
  tickMs?: number;
  delivery?: DeliveryOptions;
}

const TICK_MS = 30_000;
/** How long a run may hold its watch: longer than a call that waits for a repair. */
const LEASE_MS = 15 * 60_000;

export class Watches {
  readonly #engine: Engine;
  readonly #options: WatchOptions;
  readonly #listeners = new Set<(event: WatchEvent) => void>();
  #timer: NodeJS.Timeout | undefined;
  #ticking: Promise<void> | undefined;

  constructor(engine: Engine, options: WatchOptions = {}) {
    this.#engine = engine;
    this.#options = options;
  }

  /**
   * Creates a watch. Its first run is the baseline that later runs are
   * compared with, and shows at once whether the tool and key field work.
   * The signing secret is returned here and never again.
   */
  async create(input: unknown, scopes: Scopes): Promise<{ watch: WatchView; secret: string }> {
    const parsed = createWatchSchema.safeParse(input);
    if (!parsed.success) {
      const problems = formatIssues(parsed.error.issues);
      throw new ToolDropError('invalid_input', `invalid watch: ${problems.slice(0, 3).join('; ')}`, {
        details: { problems },
      });
    }
    const request = parsed.data;
    const db = this.#engine.db;
    const tool = await getTool(db, request.tool);
    if (!tool || tool.status === 'disabled' || !keyAllows(scopes, request.tool)) {
      throw new ToolDropError('not_found', `no tool named ${request.tool}`);
    }
    if (tool.authority !== 'read') {
      throw new ToolDropError(
        'invalid_input',
        `${tool.name} changes the site; only read tools can be watched`,
      );
    }
    const vault = await this.#engine.vault();

    const started = this.#now();
    const outcome = await this.#engine.runTool(tool.name, request.inputs, scopes);
    const snapshot = snapshotOf(rowsByKey(outcome.result, request.key_field));
    const secret = randomBytes(32).toString('hex');
    const row = await createWatch(db, {
      tool_id: tool.id,
      inputs: request.inputs,
      interval_s: request.interval_s,
      key_field: request.key_field,
      webhook_url: request.webhook_url,
      secret: vault.seal(secret),
      last_snapshot_hash: snapshot.hash,
      row_hashes: snapshot.rows,
      last_run_at: new Date(started),
      next_run_at: new Date(started + request.interval_s * 1000),
    });
    return { watch: view({ ...row, tool: tool.name }), secret };
  }

  /** The watches on tools a key may use. */
  async list(scopes: Scopes): Promise<WatchView[]> {
    return (await listWatches(this.#engine.db)).filter((watch) => keyAllows(scopes, watch.tool)).map(view);
  }

  async delete(id: string, scopes: Scopes): Promise<void> {
    const watch = await getWatch(this.#engine.db, id);
    if (!watch || !keyAllows(scopes, watch.tool)) throw new ToolDropError('not_found', `no watch ${id}`);
    await deleteWatch(this.#engine.db, id);
  }

  /** Calls `listener` with every change a watch finds, e.g. to send MCP notifications. */
  onEvent(listener: (event: WatchEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Runs every due watch once. The scheduler calls this; tests call it after moving the clock. */
  async tick(): Promise<void> {
    const now = this.#now();
    for (const claimed of await claimDueWatches(this.#engine.db, new Date(now), new Date(now + LEASE_MS))) {
      await this.#run(claimed);
    }
  }

  /** Looks for due watches every 30 s, until stopped. */
  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      this.#ticking ??= this.tick()
        .catch(() => undefined)
        .finally(() => (this.#ticking = undefined));
    }, this.#options.tickMs ?? TICK_MS);
    this.#timer.unref();
  }

  /** Stops the scheduler and waits for the runs in progress. */
  async stop(): Promise<void> {
    clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#ticking;
  }

  async #run(claimed: WatchRow): Promise<void> {
    const db = this.#engine.db;
    const watch = await getWatch(db, claimed.id);
    if (!watch) return;
    const started = this.#now();
    const times = {
      last_run_at: new Date(started),
      next_run_at: new Date(started + watch.interval_s * 1000),
    };
    try {
      // The watch was allowed when it was created; its runs need no key.
      const outcome = await this.#engine.runTool(watch.tool, watch.inputs);
      const rows = rowsByKey(outcome.result, watch.key_field);
      const snapshot = snapshotOf(rows);
      if (snapshot.hash === watch.last_snapshot_hash) {
        await finishWatchRun(db, watch.id, { ...times, last_error: null });
        return;
      }
      const secret = (await this.#engine.vault()).open(watch.secret).toString('utf8');
      const previous = { hash: watch.last_snapshot_hash ?? '', rows: watch.row_hashes ?? {} };
      const kept = { ...previous.rows };
      let failure: string | undefined;
      for (const change of diff(previous, rows)) {
        const event: WatchEvent = {
          id: newId(),
          watch_id: watch.id,
          tool: watch.tool,
          type: change.type,
          key: change.key,
          ...(change.row && { row: change.row }),
          detected_at: new Date(started).toISOString(),
        };
        for (const listener of this.#listeners) listener(event);
        const delivery = await deliver(watch.webhook_url, event, secret, this.#options.delivery);
        // A change that was not delivered stays out of the snapshot, so the next run sends it again.
        if (delivery.ok) applyChange(kept, change);
        else failure ??= delivery.error;
      }
      await finishWatchRun(db, watch.id, {
        ...times,
        last_snapshot_hash: failure ? null : snapshot.hash,
        row_hashes: kept,
        last_error: failure ?? null,
      });
    } catch (error) {
      await finishWatchRun(db, watch.id, {
        ...times,
        last_error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }
}

function view(watch: WatchWithTool): WatchView {
  return {
    id: watch.id,
    tool: watch.tool,
    inputs: watch.inputs,
    interval_s: watch.interval_s,
    key_field: watch.key_field,
    webhook_url: watch.webhook_url,
    last_run_at: watch.last_run_at?.toISOString() ?? null,
    next_run_at: watch.next_run_at?.toISOString() ?? null,
    last_error: watch.last_error,
    created_at: watch.created_at.toISOString(),
  };
}
