import {
  newId,
  ToolDropError,
  type MarkedInput,
  type RankedSelector,
  type RecordedAction,
  type Selector,
} from '@tooldrop/core';
import { toLocator, trackRequests } from '@tooldrop/runtime';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import type { Exchange } from './har.ts';
import { NetworkRecorder } from './network.ts';
import {
  installPageHelpers,
  REF_ATTRIBUTE,
  type PageHelpers,
  type PageSnapshot,
  type TargetData,
} from './page-helpers.ts';

// A browser session that records everything a build needs (SPEC, Build
// pipeline step 3): the network with bodies, accessibility snapshots, the
// actions taken with ranked selectors, the inputs and the data on screen.
// The explore agent drives it by ref; a recording replays into it.

/** Actions are recorded in the recording format, so a capture can be saved as a recording. */
export type CaptureAction = RecordedAction;

/** The element holding the data the tool returns, and what it held. */
export interface CaptureTarget {
  selector: RankedSelector;
  label: string;
  data: TargetData;
}

export interface Capture {
  id: string;
  start_url: string;
  final_url: string;
  started_at: number;
  actions: CaptureAction[];
  inputs: MarkedInput[];
  target?: CaptureTarget;
  exchanges: Exchange[];
  snapshots: PageSnapshot[];
  /** The page's HTML when the capture finished. */
  final_html: string;
}

export interface CaptureOptions {
  /** Show the browser window, as `tooldrop record` does. */
  headed?: boolean;
  /** How long an action may wait for its element (default 10 s). */
  waitMs?: number;
  /** Reuse a running browser instead of launching one. */
  browser?: Browser;
}

type HelperWindow = Window & { __tooldrop?: PageHelpers };

const MAX_SELECTORS = 4;

export class CaptureSession {
  readonly id = newId();
  readonly page: Page;
  readonly actions: CaptureAction[] = [];
  readonly inputs: MarkedInput[] = [];
  readonly snapshots: PageSnapshot[] = [];
  target: CaptureTarget | undefined;
  readonly #context: BrowserContext;
  readonly #ownedBrowser: Browser | undefined;
  readonly #network: NetworkRecorder;
  readonly #settle: () => Promise<void>;
  readonly #waitMs: number;
  readonly #startUrl: string;

  private constructor(
    page: Page,
    context: BrowserContext,
    startUrl: string,
    options: CaptureOptions,
    ownedBrowser: Browser | undefined,
  ) {
    this.page = page;
    this.#context = context;
    // Context events cover the page already open, which has made no requests yet.
    this.#network = new NetworkRecorder(context, () => this.actions.length);
    this.#settle = trackRequests(page);
    this.#waitMs = options.waitMs ?? 10_000;
    this.#startUrl = startUrl;
    this.#ownedBrowser = ownedBrowser;
  }

  /** Opens a fresh browser context and loads the start page. */
  static async start(url: string, options: CaptureOptions = {}): Promise<CaptureSession> {
    const owned = options.browser ? undefined : await chromium.launch({ headless: !options.headed });
    const browser = options.browser ?? owned;
    if (!browser) throw new ToolDropError('internal', 'no browser to capture with');
    const context = await browser.newContext();
    await context.addInitScript(installPageHelpers);
    const page = await context.newPage();
    const session = new CaptureSession(page, context, url, options, owned);
    await session.goto(url);
    return session;
  }

  /** The pruned accessibility tree of the page as it is now. */
  async snapshot(maxNodes = 300): Promise<PageSnapshot> {
    await this.#helpers();
    const snapshot = await this.page.evaluate(
      (max) =>
        (window as HelperWindow).__tooldrop?.snapshot(max) ?? { url: location.href, title: '', nodes: [] },
      maxNodes,
    );
    this.snapshots.push(snapshot);
    return snapshot;
  }

  async goto(url: string): Promise<void> {
    const response = await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.#waitMs });
    if (response && response.status() >= 400) {
      throw new ToolDropError('strategy_failed', `${url} answered ${response.status()}`);
    }
    await this.#settle();
    this.actions.push({ kind: 'goto', url: this.page.url() });
  }

  async click(ref: string): Promise<void> {
    const { target, label } = await this.#describe(ref);
    await this.#byRef(ref).click({ timeout: this.#waitMs });
    await this.#settle();
    this.actions.push({ kind: 'click', target, label });
  }

  /** Types into a field. `input` marks the value as a tool input. */
  async fill(ref: string, value: string, input?: { name: string; description?: string }): Promise<void> {
    const { target, label, type } = await this.#describe(ref);
    const element = this.#byRef(ref);
    await element.fill(value, { timeout: this.#waitMs });
    const secret = type === 'password';
    this.actions.push({
      kind: 'fill',
      target,
      label,
      value: secret ? null : value,
      ...(secret && { secret }),
    });
    if (input && !secret) this.markInput(this.actions.length - 1, input.name, input.description);
  }

  /** Picks an option by value or by its visible text. */
  async select(ref: string, option: string, input?: { name: string; description?: string }): Promise<void> {
    const { target, label, options } = await this.#describe(ref);
    const element = this.#byRef(ref);
    const match =
      options.find((o) => o.value === option) ??
      options.find((o) => o.label.toLowerCase() === option.toLowerCase());
    if (!match) {
      throw new ToolDropError(
        'invalid_input',
        `${label} has no option "${option}"; options: ${options.map((o) => o.label).join(', ')}`,
      );
    }
    await element.selectOption(match.value, { timeout: this.#waitMs });
    await this.#settle();
    this.actions.push({ kind: 'select', target, label, value: match.value, options });
    if (input) this.markInput(this.actions.length - 1, input.name, input.description);
  }

  /** Marks the value of a fill or select action as a tool input. */
  markInput(action: number, name: string, description?: string): void {
    const recorded = this.actions[action];
    if (!recorded || (recorded.kind !== 'fill' && recorded.kind !== 'select') || recorded.value === null) {
      throw new ToolDropError('invalid_input', `action ${action} has no value to turn into an input`);
    }
    if (this.inputs.some((input) => input.name === name)) {
      throw new ToolDropError('invalid_input', `there is already an input named ${name}`);
    }
    this.inputs.push({ name, action, example: recorded.value, ...(description && { description }) });
  }

  /** Marks the element holding the data the tool returns: a table, a list, or text. */
  async markTarget(ref: string): Promise<CaptureTarget> {
    await this.#helpers();
    const extracted = await this.page.evaluate((r) => (window as HelperWindow).__tooldrop?.extract(r), ref);
    if (!extracted) throw new ToolDropError('invalid_input', `no element ${ref} on the page`);
    const { target, label } = await this.#describe(extracted.ref);
    this.target = { selector: target, label, data: extracted.data };
    return this.target;
  }

  /**
   * Finds the element a ranked selector points to, as the runtime would, and
   * returns its ref, so a recorded action can be replayed by ref.
   */
  async refFor(selector: RankedSelector): Promise<string> {
    await this.#helpers();
    for (const [index, candidate] of selector.entries()) {
      const locator = toLocator(this.page, candidate).first();
      try {
        await locator.waitFor({ state: 'attached', timeout: index === 0 ? this.#waitMs : 1_000 });
        const ref = await locator.evaluate((element) => (window as HelperWindow).__tooldrop?.refFor(element));
        if (ref) return ref;
      } catch {
        // Try the next selector.
      }
    }
    throw new ToolDropError('strategy_failed', `no element matches ${JSON.stringify(selector[0])}`);
  }

  /** Stops recording and returns everything captured. */
  async finish(): Promise<Capture> {
    await this.#network.settle();
    const finalHtml = await this.page.content().catch(() => '');
    const finalUrl = this.page.url();
    await this.#context.close();
    await this.#ownedBrowser?.close();
    return {
      id: this.id,
      start_url: this.#startUrl,
      final_url: finalUrl,
      started_at: this.#network.startedAt,
      actions: this.actions,
      inputs: this.inputs,
      ...(this.target && { target: this.target }),
      exchanges: this.#network.exchanges,
      snapshots: this.snapshots,
      final_html: finalHtml,
    };
  }

  /** Closes the browser without returning anything, e.g. when the build fails. */
  async abort(): Promise<void> {
    await this.#context.close().catch(() => undefined);
    await this.#ownedBrowser?.close().catch(() => undefined);
  }

  #byRef(ref: string): Locator {
    return this.page.locator(`[${REF_ATTRIBUTE}="${ref.replace(/[^A-Za-z0-9_-]/g, '')}"]`);
  }

  async #helpers(): Promise<void> {
    await this.page.evaluate(installPageHelpers);
  }

  /** What an element is, and the ranked selectors that find it, checked on the live page. */
  async #describe(ref: string) {
    await this.#helpers();
    const info = await this.page.evaluate((r) => (window as HelperWindow).__tooldrop?.info(r), ref);
    if (!info) throw new ToolDropError('invalid_input', `no element ${ref} on the page`);
    const target: Selector[] = [];
    for (const candidate of info.candidates) {
      if (target.length >= MAX_SELECTORS) break;
      if (await this.#pointsAt(candidate, ref)) target.push(candidate);
    }
    if (target.length === 0) {
      throw new ToolDropError('internal', `no selector finds the ${info.role || info.tag} "${info.name}"`);
    }
    const label = info.name ? `${info.role || info.tag} "${info.name}"` : info.role || info.tag;
    const ranked: RankedSelector = target;
    return { target: ranked, label, type: info.type, options: info.options ?? [] };
  }

  /** Whether the runtime, resolving this selector, would act on the element with this ref. */
  async #pointsAt(selector: Selector, ref: string): Promise<boolean> {
    try {
      return await toLocator(this.page, selector)
        .first()
        .evaluate((element, wanted) => element.getAttribute('data-tooldrop-ref') === wanted, ref, {
          timeout: 1_000,
        });
    } catch {
      return false;
    }
  }
}
