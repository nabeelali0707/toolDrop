import type { JobKind } from '@tooldrop/core';

// The job queue (SPEC, Queue): in-process locally, BullMQ on Valkey when
// self-hosted (DECISIONS.md, D-052). A queue carries job IDs only. The job
// itself, its input and its progress, is a row in the jobs table, so
// whichever process takes a job can run it.

/** A job to run: a row in the jobs table. */
export interface QueuedJob {
  id: string;
  kind: JobKind;
}

export interface JobQueue {
  /**
   * Whether waiting jobs are kept where every process sharing the database
   * can take them, and survive a restart. A job waiting in such a queue is
   * never taken for abandoned.
   */
  readonly durable: boolean;
  /** Starts taking jobs: `run` gets each job this process takes. */
  process(run: (job: QueuedJob) => Promise<void>): void;
  enqueue(job: QueuedJob): Promise<void>;
  /** Resolves once every job this process has taken has finished, and those still waiting here. */
  idle(): Promise<void>;
  /** Stops taking jobs. Jobs already running go on. */
  close(): Promise<void>;
}

export class InProcessQueue implements JobQueue {
  readonly durable = false;
  readonly #concurrency: number;
  readonly #waiting: QueuedJob[] = [];
  readonly #running = new Set<Promise<void>>();
  #run: ((job: QueuedJob) => Promise<void>) | undefined;
  #closed = false;

  /** Builds drive a browser and a model, so one at a time is the default. */
  constructor(concurrency = 1) {
    this.#concurrency = concurrency;
  }

  process(run: (job: QueuedJob) => Promise<void>): void {
    this.#run = run;
    this.#next();
  }

  enqueue(job: QueuedJob): Promise<void> {
    this.#waiting.push(job);
    this.#next();
    return Promise.resolve();
  }

  async idle(): Promise<void> {
    while (this.#running.size > 0 || (this.#waiting.length > 0 && this.#run && !this.#closed)) {
      await Promise.all([...this.#running]);
    }
  }

  close(): Promise<void> {
    this.#closed = true;
    return Promise.resolve();
  }

  #next(): void {
    const run = this.#run;
    while (run && !this.#closed && this.#running.size < this.#concurrency) {
      const job = this.#waiting.shift();
      if (!job) return;
      const running = run(job)
        .catch(() => undefined)
        .finally(() => {
          this.#running.delete(running);
          this.#next();
        });
      this.#running.add(running);
    }
  }
}
