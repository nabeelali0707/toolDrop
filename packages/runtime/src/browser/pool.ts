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
      context = this.#launch().then((browser) => browser.newContext(state ? { storageState: state } : {}));
      this.#contexts.set(siteKey, context);
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
    await (await context)?.close();
  }

  async close(): Promise<void> {
    const browser = this.#browser;
    this.#browser = undefined;
    this.#contexts.clear();
    await (await browser)?.close();
  }

  #launch(): Promise<Browser> {
    this.#browser ??= chromium.launch({ headless: true });
    return this.#browser;
  }
}
