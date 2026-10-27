import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  cookie,
  createInvoices,
  createSwitches,
  escapeHtml,
  filterInvoices,
  htmlPage,
  INVOICE_STATUSES,
  isInvoiceStatus,
  isIsoDate,
  listen,
  pageOf,
  parseCookies,
  registerControls,
  type Invoice,
  type InvoiceFilter,
  type RunningFixture,
} from '@tooldrop/fixture-kit';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

// A single-page invoice app whose script calls an internal JSON API: the case
// `http_replay` is built for. The API matches SPEC's example recipe:
// POST /api/v2/invoices/search with a CSRF header and `hasMore` paging.

const APP_JS = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

export interface JsonApiSwitches extends Record<string, boolean> {
  /** The API moves to /api/v3 and /api/v2 answers 410: replayed requests break, the page keeps working. */
  apiMoved: boolean;
  /** The Search button reads "Find". */
  searchButtonRenamed: boolean;
  /** The date filter moves into a collapsed "Search options" panel. */
  dateFilterMoved: boolean;
}

export function createJsonApiFixture(): FastifyInstance {
  const app = Fastify();
  const invoices = createInvoices();
  const switches = createSwitches<JsonApiSwitches>({
    apiMoved: false,
    searchButtonRenamed: false,
    dateFilterMoved: false,
  });
  /** Session cookie -> CSRF token. */
  const csrfTokens = new Map<string, string>();
  registerControls(app, switches, () => csrfTokens.clear());

  app.get('/', async (request, reply) => {
    let sid = parseCookies(request.headers.cookie).sid;
    let csrf = sid ? csrfTokens.get(sid) : undefined;
    if (!sid || !csrf) {
      sid = randomUUID();
      csrf = randomUUID();
      csrfTokens.set(sid, csrf);
      void reply.header('set-cookie', cookie('sid', sid));
    }
    return reply.type('text/html').send(renderPage(csrf, switches.current));
  });

  app.get('/app.js', async (_request, reply) => reply.type('text/javascript').send(APP_JS));

  app.post('/api/v2/invoices/search', async (request, reply) => {
    if (switches.current.apiMoved) {
      return reply.code(410).send({ error: 'gone', message: 'Use /api/v3/invoices/search' });
    }
    return search(request, reply);
  });

  app.post('/api/v3/invoices/search', async (request, reply) => {
    if (!switches.current.apiMoved) return reply.code(404).send({ error: 'not_found' });
    return search(request, reply);
  });

  function search(request: FastifyRequest, reply: FastifyReply) {
    const sid = parseCookies(request.headers.cookie).sid;
    const expected = sid ? csrfTokens.get(sid) : undefined;
    if (!expected || request.headers['x-csrf-token'] !== expected) {
      return reply.code(403).send({ error: 'invalid_csrf' });
    }
    const query = parseSearch(request.body);
    if (!query) return reply.code(400).send({ error: 'invalid_request' });

    const result = pageOf(filterInvoices(invoices, query.filter), query.page);
    return reply.send({ items: result.items.map(toApiItem), page: query.page, hasMore: result.hasMore });
  }

  return app;
}

export function startJsonApiFixture(port = 0): Promise<RunningFixture> {
  return listen(createJsonApiFixture(), port);
}

/** Accepts what a browser form sends: empty strings mean "any", and page may be a string. */
function parseSearch(body: unknown): { filter: InvoiceFilter; page: number } | undefined {
  const {
    status,
    from,
    page = 1,
  } = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const filter: InvoiceFilter = {};
  if (status !== undefined && status !== '') {
    if (!isInvoiceStatus(status)) return undefined;
    filter.status = status;
  }
  if (from !== undefined && from !== '') {
    if (!isIsoDate(from)) return undefined;
    filter.from = from;
  }
  const pageNumber = Number(page);
  if (!Number.isInteger(pageNumber) || pageNumber < 1) return undefined;
  return { filter, page: pageNumber };
}

/** The API's own field names differ from ours on purpose, so recipes have to map them. */
/**
 * Each supplier's billing contact. The page never shows it, but the API sends
 * it, as real APIs do: the privacy tests check it never reaches an external
 * model. Fake values: the .example domain and the 555-01xx range.
 */
export function supplierContact(supplier: string): { email: string; phone: string } {
  const slug = supplier.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const number = 34 + (supplier.length % 60);
  return { email: `billing@${slug}.example`, phone: `+1 415 555 01${String(number).padStart(2, '0')}` };
}

function toApiItem(invoice: Invoice) {
  return {
    invoiceNo: invoice.number,
    supplier: invoice.supplier,
    issuedOn: invoice.issued_on,
    total: { value: invoice.amount, currency: invoice.currency },
    state: invoice.status,
    contact: supplierContact(invoice.supplier),
  };
}

function renderPage(csrf: string, switches: Readonly<JsonApiSwitches>): string {
  const options = INVOICE_STATUSES.map(
    (status) => `<option value="${status}">${status[0]?.toUpperCase()}${status.slice(1)}</option>`,
  ).join('');
  const dateFilter = '<label>From <input type="date" name="from"></label>';
  const head = [
    `<meta name="csrf-token" content="${escapeHtml(csrf)}">`,
    `<meta name="api-base" content="${switches.apiMoved ? '/api/v3' : '/api/v2'}">`,
    '<script src="/app.js" type="module"></script>',
  ].join('\n');

  return htmlPage(
    'Invoices',
    `<h1>Invoices</h1>
<form id="search" role="search">
<label>Status <select name="status"><option value="">All</option>${options}</select></label>
${switches.dateFilterMoved ? `<details><summary>Search options</summary>${dateFilter}</details>` : dateFilter}
<button type="submit" data-testid="search">${switches.searchButtonRenamed ? 'Find' : 'Search'}</button>
</form>
<p id="error" role="alert" hidden></p>
<table id="invoices" data-testid="invoices">
<thead><tr><th scope="col">Number</th><th scope="col">Supplier</th><th scope="col">Date</th><th scope="col">Amount</th><th scope="col">Status</th></tr></thead>
<tbody></tbody>
</table>
<button type="button" id="more" hidden>Load more</button>`,
    head,
  );
}
