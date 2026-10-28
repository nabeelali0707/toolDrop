import {
  recordingSchema,
  ToolDropError,
  type MarkedInput,
  type RecordedAction,
  type Recording,
} from '@tooldrop/core';
import type { StorageState } from '@tooldrop/runtime';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { installPageHelpers } from '../capture/page-helpers.ts';
import { addRecorderEvent, valueActions } from './assemble.ts';
import { installRecorder, RECORDER_BINDING, type RecorderEvent } from './recorder-page.ts';

// `tooldrop record` (DECISIONS.md, D-016): a browser window where a person
// does the task once. Clicks, typed values and picks are kept with ranked
// selectors, never what goes into a password field; the person marks the
// data with the toolDrop bar and names the inputs at the end.

export interface RecorderOptions {
  /** Tests record headless and drive the page themselves. */
  headless?: boolean;
  browser?: Browser;
  /** A signed-in session for the site, so the window opens signed in (SPEC, Authentication). */
  storageState?: StorageState;
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
    const context = await browser.newContext({
      viewport: null,
      ...(options.storageState && { storageState: options.storageState }),
    });
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
  valueActions(): ReturnType<typeof valueActions> {
    return valueActions(this.actions);
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
    if (event.kind === 'finish') this.#finish();
    else addRecorderEvent(this, event);
  }
}
