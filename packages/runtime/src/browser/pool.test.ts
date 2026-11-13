import type { Browser, BrowserContext } from 'playwright';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserPool } from './pool.ts';

// Playwright is replaced, so these tests need no Chromium: they are about what the pool keeps.
const launch = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
vi.mock('playwright', () => ({ chromium: { launch } }));

/** A browser that can be made to crash, like Chromium being killed. */
function fakeBrowser() {
  const handlers: (() => void)[] = [];
  const browser = {
    on: (event: string, handler: () => void) => {
      if (event === 'disconnected') handlers.push(handler);
    },
    newContext: vi.fn(() =>
      Promise.resolve({ close: vi.fn(() => Promise.resolve()) } as unknown as BrowserContext),
    ),
    close: vi.fn(() => Promise.resolve()),
  };
  return {
    browser: browser as unknown as Browser,
    crash: () => handlers.forEach((handler) => handler()),
    mock: browser,
  };
}

// A block, not an arrow's value: Vitest runs a function returned from beforeEach as a cleanup.
beforeEach(() => {
  launch.mockReset();
});

describe('BrowserPool', () => {
  it('keeps one warm context per site while the browser lives', async () => {
    const { browser } = fakeBrowser();
    launch.mockResolvedValue(browser);
    const pool = new BrowserPool();
    expect(await pool.context('a')).toBe(await pool.context('a'));
    await pool.context('b');
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('tries again after Chromium failed to start, so installing it fixes a running server', async () => {
    const { browser } = fakeBrowser();
    launch.mockRejectedValueOnce(new Error('Executable does not exist')).mockResolvedValue(browser);
    const pool = new BrowserPool();
    await expect(pool.context('a')).rejects.toThrow('Executable does not exist');
    await expect(pool.context('a')).resolves.toBeDefined();
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('starts a new browser, with new contexts, after the old one crashed', async () => {
    const first = fakeBrowser();
    const second = fakeBrowser();
    launch.mockResolvedValueOnce(first.browser).mockResolvedValueOnce(second.browser);
    const pool = new BrowserPool();
    const before = await pool.context('a');
    first.crash();
    const after = await pool.context('a');
    expect(after).not.toBe(before);
    expect(second.mock.newContext).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('closes and forgets without error when the browser never started', async () => {
    launch.mockRejectedValue(new Error('no browser'));
    const pool = new BrowserPool();
    await pool.context('a').catch(() => undefined);
    await expect(pool.forget('a')).resolves.toBeUndefined();
    await expect(pool.close()).resolves.toBeUndefined();
  });

  it('does not treat its own close() as a crash', async () => {
    const first = fakeBrowser();
    const second = fakeBrowser();
    launch.mockResolvedValueOnce(first.browser).mockResolvedValueOnce(second.browser);
    const pool = new BrowserPool();
    await pool.context('a');
    await pool.close();
    first.crash();
    await pool.context('a');
    expect(launch).toHaveBeenCalledTimes(2);
    expect(second.mock.newContext).toHaveBeenCalledTimes(1);
  });
});
