import { touchJob, type Db } from '@tooldrop/db';

/** How often a process touches the jobs it holds, so other processes see they are alive. */
const HEARTBEAT_MS = 10_000;

/**
 * The jobs this process answers for: waiting in its own queue, or running
 * here. Each is touched every 10 s, so no process takes it for abandoned.
 */
export class JobHolds {
  readonly #db: Db;
  readonly #timers = new Map<string, NodeJS.Timeout>();

  constructor(db: Db) {
    this.#db = db;
  }

  has(id: string): boolean {
    return this.#timers.has(id);
  }

  hold(id: string): void {
    if (this.#timers.has(id)) return;
    const timer = setInterval(() => void touchJob(this.#db, id).catch(() => undefined), HEARTBEAT_MS);
    timer.unref();
    this.#timers.set(id, timer);
  }

  release(id: string): void {
    clearInterval(this.#timers.get(id));
    this.#timers.delete(id);
  }
}
