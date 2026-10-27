import { createInvoices, type RunningFixture } from '@tooldrop/fixture-kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startJsonApiFixture, supplierContact } from './server.ts';

let fixture: RunningFixture;

beforeEach(async () => {
  fixture = await startJsonApiFixture();
});

afterEach(() => fixture.close());

/** Opens the page like a browser: keeps the session cookie and reads the CSRF token. */
async function openSession() {
  const page = await fetch(fixture.url);
  const html = await page.text();
  const sid = /sid=([^;]+)/.exec(page.headers.get('set-cookie') ?? '')?.[1];
  const csrf = /<meta name="csrf-token" content="([^"]+)">/.exec(html)?.[1];
  if (!sid || !csrf) throw new Error('page did not set a session and CSRF token');

  const search = (body: Record<string, unknown> = {}, version = 'v2', token = csrf) =>
    fetch(`${fixture.url}/api/${version}/invoices/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `sid=${sid}`, 'x-csrf-token': token },
      body: JSON.stringify(body),
    });
  return { html, search };
}

interface SearchResult {
  items: { invoiceNo: string; issuedOn: string; total: { value: number; currency: string }; state: string }[];
  page: number;
  hasMore: boolean;
}

const flip = (switches: Record<string, boolean>) =>
  fetch(`${fixture.url}/__fixture/switches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(switches),
  });

describe('json-api fixture', () => {
  it('serves the page with a CSRF token and the script', async () => {
    const { html } = await openSession();
    expect(html).toContain('<button type="submit" data-testid="search">Search</button>');
    expect(html).toContain('<meta name="api-base" content="/api/v2">');
    expect((await fetch(`${fixture.url}/app.js`)).headers.get('content-type')).toContain('javascript');
  });

  it('answers the search in the shape of SPEC’s example recipe', async () => {
    const { search } = await openSession();
    const result = (await (await search({ page: 1 })).json()) as SearchResult;

    expect(result).toMatchObject({ page: 1, hasMore: true });
    expect(result.items).toHaveLength(10);
    // The API's names differ from ours, which is what the example's map step
    // ($.invoiceNo, $.total.value, $.state) translates.
    const [newest] = createInvoices();
    expect(result.items[0]).toEqual({
      invoiceNo: newest?.number,
      supplier: newest?.supplier,
      issuedOn: newest?.issued_on,
      total: { value: newest?.amount, currency: 'USD' },
      state: newest?.status,
      contact: supplierContact(newest?.supplier ?? ''),
    });
  });

  it('filters by status and date, and pages until hasMore is false', async () => {
    const { search } = await openSession();
    const seen: SearchResult['items'] = [];
    for (let page = 1; ; page++) {
      // Page as a string, the way a template value can arrive.
      const result = (await (
        await search({ status: 'open', from: '2026-02-01', page: String(page) })
      ).json()) as SearchResult;
      seen.push(...result.items);
      if (!result.hasMore) break;
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const item of seen) {
      expect(item.state).toBe('open');
      expect(item.issuedOn >= '2026-02-01').toBe(true);
    }
  });

  it('treats empty filters as "any", as the browser form sends them', async () => {
    const { search } = await openSession();
    const result = (await (await search({ status: '', from: '' })).json()) as SearchResult;
    expect(result.items).toHaveLength(10);
  });

  it('rejects requests without the session’s CSRF token', async () => {
    const { search } = await openSession();
    expect((await search({}, 'v2', 'wrong-token')).status).toBe(403);
  });

  it('rejects invalid filters', async () => {
    const { search } = await openSession();
    expect((await search({ status: 'lost' })).status).toBe(400);
    expect((await search({ page: 0 })).status).toBe(400);
  });

  it('moves the API to v3 when asked, which breaks replayed v2 requests', async () => {
    const { search } = await openSession();
    await flip({ apiMoved: true });

    expect((await search({}, 'v2')).status).toBe(410);
    expect((await search({}, 'v3')).status).toBe(200);
    expect((await openSession()).html).toContain('<meta name="api-base" content="/api/v3">');
  });

  it('renames the button and moves the date filter when asked', async () => {
    await flip({ searchButtonRenamed: true, dateFilterMoved: true });
    const { html } = await openSession();
    expect(html).toContain('data-testid="search">Find</button>');
    expect(html).toContain(
      '<details><summary>Search options</summary><label>From <input type="date" name="from"></label></details>',
    );
  });

  it('resets switches and sessions', async () => {
    const { search } = await openSession();
    await flip({ apiMoved: true });
    await fetch(`${fixture.url}/__fixture/reset`, { method: 'POST' });

    expect((await search({}, 'v2')).status).toBe(403);
    expect((await (await openSession()).search({}, 'v2')).status).toBe(200);
  });
});
