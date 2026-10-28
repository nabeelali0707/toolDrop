import { ToolDropError, type RankedSelector, type Step } from '@tooldrop/core';
import { load, type CheerioAPI } from 'cheerio';
import { gotScraping } from 'got-scraping';
import type { CookieJar } from 'tough-cookie';
import { evaluateCondition } from '../conditions.ts';
import { queryOne } from '../jsonpath.ts';
import type { SiteLimiter } from '../limits.ts';
import { atStep, columnIndexes, describeTarget, mapPages, samePage } from '../steps.ts';
import { render, renderText, stringify, type TemplateContext } from '../templates.ts';
import { isCommit, type WriteMode } from '../write.ts';

// Runs the strategies that need no browser: official_api, http_replay and
// html_fetch. Requests go through got-scraping, which sends browser-like
// headers; cookies persist in the site's jar between steps and calls.

type HttpStep = Extract<Step, { op: 'http' }>;

export interface HttpDeps {
  cookieJar: CookieJar;
  limiter: SiteLimiter;
  timeoutMs?: number;
  /** The sign-in page of a signed-in site: landing there means the session expired. */
  loginUrl?: string;
  /** Safe mode: describe the first commit request and stop, or send it. */
  write?: WriteMode;
}

interface State {
  /** Parsed bodies of the last http step: one per page. */
  pages: unknown[];
  result: unknown;
  produced: boolean;
}

export async function runHttpRecipe(
  steps: Step[],
  context: TemplateContext,
  deps: HttpDeps,
): Promise<unknown> {
  const state: State = { pages: [], result: undefined, produced: false };
  const write = deps.write;

  for (const [index, step] of steps.entries()) {
    if (write && step.op === 'http' && step.commit && write.record.action === undefined) {
      describeRequest(step, context, write);
      if (write.mode === 'preview') return undefined;
    }
    await atStep(index, step, async () => {
      switch (step.op) {
        case 'http':
          state.pages = await runHttpStep(step, context, deps);
          for (const [name, path] of Object.entries(step.save ?? {})) {
            context.vars[name] = queryOne(state.pages.at(-1), path);
          }
          return;
        case 'map':
          produce(state, context, step.save, mapPages(state.pages, step));
          return;
        case 'extract_text': {
          const $ = load(lastHtml(state));
          const nodes = $(cssFor($, step.target));
          const read = (node: Parameters<CheerioAPI>[0]) =>
            step.attribute ? ($(node).attr(step.attribute) ?? '') : $(node).text().trim();
          produce(state, context, step.save, step.all ? nodes.toArray().map(read) : read(nodes.first()));
          return;
        }
        case 'extract_table':
          produce(state, context, step.save, extractTable(load(lastHtml(state)), step));
          return;
        default:
          throw new ToolDropError('internal', `"${step.op}" needs a browser`);
      }
    });
    if (write && isCommit(step)) write.record.committed = true;
  }

  // A recipe without a data step returns what its last request returned.
  if (state.produced) return state.result;
  return state.pages.length === 1 ? state.pages[0] : state.pages;
}

function produce(state: State, context: TemplateContext, save: string | undefined, value: unknown): void {
  state.result = value;
  state.produced = true;
  if (save) context.vars[save] = value;
}

async function runHttpStep(step: HttpStep, context: TemplateContext, deps: HttpDeps): Promise<unknown[]> {
  if (!step.paginate) return [await send(step, context, deps)];

  const { var: name, until, start, step: increment = 1, from, max_pages = 50 } = step.paginate;
  const pages: unknown[] = [];
  let value: unknown = start;
  try {
    for (let page = 0; page < max_pages; page++) {
      context.loop = { [name]: value };
      const body = await send(step, context, deps);
      pages.push(body);
      // A page of HTML or text has no JSON to check the condition on: it is the only page.
      if (typeof body === 'string' || evaluateCondition(until, body)) break;
      value = from === undefined ? (value as number) + increment : queryOne(body, from);
      if (value === undefined || value === null) break;
    }
  } finally {
    context.loop = {};
  }
  return pages;
}

async function send(step: HttpStep, context: TemplateContext, deps: HttpDeps): Promise<unknown> {
  const url = renderText(step.url, context);
  const headers = asStrings(render(step.headers ?? {}, context));
  const searchParams = asStrings(render(step.query ?? {}, context));
  const body = step.body === undefined ? undefined : render(step.body, context);

  const response = await deps.limiter.run(() =>
    gotScraping({
      url,
      method: step.method,
      headers,
      searchParams,
      ...(body !== undefined && (step.body_format === 'form' ? { form: asStrings(body) } : { json: body })),
      cookieJar: deps.cookieJar,
      throwHttpErrors: false,
      followRedirect: true,
      retry: { limit: 0 },
      timeout: { request: deps.timeoutMs ?? 30_000 },
    }),
  );

  if (deps.loginUrl) {
    const rejected = response.statusCode === 401 || response.statusCode === 403;
    if (rejected || samePage(response.url, deps.loginUrl)) {
      throw new ToolDropError(
        'session_expired',
        'the session has expired: ' +
          step.method +
          ' ' +
          url +
          (rejected ? ' answered ' + response.statusCode : ' led to the sign-in page'),
        {
          details: { status: response.statusCode },
        },
      );
    }
  }
  if (response.statusCode >= 400) {
    throw new ToolDropError('strategy_failed', `${step.method} ${url} answered ${response.statusCode}`, {
      details: { status: response.statusCode },
    });
  }
  const type = String(response.headers['content-type'] ?? '');
  if (!type.includes('json')) return response.body;
  try {
    return JSON.parse(response.body) as unknown;
  } catch {
    throw new ToolDropError('strategy_failed', `${step.method} ${url} sent invalid JSON`);
  }
}

/** Header, query and form values go over the wire as strings. */
/**
 * A write request as its preview shows it, without sending it. Values the
 * recipe took from the site, such as a CSRF token, show as "[from the site]".
 */
function describeRequest(step: HttpStep, context: TemplateContext, write: WriteMode): void {
  const hidden = (values: Record<string, unknown>) =>
    Object.fromEntries(Object.keys(values).map((key) => [key, '[from the site]']));
  const shown: TemplateContext = { ...context, vars: hidden(context.vars), session: hidden(context.session) };
  const url = new URL(renderText(step.url, shown));
  for (const [name, value] of Object.entries(asStrings(render(step.query ?? {}, shown)))) {
    url.searchParams.set(name, value);
  }
  const body = step.body === undefined ? {} : render(step.body, shown);
  write.record.url = url.toString();
  write.record.action = `${step.method} ${url.toString()}`;
  write.record.fields =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? Object.entries(body).map(([field, value]) => ({ field, value: stringify(value) }))
      : [{ field: 'body', value: stringify(body) }];
}

function asStrings(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries((value ?? {}) as Record<string, unknown>)) {
    if (item !== undefined && item !== null) out[key] = stringify(item);
  }
  return out;
}

function lastHtml(state: State): string {
  const page = state.pages.at(-1);
  if (typeof page !== 'string') throw new ToolDropError('strategy_failed', 'the last response was not HTML');
  return page;
}

/** The first CSS or test-id selector that matches; HTML strategies have no browser for the others. */
function cssFor($: CheerioAPI, target: RankedSelector): string {
  for (const selector of target) {
    const css =
      selector.kind === 'css'
        ? selector.value
        : selector.kind === 'test_id'
          ? `[data-testid="${selector.value.replaceAll('"', '\\"')}"]`
          : undefined;
    if (css && $(css).length > 0) return css;
  }
  throw new ToolDropError('strategy_failed', `no element matches ${describeTarget(target)}`);
}

function extractTable($: CheerioAPI, step: Extract<Step, { op: 'extract_table' }>): Record<string, string>[] {
  const table = $(cssFor($, step.target)).first();
  const headerCells =
    table.find('thead th').length > 0 ? table.find('thead th') : table.find('tr').first().find('th');
  const indexes = columnIndexes(
    headerCells.toArray().map((cell) => $(cell).text()),
    step.columns,
  );
  const bodyRows = table.find('tbody tr').length > 0 ? table.find('tbody tr') : table.find('tr').slice(1);
  return bodyRows.toArray().map((row) => {
    const cells = $(row).find('td').toArray();
    const out: Record<string, string> = {};
    for (const [field, index] of Object.entries(indexes)) out[field] = $(cells[index]).text().trim();
    return out;
  });
}
