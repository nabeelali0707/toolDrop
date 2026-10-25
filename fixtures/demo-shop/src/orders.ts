// The Demo Shop's order history for its one customer: the data behind the
// main use case ("Which of my orders haven't been delivered yet?").

export const ORDER_STATUSES = ['processing', 'shipped', 'delivered', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface Order {
  id: string;
  /** ISO date */
  placed_on: string;
  items: { name: string; quantity: number }[];
  total: number;
  status: OrderStatus;
  /** Expected delivery date while on the way; null when delivered or cancelled. */
  expected_on: string | null;
  /** Actual delivery date once delivered. */
  delivered_on: string | null;
}

const PRODUCTS = [
  'Ceramic pour-over set',
  'Wool desk mat',
  'Brass pen',
  'Linen notebook',
  'Oak monitor stand',
  'Cotton tote bag',
  'Glass water bottle',
];

const DAY_MS = 86_400_000;

/** The newest order is being packed, the next two are shipped, and older ones arrived or were cancelled. */
function statusOf(index: number): OrderStatus {
  if (index === 13) return 'processing';
  if (index >= 11) return 'shipped';
  return index % 5 === 3 ? 'cancelled' : 'delivered';
}

/**
 * 14 orders, newest first, dated relative to `today` so the demo always looks
 * current: the three newest are still on their way with delivery dates ahead,
 * the rest were delivered or cancelled weeks ago. The same `today` always
 * gives the same orders.
 */
export function createOrders(today: Date = new Date()): Order[] {
  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const date = (daysFromToday: number) =>
    new Date(midnight + daysFromToday * DAY_MS).toISOString().slice(0, 10);

  return Array.from({ length: 14 }, (_, i): Order => {
    const inFlight = i >= 11;
    const status = statusOf(i);
    const placed = inFlight ? -(13 - i) * 2 : -(13 - i) * 9;
    const product = PRODUCTS[i % PRODUCTS.length] ?? 'Brass pen';
    return {
      id: `ORD-${2001 + i}`,
      placed_on: date(placed),
      items: [{ name: product, quantity: (i % 3) + 1 }],
      // Whole cents divided once, so totals print cleanly.
      total: (((i * 1337) % 9000) + 1500) / 100,
      status,
      expected_on: inFlight ? date(placed + 6) : null,
      delivered_on: status === 'delivered' ? date(placed + 4) : null,
    };
  }).reverse();
}
