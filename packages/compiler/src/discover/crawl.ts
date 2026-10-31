import type { StorageState } from '@tooldrop/runtime';
import { chromium, type Browser, type Response } from 'playwright';

// URL-first discovery, step 1 (SPEC, Differentiating features): walk the
// signed-in site from one URL and note what each page offers: tables, forms,
// links and the JSON its scripts load. Only links are followed: nothing is
// clicked, no form is sent, and sign-out and delete links are left alone.
// The notes keep the structure (column names, field labels, JSON keys and
// types), never the data on the page.

export interface CrawledTable {
  columns: string[];
  rows: number;
}

export interface CrawledField {
  name: string;
  label?: string;
  type: string;
  /** A select's choices, the first ten. */
  options?: string[];
}

export interface CrawledForm {
  /** Where it submits, relative to the site. */
  action: string;
  method: 'get' | 'post';
  fields: CrawledField[];
  submit?: string;
}

export interface CrawledApi {
  method: string;
  /** The path, relative to the site, without its query. */
  path: string;
  status: number;
  /** The JSON's keys and types, never its values. */
  shape: string;
}

export interface CrawledPage {
  /** Relative to the site, with its query. */
  url: string;
  title: string;
  headings: string[];
  tables: CrawledTable[];
  forms: CrawledForm[];
  /** Links to other pages of the site. */
  links: { text: string; url: string }[];
  apis: CrawledApi[];
}

export interface CrawlOptions {
  browser?: Browser;
  /** A signed-in session for the site. */
  storageState?: StorageState;
  /** Most pages visited (default 12). */
  maxPages?: number;
  /** Most pages per path, however their queries differ (default 2). */
  perPath?: number;
  /** How long a page may take to load (default 10 s). */
  waitMs?: number;
  /** Called as each page is visited. */
  onPage?: (url: string) => void;
}

/** Links a crawl never follows: they sign out, delete or download. */
const AVOID = /log\s*-?\s*out|sign\s*-?\s*out|logoff|delete|remove|destroy|unsubscribe|cancel/i;
const DOWNLOAD = /\.(pdf|zip|csv|xlsx?|docx?|png|jpe?g|gif|svg|mp4|mp3)$/i;

export async function crawlSite(
  start: string,
  options: CrawlOptions = {},
): Promise<{ site: string; pages: CrawledPage[] }> {
  const site = new URL(start).origin;
  const maxPages = options.maxPages ?? 12;
  const perPath = options.perPath ?? 2;
  const waitMs = options.waitMs ?? 10_000;
  const browser = options.browser ?? (await chromium.launch());
  const context = await browser.newContext(
    options.storageState ? { storageState: options.storageState } : {},
  );
  const pages: CrawledPage[] = [];
  const queue = [new URL(start).href];
  const seen = new Set<string>();
  const byPath = new Map<string, number>();
  try {
    while (queue.length > 0 && pages.length < maxPages) {
      const next = new URL(queue.shift() ?? '');
      next.hash = '';
      if (seen.has(next.href)) continue;
      seen.add(next.href);
      if ((byPath.get(next.pathname) ?? 0) >= perPath) continue;

      const page = await context.newPage();
      const apis: CrawledApi[] = [];
      const reading: Promise<void>[] = [];
      page.on('response', (response) => reading.push(noteApi(response, site, apis)));
      try {
        options.onPage?.(relative(next, site));
        await page.goto(next.href, { waitUntil: 'domcontentloaded', timeout: waitMs });
        // Scripts that load data on open get a moment to do it.
        await page
          .waitForLoadState('networkidle', { timeout: Math.min(waitMs, 5_000) })
          .catch(() => undefined);
        await Promise.all(reading);
        const landed = new URL(page.url());
        // A redirect to another site, or to a page already seen, adds nothing.
        if (landed.origin !== site || (landed.href !== next.href && seen.has(landed.href))) continue;
        seen.add(landed.href);
        byPath.set(landed.pathname, (byPath.get(landed.pathname) ?? 0) + 1);
        const found = await page.evaluate(readPage);
        const links = found.links
          .map((link) => ({ text: link.text, url: new URL(link.href, landed) }))
          .filter(
            ({ text, url }) =>
              url.origin === site &&
              (url.protocol === 'http:' || url.protocol === 'https:') &&
              !AVOID.test(text) &&
              !AVOID.test(url.pathname) &&
              !DOWNLOAD.test(url.pathname),
          );
        for (const { url } of links) queue.push(url.href);
        pages.push({
          url: relative(landed, site),
          title: found.title,
          headings: found.headings,
          tables: found.tables,
          forms: found.forms.map((form) => ({
            ...form,
            action: relative(new URL(form.action || landed.href, landed), site),
          })),
          links: dedupe(links.map(({ text, url }) => ({ text, url: relative(url, site) }))).slice(0, 30),
          apis: dedupeApis(apis),
        });
      } catch {
        // A page that does not load is left out.
      } finally {
        await page.close();
      }
    }
  } finally {
    await context.close();
    if (!options.browser) await browser.close();
  }
  return { site, pages };
}

/** Notes a same-site JSON response: its method, path, status and shape. */
async function noteApi(response: Response, site: string, apis: CrawledApi[]): Promise<void> {
  try {
    const url = new URL(response.url());
    if (url.origin !== site) return;
    if (!(response.headers()['content-type'] ?? '').includes('json')) return;
    const body: unknown = await response.json();
    apis.push({
      method: response.request().method(),
      path: url.pathname,
      status: response.status(),
      shape: jsonTypes(body),
    });
  } catch {
    // A body that is gone or not JSON after all is left out.
  }
}

/** JSON as keys and types only: `{ items: [{ number: string, amount: number }], hasMore: boolean }`. */
export function jsonTypes(value: unknown, depth = 0): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return depth >= 4 ? '[…]' : `[${jsonTypes(value[0], depth + 1)}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    if (depth >= 4) return '{…}';
    const shown = entries.slice(0, 20).map(([key, item]) => `${key}: ${jsonTypes(item, depth + 1)}`);
    if (entries.length > 20) shown.push(`…${entries.length - 20} more`);
    return `{ ${shown.join(', ')} }`;
  }
  return typeof value;
}

function relative(url: URL, site: string): string {
  return url.href.startsWith(site) ? url.href.slice(site.length) || '/' : url.href;
}

function dedupe<T extends { url: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => !seen.has(item.url) && seen.add(item.url));
}

function dedupeApis(apis: CrawledApi[]): CrawledApi[] {
  const seen = new Set<string>();
  return apis.filter((api) => {
    const key = `${api.method} ${api.path}`;
    return !seen.has(key) && seen.add(key);
  });
}

/** Runs in the page: its title, headings, tables, forms and links, without the data in them. */
function readPage() {
  const text = (element: Element | null | undefined) =>
    (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const labelOf = (field: Element): string | undefined => {
    const id = field.getAttribute('id');
    const byFor = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
    const wrapping = field.closest('label');
    const label = text(byFor) || (wrapping ? text(wrapping).replace(text(field), '').trim() : '');
    return label || field.getAttribute('aria-label') || field.getAttribute('placeholder') || undefined;
  };
  return {
    title: document.title,
    headings: [...document.querySelectorAll('h1, h2, h3')].map(text).filter(Boolean).slice(0, 8),
    tables: [...document.querySelectorAll('table')].slice(0, 5).map((table) => {
      const head = table.querySelectorAll('thead th');
      const cells = head.length > 0 ? head : (table.querySelector('tr')?.querySelectorAll('th, td') ?? []);
      return {
        columns: [...cells].map(text).filter(Boolean).slice(0, 15),
        rows: table.querySelectorAll('tbody tr').length,
      };
    }),
    forms: [...document.querySelectorAll('form')].slice(0, 5).map((form) => ({
      action: form.getAttribute('action') ?? '',
      method:
        (form.getAttribute('method') ?? 'get').toLowerCase() === 'post'
          ? ('post' as const)
          : ('get' as const),
      fields: [...form.querySelectorAll('input, select, textarea')]
        .filter((field) => !['hidden', 'submit', 'button'].includes(field.getAttribute('type') ?? ''))
        .slice(0, 15)
        .map((field) => {
          const label = labelOf(field);
          const options =
            field instanceof HTMLSelectElement
              ? [...field.options]
                  .map((option) => option.value)
                  .filter(Boolean)
                  .slice(0, 10)
              : undefined;
          return {
            name: field.getAttribute('name') ?? '',
            ...(label && { label }),
            type:
              field instanceof HTMLSelectElement
                ? 'select'
                : (field.getAttribute('type') ?? field.tagName.toLowerCase()),
            ...(options && { options }),
          };
        }),
      submit: text(form.querySelector('button, input[type=submit]')) || undefined,
    })),
    links: [...document.querySelectorAll('a[href]')]
      .filter((link) => !link.hasAttribute('download'))
      .slice(0, 200)
      .map((link) => ({ text: text(link), href: link.getAttribute('href') ?? '' })),
  };
}
