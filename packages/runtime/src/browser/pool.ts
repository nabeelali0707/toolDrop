import { chromium, type Browser, type BrowserContext } from 'playwright';

/**
 * Warm Playwright contexts, one per site (SPEC, Browser pool). A context keeps
 * the site's cookies and storage between calls, and contexts never share them.
 * Chromium starts on first use.
 */
export class BrowserPool {
  #browser: Promise<Browser> | undefined;
  readonly #contexts = new Map<string, Promise<BrowserContext>>();

  context(siteKey: string): Promise<BrowserContext> {
    let context = this.#contexts.get(siteKey);
    if (!context) {
      this.#browser ??= chromium.launch({ headless: true });
      context = this.#browser.then((browser) => browser.newContext());
      this.#contexts.set(siteKey, context);
    }
    return context;
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
}
