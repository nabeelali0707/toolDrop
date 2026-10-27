// The job queue (SPEC, Queue): in-process locally. Self-hosted mode swaps in
// BullMQ on Valkey behind the same interface (PLAN, task 5.2).

export interface JobQueue {
  enqueue(work: () => Promise<void>): void;
  /** Resolves once every job enqueued so far has finished. */
  idle(): Promise<void>;
}

export class InProcessQueue implements JobQueue {
  readonly #concurrency: number;
  readonly #waiting: (() => Promise<void>)[] = [];
  readonly #running = new Set<Promise<void>>();

  /** Builds drive a browser and a model, so one at a time is the default. */
  constructor(concurrency = 1) {
    this.#concurrency = concurrency;
  }

  enqueue(work: () => Promise<void>): void {
    this.#waiting.push(work);
    this.#next();
  }

  async idle(): Promise<void> {
    while (this.#running.size > 0 || this.#waiting.length > 0) await Promise.all([...this.#running]);
  }

  #next(): void {
    while (this.#running.size < this.#concurrency) {
      const work = this.#waiting.shift();
      if (!work) return;
      const run = work()
        .catch(() => undefined)
        .finally(() => {
          this.#running.delete(run);
          this.#next();
        });
      this.#running.add(run);
    }
  }
}
