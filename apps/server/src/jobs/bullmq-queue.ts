import { ToolDropError } from '@tooldrop/core';
import type { JobQueue, QueuedJob } from '@tooldrop/engine';
import { Queue, Worker } from 'bullmq';

// The job queue on Valkey, for self-hosted toolDrop (SPEC, Queue;
// DECISIONS.md, D-010 and D-052). Every process that shares the database and
// the Valkey server takes jobs from it, and jobs waiting in it survive a
// restart. Valkey holds only job IDs; the jobs themselves are database rows.

export interface BullMqQueueOptions {
  /** The Valkey server, such as redis://valkey:6379. */
  url: string;
  /** Jobs this process runs at once (default 1). */
  concurrency?: number;
  /** The prefix of the queue's keys (default "tooldrop"); tests use their own. */
  prefix?: string;
  /** Whether this process takes jobs (default true). One-shot commands only add them. */
  worker?: boolean;
}

/** How long connecting may take before toolDrop says Valkey cannot be reached. */
const READY_MS = 10_000;

export class BullMqQueue implements JobQueue {
  readonly durable = true;
  readonly #name: string;
  readonly #options: BullMqQueueOptions;
  readonly #queue: Queue<QueuedJob>;
  readonly #running = new Set<Promise<void>>();
  #worker: Worker<QueuedJob> | undefined;

  /** Opens a queue, failing with a clear error when Valkey cannot be reached. */
  static async connect(name: string, options: BullMqQueueOptions): Promise<BullMqQueue> {
    const queue = new BullMqQueue(name, options);
    try {
      await withTimeout(queue.#queue.waitUntilReady(), READY_MS);
    } catch {
      void queue.close().catch(() => undefined);
      // The URL may hold a password, so the error never repeats it.
      throw new ToolDropError('internal', 'cannot reach the Valkey server in TOOLDROP_VALKEY_URL');
    }
    return queue;
  }

  constructor(name: string, options: BullMqQueueOptions) {
    this.#name = name;
    this.#options = options;
    this.#queue = new Queue<QueuedJob>(name, {
      connection: { url: options.url },
      prefix: options.prefix ?? 'tooldrop',
    });
    // The client reconnects by itself; a lost connection must not end the process.
    this.#queue.on('error', () => undefined);
  }

  process(run: (job: QueuedJob) => Promise<void>): void {
    if (this.#options.worker === false) return;
    if (this.#worker) throw new ToolDropError('internal', `the ${this.#name} queue already has a worker`);
    this.#worker = new Worker<QueuedJob>(
      this.#name,
      async (job) => {
        const running = run(job.data);
        this.#running.add(running);
        try {
          await running;
        } finally {
          this.#running.delete(running);
        }
      },
      {
        // A worker waits on Valkey with blocking commands, which must never give up.
        connection: { url: this.#options.url, maxRetriesPerRequest: null },
        prefix: this.#options.prefix ?? 'tooldrop',
        concurrency: this.#options.concurrency ?? 1,
      },
    );
    this.#worker.on('error', () => undefined);
  }

  async enqueue(job: QueuedJob): Promise<void> {
    // Keyed by the job's ID, so a job waits once however often it is added. Ended jobs are removed:
    // how a job went is in the database.
    await this.#queue.add(job.kind, job, { jobId: job.id, removeOnComplete: true, removeOnFail: true });
  }

  async idle(): Promise<void> {
    while (this.#running.size > 0) await Promise.allSettled([...this.#running]);
  }

  /**
   * Stops taking jobs, without waiting for the ones running here. A job cut
   * short when the process ends is failed as abandoned (Builds.view).
   */
  async close(): Promise<void> {
    await this.#worker?.close(true);
    await this.#queue.close();
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
