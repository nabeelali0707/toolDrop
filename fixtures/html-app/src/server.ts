import {
  createInvoices,
  createSwitches,
  filterInvoices,
  htmlPage,
  INVOICE_COLUMNS,
  INVOICE_STATUSES,
  invoiceTable,
  isInvoiceStatus,
  isIsoDate,
  listen,
  pageOf,
  registerControls,
  registerInvoiceControls,
  type Invoice,
  type InvoiceColumn,
  type InvoiceFilter,
  type RunningFixture,
} from '@tooldrop/fixture-kit';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerPayments } from './payments.ts';

export type { Payment } from './payments.ts';

// A server-rendered invoice list: filters are query parameters and pages are
// links, with no script at all. The case `html_fetch` is built for.

export interface HtmlAppSwitches extends Record<string, boolean> {
  /** The Search button reads "Find". */
  searchButtonRenamed: boolean;
  /** The date filter moves into a collapsed "Search options" panel. */
  dateFilterMoved: boolean;
  /** The Amount column moves next to Number, so column positions change. */
  columnsReordered: boolean;
}

const REORDERED: readonly InvoiceColumn[] = ['number', 'amount', 'supplier', 'issued_on', 'status'];

export function createHtmlAppFixture(): FastifyInstance {
  const app = Fastify();
  const invoices = createInvoices();
  const switches = createSwitches<HtmlAppSwitches>({
    searchButtonRenamed: false,
    dateFilterMoved: false,
    columnsReordered: false,
  });
  const resetInvoices = registerInvoiceControls(app, invoices);
  const resetPayments = registerPayments(app, invoices);
  registerControls(app, switches, () => {
    resetInvoices();
    resetPayments();
  });

  app.get('/', async (_request, reply) => reply.redirect('/invoices'));

  app.get('/invoices', async (request, reply) => {
    const query = parseQuery(request.query as Record<string, string | undefined>);
    if (!query) {
      return reply.code(400).type('text/html').send(htmlPage('Invalid filter', '<h1>Invalid filter</h1>'));
    }
    const result = pageOf(filterInvoices(invoices, query.filter), query.page);
    return reply.type('text/html').send(renderPage(query, result, switches.current));
  });

  return app;
}

export function startHtmlAppFixture(port = 0): Promise<RunningFixture> {
  return listen(createHtmlAppFixture(), port);
}

interface Query {
  filter: InvoiceFilter;
  page: number;
}

function parseQuery({ status, from, page = '1' }: Record<string, string | undefined>): Query | undefined {
  const filter: InvoiceFilter = {};
  if (status) {
    if (!isInvoiceStatus(status)) return undefined;
    filter.status = status;
  }
  if (from) {
    if (!isIsoDate(from)) return undefined;
    filter.from = from;
  }
  const pageNumber = Number(page);
  if (!Number.isInteger(pageNumber) || pageNumber < 1) return undefined;
  return { filter, page: pageNumber };
}

function pageLink(query: Query, page: number): string {
  const params = new URLSearchParams();
  if (query.filter.status) params.set('status', query.filter.status);
  if (query.filter.from) params.set('from', query.filter.from);
  params.set('page', String(page));
  return `/invoices?${params.toString().replaceAll('&', '&amp;')}`;
}

function renderPage(
  query: Query,
  result: { items: Invoice[]; hasMore: boolean },
  switches: Readonly<HtmlAppSwitches>,
): string {
  const options = INVOICE_STATUSES.map((status) => {
    const selected = query.filter.status === status ? ' selected' : '';
    return `<option value="${status}"${selected}>${status[0]?.toUpperCase()}${status.slice(1)}</option>`;
  }).join('');
  const dateFilter = `<label>From <input type="date" name="from" value="${query.filter.from ?? ''}"></label>`;
  const columns = switches.columnsReordered ? REORDERED : INVOICE_COLUMNS;

  const links = [
    query.page > 1 ? `<a rel="prev" href="${pageLink(query, query.page - 1)}">Previous page</a>` : '',
    result.hasMore ? `<a rel="next" href="${pageLink(query, query.page + 1)}">Next page</a>` : '',
  ].join(' ');

  return htmlPage(
    'Invoices',
    `<h1>Invoices</h1>
<form id="search" role="search" method="get" action="/invoices">
<label>Status <select name="status"><option value="">All</option>${options}</select></label>
${switches.dateFilterMoved ? `<details><summary>Search options</summary>${dateFilter}</details>` : dateFilter}
<button type="submit" data-testid="search">${switches.searchButtonRenamed ? 'Find' : 'Search'}</button>
</form>
${invoiceTable(result.items, columns)}
${result.items.length === 0 ? '<p id="empty">No invoices match.</p>' : ''}
<nav aria-label="Pagination"><span>Page ${query.page}</span> ${links}</nav>
<p><a href="/payments/new">Record a payment</a></p>`,
  );
}
