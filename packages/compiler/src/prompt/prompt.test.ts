import { createHtmlAppFixture } from '@tooldrop/fixture-html-app';
import { describe, expect, it } from 'vitest';
import type { Exchange } from '../capture/har.ts';
import type { PageSnapshot } from '../capture/page-helpers.ts';
import { formatSnapshot } from './ax-prune.ts';
import { requestFields, summarizeExchanges } from './har-summary.ts';
import { formatSubtree, htmlHoldsData } from './html-subtree.ts';
import { describeJson, SHAPE_LEVELS } from './json-shape.ts';

const snapshot: PageSnapshot = {
  url: 'http://127.0.0.1:4101/',
  title: 'Invoices',
  nodes: [
    { ref: 'e1', role: 'heading', name: 'Invoices', level: 1 },
    { ref: 'e2', role: 'link', name: 'Home', href: '/' },
    {
      ref: 'e3',
      role: 'combobox',
      name: 'Status',
      value: 'All',
      options: ['All', 'Open', 'Paid', 'Overdue', 'Draft'],
    },
    { ref: 'e4', role: 'textbox', name: 'Password', secret: true },
    { ref: 'e5', role: 'button', name: 'Search' },
    {
      ref: 'e6',
      role: 'table',
      name: '',
      columns: ['Number', 'Supplier', 'Date'],
      rows: 10,
      first: ['INV-1057', 'Cedar Office Supply', '2026-06-29'],
    },
  ],
};

describe('formatSnapshot', () => {
  it('lists one node per line, with its ref', () => {
    expect(formatSnapshot(snapshot)).toBe(
      [
        'Page: "Invoices" at http://127.0.0.1:4101/',
        '[e1] heading "Invoices" level=1',
        '[e2] link "Home" href=/',
        '[e3] combobox "Status" value="All" options=[All, Open, Paid, Overdue, Draft]',
        '[e4] textbox "Password" (password)',
        '[e5] button "Search"',
        '[e6] table columns=[Number, Supplier, Date] rows=10 first=[INV-1057, Cedar Office Supply, 2026-06-29]',
      ].join('\n'),
    );
  });

  it('prunes harder at each level, then stops', () => {
    const tight = formatSnapshot(snapshot, 2) ?? '';
    expect(tight).not.toContain('link');
    expect(tight).toContain('options=[All, Open, Paid, Overdue, +1 more]');
    expect(tight).toContain('first=[INV-1057, Cedar Office S…, 2026-06-29]');
    expect(formatSnapshot(snapshot, 3)).toBeUndefined();
  });
});

describe('describeJson', () => {
  const body = {
    items: [
      { invoiceNo: 'INV-1056', total: { value: 765.45, currency: 'USD' }, paid: true, note: null },
      { invoiceNo: 'INV-1052', total: { value: 448.69, currency: 'USD' }, paid: false, note: null },
    ],
    page: 1,
    hasMore: true,
  };

  it('shows keys, types and one sample', () => {
    expect(describeJson(body)).toBe(
      '{ items: [2 × { invoiceNo: "INV-1056", total: { value: 765.45, currency: "USD" }, paid: true, note: null }], page: 1, hasMore: true }',
    );
  });

  it('cuts strings, keys and depth at tighter levels', () => {
    const tight = { ...SHAPE_LEVELS[2]!, depth: 2 };
    expect(describeJson(body, tight)).toBe('{ items: [2 × {…}], page: 1, hasMore: true }');
    expect(describeJson({ text: 'a'.repeat(50) }, SHAPE_LEVELS[2])).toBe(`{ text: "${'a'.repeat(11)}…" }`);
  });
});

const search: Exchange = {
  index: 2,
  started: 120,
  method: 'POST',
  url: 'http://127.0.0.1:4101/api/v2/invoices/search?lang=en',
  resource_type: 'fetch',
  request_headers: {
    accept: '*/*',
    'content-type': 'application/json',
    'user-agent': 'Mozilla/5.0',
    'sec-ch-ua': '"Chromium"',
    'x-csrf-token': '{{vars.csrf}}',
  },
  request_body: '{"status":"paid","from":"","page":1}',
  status: 200,
  response_headers: { 'content-type': 'application/json' },
  mime_type: 'application/json',
  response_body: JSON.stringify({
    items: [{ invoiceNo: 'INV-1056', state: 'paid' }],
    page: 1,
    hasMore: true,
  }),
  duration_ms: 12,
  after_actions: 2,
};

describe('summarizeExchanges', () => {
  it('lists the fields that matter, without boilerplate headers', () => {
    expect(requestFields(search)).toEqual([
      { location: 'query', name: 'lang', value: 'en' },
      { location: 'body', name: 'status', value: 'paid' },
      { location: 'body', name: 'from', value: '' },
      { location: 'body', name: 'page', value: '1' },
      { location: 'header', name: 'content-type', value: 'application/json' },
      { location: 'header', name: 'x-csrf-token', value: '{{vars.csrf}}' },
    ]);
  });

  it('describes a request with its classified fields and response shape', () => {
    const fields = requestFields(search).map((field) => {
      if (field.name === 'status') return { ...field, kind: 'user_input' as const, source: 'input status' };
      if (field.name === 'page') return { ...field, kind: 'pagination' as const };
      if (field.name === 'x-csrf-token')
        return { ...field, kind: 'auth' as const, source: '<meta name=csrf-token>' };
      return { ...field, kind: 'constant' as const };
    });
    const input = {
      exchange: search,
      why: 'has 10 of 10 rows on screen',
      after: 'click button "Search"',
      fields,
    };
    expect(summarizeExchanges([input])).toBe(
      [
        '#1 POST /api/v2/invoices/search → 200 application/json (after click button "Search")',
        '  why: has 10 of 10 rows on screen',
        '  query: lang="en" [constant]',
        '  body (json): status="paid" [user_input: input status] · from="" [constant] · page="1" [pagination]',
        '  header: content-type="application/json" [constant] · x-csrf-token="{{vars.csrf}}" [auth: <meta name=csrf-token>]',
        '  response: { items: [1 × { invoiceNo: "INV-1056", state: "paid" }], page: 1, hasMore: true }',
      ].join('\n'),
    );
    const tight = summarizeExchanges([input], 2) ?? '';
    expect(tight).not.toContain('lang=');
    expect(tight).toContain('status="paid" [user_input: input status] · page="1" [pagination]');
    expect(summarizeExchanges([input], 3)).toBeUndefined();
  });
});

describe('formatSubtree', () => {
  async function invoicesPage(): Promise<string> {
    const app = createHtmlAppFixture();
    const response = await app.inject({ method: 'GET', url: '/invoices' });
    await app.close();
    return response.body;
  }

  it('finds the table that holds the data and cuts it down', async () => {
    const html = await invoicesPage();
    const values = ['INV-1057', 'Cedar Office Supply', 'INV-1056', 'Acme Paper', 'INV-1048', 'INV-1050'];
    expect(htmlHoldsData(html, values)).toBe(true);

    const subtree = formatSubtree(html, values) ?? '';
    expect(subtree.split('\n')[0]).toBe('<!-- body > table#invoices -->');
    expect(subtree).toContain('<table id="invoices" data-testid="invoices"><thead><tr><th>Number</th>');
    expect(subtree).toContain('<!-- 7 more tr -->');
    expect(subtree).not.toContain('scope=');
    expect(subtree.match(/<tr>/g)).toHaveLength(4);
  });

  it('reports a page that does not contain the data', async () => {
    const html = await invoicesPage();
    expect(htmlHoldsData(html, ['INV-9999', 'Nobody Ltd', 'INV-9998'])).toBe(false);
    expect(formatSubtree(html, ['INV-9999', 'Nobody Ltd', 'INV-9998'])).toBeUndefined();
  });
});
