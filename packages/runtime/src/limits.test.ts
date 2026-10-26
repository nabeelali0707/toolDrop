import { describe, expect, it } from 'vitest';
import { SiteLimiter } from './limits.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('SiteLimiter', () => {
  it('lets a burst through, then holds to the sustained rate', async () => {
    const limiter = new SiteLimiter({ per_second: 10, concurrency: 10, burst: 2 });
    const started = Date.now();
    await Promise.all(Array.from({ length: 4 }, () => limiter.run(() => Promise.resolve())));
    // 2 at once from the burst, then 2 more at 10 per second: about 200 ms.
    expect(Date.now() - started).toBeGreaterThanOrEqual(180);
  });

  it('caps how many tasks run at once', async () => {
    const limiter = new SiteLimiter({ per_second: 1000, concurrency: 2, burst: 1000 });
    let running = 0;
    let most = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        limiter.run(async () => {
          running++;
          most = Math.max(most, running);
          await sleep(20);
          running--;
        }),
      ),
    );
    expect(most).toBe(2);
  });
});
