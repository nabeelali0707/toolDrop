import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { escapeHtml, invoiceTable } from './html.ts';
import { createInvoices, filterInvoices, pageOf } from './invoices.ts';
import { cookie, listen, parseCookies, type RunningFixture } from './server.ts';
import { createSwitches, registerControls, registerInvoiceControls } from './switches.ts';

describe('invoices', () => {
  const invoices = createInvoices();

  it('are the same on every call, newest first', () => {
    expect(createInvoices()).toEqual(invoices);
    expect(invoices).toHaveLength(57);
    const dates = invoices.map((invoice) => invoice.issued_on);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(new Set(invoices.map((invoice) => invoice.number)).size).toBe(57);
  });

  it('have amounts with at most two decimals', () => {
    for (const { amount } of invoices) expect(Math.round(amount * 100) / 100).toBe(amount);
  });

  it('filter by status and inclusive dates', () => {
    const open = filterInvoices(invoices, { status: 'open', from: '2026-02-01', to: '2026-03-31' });
    expect(open.length).toBeGreaterThan(0);
    for (const invoice of open) {
      expect(invoice.status).toBe('open');
      expect(invoice.issued_on >= '2026-02-01' && invoice.issued_on <= '2026-03-31').toBe(true);
    }
  });

  it('page through results', () => {
    expect(pageOf(invoices, 1)).toMatchObject({ hasMore: true });
    expect(pageOf(invoices, 6)).toMatchObject({ hasMore: false });
    expect(pageOf(invoices, 6).items).toHaveLength(7);
  });
});

describe('html', () => {
  it('escapes markup', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });

  it('renders invoice columns in the order given', () => {
    const html = invoiceTable(createInvoices(1), ['amount', 'number']);
    expect(html).toContain('<tr><th scope="col">Amount</th><th scope="col">Number</th></tr>');
    expect(html).toContain('<tr><td>10.00</td><td>INV-1001</td></tr>');
  });
});

describe('cookies', () => {
  it('parse a Cookie header', () => {
    expect(parseCookies('sid=abc; theme=dark')).toEqual({ sid: 'abc', theme: 'dark' });
    expect(parseCookies(undefined)).toEqual({});
  });

  it('are HttpOnly and can be cleared', () => {
    expect(cookie('sid', 'abc')).toBe('sid=abc; Path=/; HttpOnly; SameSite=Lax');
    expect(cookie('sid', '', { clear: true })).toContain('Max-Age=0');
  });
});

describe('switches', () => {
  let fixture: RunningFixture | undefined;
  afterEach(() => fixture?.close());

  async function start() {
    const app = Fastify();
    const switches = createSwitches({ buttonRenamed: false });
    let resets = 0;
    registerControls(app, switches, () => resets++);
    fixture = await listen(app);
    const post = (path: string, body?: unknown) =>
      fetch(`${fixture?.url}${path}`, {
        method: 'POST',
        ...(body !== undefined && {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      });
    return { switches, post, resets: () => resets };
  }

  it('flip over HTTP and reset', async () => {
    const { switches, post, resets } = await start();

    const flipped = await post('/__fixture/switches', { buttonRenamed: true });
    expect(await flipped.json()).toEqual({ buttonRenamed: true });
    expect(switches.current.buttonRenamed).toBe(true);

    expect((await post('/__fixture/reset')).status).toBe(204);
    expect(switches.current.buttonRenamed).toBe(false);
    expect(resets()).toBe(1);
  });

  it('reject unknown switches', async () => {
    const { post } = await start();
    const response = await post('/__fixture/switches', { colorChanged: true });
    expect(response.status).toBe(400);
  });
});

describe('invoice controls', () => {
  let fixture: RunningFixture | undefined;
  afterEach(() => fixture?.close());

  it('add the newest invoice over HTTP, and the reset removes it', async () => {
    const app = Fastify();
    const invoices = createInvoices();
    registerControls(app, createSwitches({}), registerInvoiceControls(app, invoices));
    fixture = await listen(app);
    const added = await fetch(`${fixture.url}/__fixture/invoices`, { method: 'POST' });
    expect(added.status).toBe(201);
    expect(await added.json()).toMatchObject({ number: 'INV-1058', issued_on: '2026-06-23', status: 'open' });
    expect(invoices).toHaveLength(58);
    expect(invoices[0]?.number).toBe('INV-1058');

    await fetch(`${fixture.url}/__fixture/reset`, { method: 'POST' });
    expect(invoices).toHaveLength(57);
    expect(invoices[0]?.number).toBe('INV-1057');
  });
});
