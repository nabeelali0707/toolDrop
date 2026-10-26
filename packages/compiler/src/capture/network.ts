import type { BrowserContext, Request } from 'playwright';
import { isTextual, MAX_BODY, type Exchange } from './har.ts';

// Records the traffic of a browser context, with bodies (SPEC, Build pipeline
// step 3). Only documents and the page's own API calls are kept: images,
// fonts, styles and scripts never carry the data a tool returns.

const KEPT_TYPES = new Set(['document', 'xhr', 'fetch']);

export class NetworkRecorder {
  readonly exchanges: Exchange[] = [];
  readonly #startedAt = Date.now();
  readonly #pending = new Set<Promise<void>>();
  readonly #starts = new Map<Request, { index: number; started: number; after: number }>();
  #nextIndex = 0;
  #actions: () => number;

  /** `actions` says how many actions had happened when a request started. */
  constructor(context: BrowserContext, actions: () => number = () => 0) {
    this.#actions = actions;
    context.on('request', (request) => {
      if (!KEPT_TYPES.has(request.resourceType())) return;
      this.#starts.set(request, {
        index: this.#nextIndex++,
        started: Date.now() - this.#startedAt,
        after: this.#actions(),
      });
    });
    context.on('requestfinished', (request) => this.#track(this.#record(request)));
    context.on('requestfailed', (request) => this.#starts.delete(request));
  }

  get startedAt(): number {
    return this.#startedAt;
  }

  /** Waits for the bodies still being read. */
  async settle(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all([...this.#pending]);
    this.exchanges.sort((a, b) => a.index - b.index);
  }

  #track(work: Promise<void>): void {
    this.#pending.add(work);
    void work.finally(() => this.#pending.delete(work));
  }

  async #record(request: Request): Promise<void> {
    const start = this.#starts.get(request);
    if (!start) return;
    this.#starts.delete(request);
    try {
      const response = await request.response();
      if (!response) return;
      const responseHeaders = await response.allHeaders();
      const mimeType = (responseHeaders['content-type'] ?? '').split(';')[0]?.trim() ?? '';
      let body: string | undefined;
      if (isTextual(mimeType) && (response.status() < 300 || response.status() >= 400)) {
        body = (await response.body().catch(() => undefined))?.toString('utf8').slice(0, MAX_BODY);
      }
      const postData = request.postData();
      this.exchanges.push({
        index: start.index,
        started: start.started,
        method: request.method(),
        url: request.url(),
        resource_type: request.resourceType(),
        request_headers: await request.allHeaders(),
        ...(postData !== null && { request_body: postData }),
        status: response.status(),
        response_headers: responseHeaders,
        mime_type: mimeType,
        ...(body !== undefined && { response_body: body }),
        duration_ms: Math.max(0, Math.round(Date.now() - this.#startedAt - start.started)),
        after_actions: start.after,
      });
    } catch {
      // The page closed mid-request: nothing to keep.
    }
  }
}
