import {
  recordingSchema,
  ToolDropError,
  type MarkedInput,
  type RecordedAction,
  type Recording,
} from '@tooldrop/core';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { installPageHelpers } from '../capture/page-helpers.ts';
import { installRecorder, RECORDER_BINDING, type RecorderEvent } from './recorder-page.ts';

// `tooldrop record` (DECISIONS.md, D-016): a browser window where a person
// does the task once. Clicks, typed values and picks are kept with ranked
// selectors, never what goes into a password field; the person marks the
// data with the toolDrop bar and names the inputs at the end.

export interface RecorderOptions {
  /** Tests record headless and drive the page themselves. */
  headless?: boolean;
  browser?: Browser;
}

export class Recorder {
  readonly page: Page;
  readonly actions: RecordedAction[];
  target: Recording['target'];
  readonly #context: BrowserContext;
  readonly #ownedBrowser: Browser | undefined;
  readonly #waiting: (() => void)[] = [];
  #closed = false;

  private constructor(page: Page, context: BrowserContext, url: string, ownedBrowser: Browser | undefined) {
    this.page = page;
    this.#context = context;
    this.#ownedBrowser = ownedBrowser;
    this.actions = [{ kind: 'goto', url }];
    page.on('close', () => {
      this.#closed = true;
      this.#finish();
    });
  }

  /** Whether the person closed the window. */
  get closed(): boolean {
    return this.#closed;
  }

  /** Resolves the next time the person clicks Finish, or when the window closes. */
  nextFinish(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    return new Promise((resolve) => this.#waiting.push(resolve));
  }

  #finish(): void {
    for (const resolve of this.#waiting.splice(0)) resolve();
  }

  static async start(url: string, options: RecorderOptions = {}): Promise<Recorder> {
    const owned = options.browser
      ? undefined
      : await chromium.launch({ headless: options.headless ?? false });
    const browser = options.browser ?? owned;
    if (!browser) throw new ToolDropError('internal', 'no browser to record with');
    const context = await browser.newContext({ viewport: null });
    await context.addInitScript(installPageHelpers);
    await context.addInitScript(installRecorder);
    const page = await context.newPage();
    const recorder = new Recorder(page, context, url, owned);
    await context.exposeBinding(RECORDER_BINDING, (_source, event: RecorderEvent) => recorder.#record(event));
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    recorder.actions[0] = { kind: 'goto', url: page.url() };
    return recorder;
  }

  /** The values typed or picked, which the person may turn into inputs. */
  valueActions(): { index: number; action: Extract<RecordedAction, { kind: 'fill' | 'select' }> }[] {
    return this.actions.flatMap((action, index) =>
      (action.kind === 'fill' && action.value !== null) || action.kind === 'select'
        ? [{ index, action }]
        : [],
    );
  }

  /** Closes the window and returns the recording. */
  async stop(inputs: MarkedInput[], task?: string): Promise<Recording> {
    await this.#context.close().catch(() => undefined);
    await this.#ownedBrowser?.close().catch(() => undefined);
    return recordingSchema.parse({
      version: 1,
      recorder: 'cli',
      recorded_at: Date.now(),
      ...(task !== undefined && { task }),
      actions: this.actions,
      inputs,
      ...(this.target && { target: this.target }),
    });
  }

  #record(event: RecorderEvent): void {
    if (event.kind === 'finish') {
      this.#finish();
      return;
    }
    const { info } = event;
    const label = info.name ? `${info.role || info.tag} "${info.name}"` : info.role || info.tag;
    if (info.candidates.length === 0) return;
    const target = info.candidates.slice(0, 8);
    if (event.kind === 'target') {
      this.target = { selector: target, label };
      return;
    }
    if (event.kind === 'click') {
      this.actions.push({ kind: 'click', target, label });
      return;
    }
    // A field edited twice in a row keeps its last value.
    const last = this.actions.at(-1);
    const sameField =
      last && last.kind === event.kind && JSON.stringify(last.target) === JSON.stringify(target);
    const action: RecordedAction =
      event.kind === 'select'
        ? { kind: 'select', target, label, value: event.value, options: info.options ?? [] }
        : { kind: 'fill', target, label, value: event.value, ...(event.value === null && { secret: true }) };
    if (sameField) this.actions[this.actions.length - 1] = action;
    else this.actions.push(action);
  }
}
