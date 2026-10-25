import { testClient, type RunningFixture } from '@tooldrop/fixture-kit';
import { generate } from 'otplib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOrders } from './orders.ts';
import { DEMO_SHOP_ACCOUNT, startDemoShopFixture } from './server.ts';

let fixture: RunningFixture;

beforeEach(async () => {
  fixture = await startDemoShopFixture();
});

afterEach(() => fixture.close());

interface OrdersPage {
  data: {
    orderId: string;
    placedAt: string;
    fulfillment: { status: string; expectedDate: string | null; deliveredDate: string | null };
  }[];
  meta: { page: number; totalPages: number; hasNextPage: boolean };
}

/** Signs in the way the shop's customer does: password, then TOTP code. */
async function signIn() {
  const client = testClient(fixture.url);
  await client.request('/signin', {
    form: { username: DEMO_SHOP_ACCOUNT.username, password: DEMO_SHOP_ACCOUNT.password },
  });
  await client.request('/signin/verify', {
    form: { code: await generate({ secret: DEMO_SHOP_ACCOUNT.totpSecret }) },
  });
  return client;
}

/** The orders API as the page calls it: trade the session for a token, then send it as a bearer token. */
async function ordersApi(client: Awaited<ReturnType<typeof signIn>>, version = 'v1') {
  const { token } = (await (await client.request('/api/session/token')).json()) as { token: string };
  return async (query = '') => {
    const response = await client.request(`/api/${version}/orders${query}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: response.status, body: (await response.json()) as OrdersPage };
  };
}

async function allOrders(list: Awaited<ReturnType<typeof ordersApi>>, filter = '') {
  const orders: OrdersPage['data'] = [];
  for (let page = 1; ; page++) {
    const { body } = await list(`?page=${page}${filter}`);
    orders.push(...body.data);
    if (!body.meta.hasNextPage) return orders;
  }
}

describe('demo-shop fixture', () => {
  it('signs in with password and TOTP, then shows the orders page', async () => {
    const client = await signIn();
    const page = await (await client.request('/account/orders')).text();
    expect(page).toContain('<span data-testid="account-menu">Signed in as Demo Shopper</span>');
    expect(page).toContain('<meta name="orders-api" content="/api/v1/orders">');
    expect(page).toContain('data-testid="show-orders">Show orders</button>');
  });

  it('signs in through the fixture control, for browser checks that must not type credentials', async () => {
    const client = testClient(fixture.url);
    const response = await client.request('/__fixture/sign-in');
    expect(response.headers.get('location')).toBe('/account/orders');
    expect((await client.request('/account/orders')).status).toBe(200);
  });

  it('keeps signed-out visitors out of orders and tokens', async () => {
    const client = testClient(fixture.url);
    expect((await client.request('/account/orders')).headers.get('location')).toBe('/signin');
    expect((await client.request('/api/session/token')).status).toBe(401);
  });

  it('serves orders only with a bearer token from the session', async () => {
    const client = await signIn();
    expect((await client.request('/api/v1/orders')).status).toBe(401);

    const list = await ordersApi(client);
    const { status, body } = await list();
    expect(status).toBe(200);
    expect(body.meta).toEqual({ page: 1, totalPages: 3, hasNextPage: true });

    const [newest] = createOrders();
    expect(body.data[0]).toEqual({
      orderId: newest?.id,
      placedAt: newest?.placed_on,
      lines: newest?.items.map((item) => ({ product: item.name, qty: item.quantity })),
      grandTotal: { amount: newest?.total, currency: 'USD' },
      fulfillment: { status: 'processing', expectedDate: newest?.expected_on, deliveredDate: null },
    });
  });

  it('answers "which orders have not been delivered yet?"', async () => {
    const list = await ordersApi(await signIn());
    const orders = await allOrders(list);
    expect(orders).toHaveLength(14);

    const today = new Date().toISOString().slice(0, 10);
    const onTheWay = orders.filter((order) => ['processing', 'shipped'].includes(order.fulfillment.status));
    expect(onTheWay.map((order) => order.orderId)).toEqual(['ORD-2014', 'ORD-2013', 'ORD-2012']);
    for (const order of onTheWay) expect((order.fulfillment.expectedDate ?? '') > today).toBe(true);
  });

  it('filters by status', async () => {
    const list = await ordersApi(await signIn());
    expect(await allOrders(list, '&status=shipped')).toHaveLength(2);
    expect((await list('?status=lost')).status).toBe(400);
  });

  it('changes an order on demand, which is what a watch reports', async () => {
    const list = await ordersApi(await signIn());
    const change = (id: string, body: unknown) =>
      fetch(`${fixture.url}/__fixture/orders/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    expect((await change('ORD-2013', { status: 'delivered' })).status).toBe(200);
    const updated = (await allOrders(list)).find((order) => order.orderId === 'ORD-2013');
    expect(updated?.fulfillment).toEqual({
      status: 'delivered',
      expectedDate: null,
      deliveredDate: new Date().toISOString().slice(0, 10),
    });

    expect((await change('ORD-2013', { status: 'lost' })).status).toBe(400);
    expect((await change('ORD-9999', { status: 'shipped' })).status).toBe(404);
  });

  it('renames its buttons when asked: the self-heal demo', async () => {
    await fetch(`${fixture.url}/__fixture/switches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ buttonsRenamed: true }),
    });
    expect(await (await fetch(`${fixture.url}/signin`)).text()).toContain(
      'data-testid="sign-in">Log in</button>',
    );
    const page = await (await (await signIn()).request('/account/orders')).text();
    expect(page).toContain('data-testid="show-orders">View orders</button>');
  });

  it('moves the orders API to v2 when asked; the page follows', async () => {
    await fetch(`${fixture.url}/__fixture/switches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiMoved: true }),
    });
    const client = await signIn();
    expect((await (await ordersApi(client))()).status).toBe(410);
    expect((await (await ordersApi(client, 'v2'))()).status).toBe(200);
    expect(await (await client.request('/account/orders')).text()).toContain('content="/api/v2/orders"');
  });

  it('expires sessions and tokens on demand', async () => {
    const client = await signIn();
    const list = await ordersApi(client);
    await fetch(`${fixture.url}/__fixture/expire-sessions`, { method: 'POST' });

    expect((await list()).status).toBe(401);
    expect((await client.request('/account/orders')).headers.get('location')).toBe('/signin');
  });

  it('resets orders and switches', async () => {
    await fetch(`${fixture.url}/__fixture/orders/ORD-2014`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'cancelled' }),
    });
    await fetch(`${fixture.url}/__fixture/reset`, { method: 'POST' });

    const orders = await allOrders(await ordersApi(await signIn()));
    expect(orders[0]?.fulfillment.status).toBe('processing');
  });
});
