/** A site's limits (SPEC, Performance rules). Stored on the site; these are the defaults. */
export interface RateLimit {
  /** Sustained requests per second. */
  per_second: number;
  /** Requests in flight at once. */
  concurrency: number;
  /** Requests allowed back to back before the sustained rate applies. */
  burst?: number;
}

export const DEFAULT_RATE_LIMIT: Required<RateLimit> = { per_second: 1, concurrency: 2, burst: 5 };

/**
 * Keeps toolDrop gentle with a site: a token bucket for the request rate and a
 * semaphore for concurrency. Short recipes (fetch a token, then the data) run
 * without waiting; long page loops settle at the sustained rate.
 */
export class SiteLimiter {
  readonly #rate: number;
  readonly #capacity: number;
  readonly #concurrency: number;
  #tokens: number;
  #refilledAt = Date.now();
  #active = 0;
  readonly #waiting: (() => void)[] = [];
  #queue: Promise<void> = Promise.resolve();

  constructor(limit: RateLimit = DEFAULT_RATE_LIMIT) {
    this.#rate = limit.per_second;
    this.#capacity = Math.max(1, limit.burst ?? DEFAULT_RATE_LIMIT.burst);
    this.#concurrency = Math.max(1, limit.concurrency);
    this.#tokens = this.#capacity;
  }

  /** Runs `task` once a token and a concurrency slot are free. */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.#takeToken();
    await this.#takeSlot();
    try {
      return await task();
    } finally {
      this.#active--;
      this.#waiting.shift()?.();
    }
  }

  #takeToken(): Promise<void> {
    // Chained, so callers get tokens in the order they asked.
    const turn = this.#queue.then(async () => {
      this.#refill();
      if (this.#tokens < 1) {
        await new Promise((resolve) => setTimeout(resolve, ((1 - this.#tokens) / this.#rate) * 1000));
        this.#refill();
      }
      this.#tokens -= 1;
    });
    this.#queue = turn.catch(() => undefined);
    return turn;
  }

  #refill(): void {
    const now = Date.now();
    this.#tokens = Math.min(this.#capacity, this.#tokens + ((now - this.#refilledAt) / 1000) * this.#rate);
    this.#refilledAt = now;
  }

  async #takeSlot(): Promise<void> {
    if (this.#active >= this.#concurrency) await new Promise<void>((resolve) => this.#waiting.push(resolve));
    this.#active++;
  }
}
