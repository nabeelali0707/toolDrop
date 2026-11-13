import { chromium, type Browser, type BrowserContext } from 'playwright';

/** Cookies and local storage, as Playwright saves and restores them. */
export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

/**
 * Warm Playwright contexts, one per site (SPEC, Browser pool). A context keeps
 * the site's cookies and storage between calls, and contexts never share them.
 * A site with a saved session starts its context from it. Chromium starts on
 * first use.
 */
export class BrowserPool {
  #browser: Promise<Browser> | undefined;
  readonly #contexts = new Map<string, Promise<BrowserContext>>();
  readonly #states = new Map<string, StorageState>();

  context(siteKey: string): Promise<BrowserContext> {
    let context = this.#contexts.get(siteKey);
    if (!context) {
      const state = this.#states.get(siteKey);
      const made = this.#launch().then((browser) => browser.newContext(state ? { storageState: state } : {}));
      context = made;
      this.#contexts.set(siteKey, made);
      // A context that could not be made is not kept: the next call tries again.
      made.catch(() => {
        if (this.#contexts.get(siteKey) === made) this.#contexts.delete(siteKey);
      });
    }
    return context;
  }

  /** A context that shares nothing with the warm ones, e.g. to sign in. The caller closes it. */
  fresh(): Promise<BrowserContext> {
    return this.#launch().then((browser) => browser.newContext());
  }

  /** Starts the site's contexts from a saved session from now on. */
  async useState(siteKey: string, state: StorageState): Promise<void> {
    this.#states.set(siteKey, state);
    await this.forget(siteKey);
  }

  /** Drops a site's context, e.g. when its session is no longer valid. */
  async forget(siteKey: string): Promise<void> {
    const context = this.#contexts.get(siteKey);
    this.#contexts.delete(siteKey);
    // A context that never opened has nothing to close.
    await (await context?.catch(() => undefined))?.close();
  }

  async close(): Promise<void> {
    const browser = this.#browser;
    this.#browser = undefined;
    this.#contexts.clear();
    await (await browser?.catch(() => undefined))?.close();
  }

  #launch(): Promise<Browser> {
    if (!this.#browser) {
      const launching = chromium.launch({ headless: true });
      this.#browser = launching;
      launching.then(
        (browser) =>
          browser.on('disconnected', () => {
            // The browser died (killed, out of memory): its contexts died with it, and the next call
            // starts a new browser. close() has already forgotten it, so this only fires for a crash.
            if (this.#browser !== launching) return;
            this.#browser = undefined;
            this.#contexts.clear();
          }),
        () => {
          // Chromium would not start, e.g. it is not installed yet: the next call tries again,
          // so installing it fixes a running server without a restart.
          if (this.#browser === launching) this.#browser = undefined;
        },
      );
    }
    return this.#browser;
  }
}
