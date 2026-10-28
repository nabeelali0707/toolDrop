import { acceptFormBodies, escapeHtml, htmlPage, type Invoice } from '@tooldrop/fixture-kit';
import type { FastifyInstance } from 'fastify';

// A form that changes data, for safe mode (SPEC, Safe mode): recording a
// payment marks an invoice as paid. Tests read GET /__fixture/payments to
// see whether a write happened.

export interface Payment {
  id: string;
  invoice: string;
  amount: number;
  reference: string;
}

/** Adds the payment pages; returns what the fixture's reset calls. */
export function registerPayments(app: FastifyInstance, invoices: Invoice[]): () => void {
  acceptFormBodies(app);
  const payments: Payment[] = [];

  app.get('/payments/new', async (_request, reply) => reply.type('text/html').send(paymentForm()));

  app.post('/payments', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string | undefined>;
    const index = invoices.findIndex((invoice) => invoice.number === body.invoice?.trim());
    const invoice = invoices[index];
    const amount = Number(body.amount);
    const problem = !invoice
      ? 'There is no invoice with that number.'
      : invoice.status === 'paid'
        ? `${invoice.number} is already paid.`
        : !(amount > 0)
          ? 'Enter an amount above zero.'
          : undefined;
    if (problem || !invoice) {
      return reply.code(422).type('text/html').send(paymentForm(problem));
    }
    // Replaced, not changed in place, so the fixture's reset brings back the seed data.
    invoices[index] = { ...invoice, status: 'paid' };
    const payment: Payment = {
      id: `PAY-${String(payments.length + 1).padStart(4, '0')}`,
      invoice: invoice.number,
      amount,
      reference: body.reference?.trim() ?? '',
    };
    payments.push(payment);
    return reply.redirect(`/payments/${payment.id}`, 303);
  });

  app.get('/payments/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const payment = payments.find((candidate) => candidate.id === id);
    if (!payment) return reply.code(404).type('text/html').send(htmlPage('Not found', '<h1>Not found</h1>'));
    return reply.type('text/html').send(
      htmlPage(
        'Payment recorded',
        `<h1>Payment recorded</h1>
<p id="confirmation" role="status">Payment ${payment.id} recorded: ${payment.invoice} is paid, ${payment.amount.toFixed(2)} USD.</p>
<p><a href="/invoices">Back to invoices</a></p>`,
      ),
    );
  });

  app.get('/__fixture/payments', () => payments);

  return () => {
    payments.length = 0;
  };
}

function paymentForm(problem?: string): string {
  return htmlPage(
    'Record a payment',
    `<h1>Record a payment</h1>
${problem ? `<p role="alert">${escapeHtml(problem)}</p>` : ''}
<form method="post" action="/payments">
<p><label for="invoice">Invoice number</label> <input id="invoice" name="invoice" required></p>
<p><label for="amount">Amount</label> <input id="amount" name="amount" type="number" step="0.01" min="0.01" required></p>
<p><label for="reference">Reference</label> <input id="reference" name="reference"></p>
<button type="submit">Record payment</button>
</form>`,
  );
}
