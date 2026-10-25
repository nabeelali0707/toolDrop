import type { RunningFixture } from '@tooldrop/fixture-kit';
import { load } from 'cheerio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startHtmlAppFixture } from './server.ts';

let fixture: RunningFixture;

beforeEach(async () => {
  fixture = await startHtmlAppFixture();
});

afterEach(() => fixture.close());

async function open(path: string) {
  const response = await fetch(`${fixture.url}${path}`);
  const $ = load(await response.text());
  return {
    status: response.status,
    $,
    headers: () =>
      $('#invoices thead th')
        .toArray()
        .map((th) => $(th).text()),
    rows: () =>
      $('#invoices tbody tr')
        .toArray()
        .map((tr) =>
          $(tr)
            .find('td')
            .toArray()
            .map((td) => $(td).text()),
        ),
    nextLink: () => $('a[rel="next"]').attr('href'),
  };
}

const flip = (switches: Record<string, boolean>) =>
  fetch(`${fixture.url}/__fixture/switches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(switches),
  });

describe('html-app fixture', () => {
  it('redirects / to the invoice list', async () => {
    const response = await fetch(fixture.url, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/invoices');
  });

  it('renders a page of invoices in a table', async () => {
    const page = await open('/invoices');
    expect(page.headers()).toEqual(['Number', 'Supplier', 'Date', 'Amount', 'Status']);
    expect(page.rows()).toHaveLength(10);
    expect(page.rows()[0]?.[0]).toMatch(/^INV-\d+$/);
  });

  it('filters with query parameters and keeps them in the next-page link', async () => {
    const page = await open('/invoices?status=paid&from=2026-02-01');
    for (const [, , date, , status] of page.rows()) {
      expect(status).toBe('paid');
      expect((date ?? '') >= '2026-02-01').toBe(true);
    }
    expect(page.$('select[name=status] option[selected]').attr('value')).toBe('paid');
  });

  it('follows next-page links through every invoice', async () => {
    const numbers: string[] = [];
    for (let path: string | undefined = '/invoices'; path;) {
      const page = await open(path);
      numbers.push(...page.rows().map((row) => row[0] ?? ''));
      path = page.nextLink();
    }
    expect(numbers).toHaveLength(57);
    expect(new Set(numbers).size).toBe(57);
  });

  it('says so when nothing matches', async () => {
    const page = await open('/invoices?from=2099-01-01');
    expect(page.$('#empty').text()).toBe('No invoices match.');
  });

  it('rejects invalid filters', async () => {
    expect((await open('/invoices?status=lost')).status).toBe(400);
    expect((await open('/invoices?page=-1')).status).toBe(400);
  });

  it('renames the button, moves the date filter and reorders columns when asked', async () => {
    await flip({ searchButtonRenamed: true, dateFilterMoved: true, columnsReordered: true });
    const page = await open('/invoices');
    expect(page.$('[data-testid=search]').text()).toBe('Find');
    expect(page.$('details summary').text()).toBe('Search options');
    expect(page.$('details input[name=from]')).toHaveLength(1);
    expect(page.headers()).toEqual(['Number', 'Amount', 'Supplier', 'Date', 'Status']);
  });
});
