import type { Invoice } from './invoices.ts';

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function htmlPage(title: string, body: string, head = ''): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
${head}
</head>
<body>
${body}
</body>
</html>`;
}

export const INVOICE_COLUMNS = ['number', 'supplier', 'issued_on', 'amount', 'status'] as const;
export type InvoiceColumn = (typeof INVOICE_COLUMNS)[number];

const HEADERS: Record<InvoiceColumn, string> = {
  number: 'Number',
  supplier: 'Supplier',
  issued_on: 'Date',
  amount: 'Amount',
  status: 'Status',
};

/** The invoice table, with its columns in the given order. */
export function invoiceTable(
  invoices: Invoice[],
  columns: readonly InvoiceColumn[] = INVOICE_COLUMNS,
): string {
  const head = columns.map((column) => `<th scope="col">${HEADERS[column]}</th>`).join('');
  const rows = invoices
    .map((invoice) => {
      const cells = columns.map((column) => {
        const value = column === 'amount' ? invoice.amount.toFixed(2) : invoice[column];
        return `<td>${escapeHtml(String(value))}</td>`;
      });
      return `<tr>${cells.join('')}</tr>`;
    })
    .join('\n');
  return `<table id="invoices" data-testid="invoices">
<thead><tr>${head}</tr></thead>
<tbody>
${rows}
</tbody>
</table>`;
}
