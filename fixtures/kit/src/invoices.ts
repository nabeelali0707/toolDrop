// The seed data every fixture serves: supplier invoices, the running example
// in SPEC ("list my supplier invoices by status and date").

export const INVOICE_STATUSES = ['open', 'paid', 'overdue', 'draft'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export interface Invoice {
  number: string;
  supplier: string;
  /** ISO date, e.g. 2026-03-14 */
  issued_on: string;
  amount: number;
  currency: 'USD';
  status: InvoiceStatus;
}

export interface InvoiceFilter {
  status?: InvoiceStatus | undefined;
  /** Inclusive ISO dates. */
  from?: string | undefined;
  to?: string | undefined;
}

export const PAGE_SIZE = 10;

const SUPPLIERS = [
  'Acme Paper',
  'Brightline Logistics',
  'Cedar Office Supply',
  'Delta Cleaning',
  'Evergreen IT',
];
const FIRST_DAY = Date.UTC(2026, 0, 5);
const DAY_MS = 86_400_000;

/** The same 57 invoices on every call, newest first, so tests can count on them. */
export function createInvoices(count = 57): Invoice[] {
  return Array.from({ length: count }, (_, i): Invoice => {
    const status = INVOICE_STATUSES[(i * 7) % INVOICE_STATUSES.length] ?? 'open';
    return {
      number: `INV-${1001 + i}`,
      supplier: SUPPLIERS[i % SUPPLIERS.length] ?? 'Acme Paper',
      issued_on: new Date(FIRST_DAY + i * 3 * DAY_MS).toISOString().slice(0, 10),
      // Whole cents divided once, so amounts print cleanly (22.34, not 22.339999999999996).
      amount: (((i * 7919) % 90_000) + 1000) / 100,
      currency: 'USD',
      status,
    };
  }).reverse();
}

export function filterInvoices(invoices: Invoice[], filter: InvoiceFilter): Invoice[] {
  return invoices.filter(
    (invoice) =>
      (!filter.status || invoice.status === filter.status) &&
      (!filter.from || invoice.issued_on >= filter.from) &&
      (!filter.to || invoice.issued_on <= filter.to),
  );
}

/** One page (1-based) of results. */
export function pageOf<T>(items: T[], page: number, size = PAGE_SIZE): { items: T[]; hasMore: boolean } {
  const start = (page - 1) * size;
  return { items: items.slice(start, start + size), hasMore: start + size < items.length };
}

export function isInvoiceStatus(value: unknown): value is InvoiceStatus {
  return typeof value === 'string' && (INVOICE_STATUSES as readonly string[]).includes(value);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && ISO_DATE.test(value);
}
