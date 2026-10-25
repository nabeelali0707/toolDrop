import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  acceptFormBodies,
  cookie,
  createSwitches,
  escapeHtml,
  htmlPage,
  listen,
  pageOf,
  parseCookies,
  registerControls,
  type RunningFixture,
} from '@tooldrop/fixture-kit';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { verify } from 'otplib';
import { createOrders, ORDER_STATUSES, type Order, type OrderStatus } from './orders.ts';

// The Demo Shop: the fixture behind toolDrop's main use case (README, the
// "Demo Shop order tracker"). A customer signs in with a password and a TOTP
// code; the orders page is a small app that first fetches a short-lived
// bearer token, then calls an internal JSON API with it. A recipe has to
// carry that token from one request to the next (DECISIONS.md, D-025).

/** The only customer. Test-only values: never real credentials (SPEC, Instructions rule 8). */
export const DEMO_SHOP_ACCOUNT = {
  username: 'demo-shopper',
  password: 'demo-shop-password-not-real',
  displayName: 'Demo Shopper',
  /** RFC 6238's published test secret ("12345678901234567890"), base32-encoded. */
  totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
} as const;

const ORDERS_JS = readFileSync(new URL('../public/orders.js', import.meta.url), 'utf8');
const TOKEN_TTL_MS = 15 * 60 * 1000;

export interface DemoShopSwitches extends Record<string, boolean> {
  /** "Sign in" reads "Log in" and "Show orders" reads "View orders": the heal demo. */
  buttonsRenamed: boolean;
  /** The orders API moves to /api/v2 and /api/v1 answers 410; the page follows. */
  apiMoved: boolean;
}

export function createDemoShopFixture(): FastifyInstance {
  const app = Fastify();
  acceptFormBodies(app);
  const switches = createSwitches<DemoShopSwitches>({ buttonsRenamed: false, apiMoved: false });
  let orders = createOrders();
  /** Password accepted, code still needed: pending token -> username. */
  const pending = new Map<string, string>();
  /** Signed in: session cookie -> username. */
  const sessions = new Map<string, string>();
  /** API bearer tokens -> expiry time. */
  const tokens = new Map<string, number>();

  const signOutEveryone = () => {
    pending.clear();
    sessions.clear();
    tokens.clear();
  };
  registerControls(app, switches, () => {
    signOutEveryone();
    orders = createOrders();
  });

  app.post('/__fixture/expire-sessions', async (_request, reply) => {
    signOutEveryone();
    return reply.code(204).send();
  });

  // Signs the demo customer in without typing anything, for browser checks and
  // demo recordings where no one should enter credentials.
  app.get('/__fixture/sign-in', async (_request, reply) => {
    const session = randomUUID();
    sessions.set(session, DEMO_SHOP_ACCOUNT.username);
    return reply.header('set-cookie', cookie('shop_session', session)).redirect('/account/orders', 303);
  });

  // Changes one order, as the shop's warehouse would: the event a watch reports.
  app.post('/__fixture/orders/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { status } = (request.body ?? {}) as { status?: unknown };
    const order = orders.find((candidate) => candidate.id === id);
    if (!order) return reply.code(404).send({ error: 'not_found' });
    if (!isOrderStatus(status))
      return reply.code(400).send({ error: 'invalid_status', allowed: ORDER_STATUSES });
    const today = new Date().toISOString().slice(0, 10);
    order.status = status;
    order.delivered_on = status === 'delivered' ? today : null;
    if (status === 'delivered' || status === 'cancelled') order.expected_on = null;
    return toApiOrder(order);
  });

  const sessionUser = (request: FastifyRequest) =>
    sessions.get(parseCookies(request.headers.cookie).shop_session ?? '');
  const pendingUser = (request: FastifyRequest) =>
    pending.get(parseCookies(request.headers.cookie).shop_pending ?? '');
  const form = (request: FastifyRequest) => (request.body ?? {}) as Record<string, string | undefined>;
  const html = (reply: FastifyReply, body: string, status = 200) =>
    reply.code(status).type('text/html').send(body);

  app.get('/', async (request, reply) => {
    if (sessionUser(request)) return reply.redirect('/account/orders');
    return html(reply, homePage());
  });

  app.get('/signin', async (_request, reply) => html(reply, signInPage(switches.current)));

  app.post('/signin', async (request, reply) => {
    const { username, password } = form(request);
    if (username !== DEMO_SHOP_ACCOUNT.username || password !== DEMO_SHOP_ACCOUNT.password) {
      return html(reply, signInPage(switches.current, 'Wrong username or password.'), 401);
    }
    const token = randomUUID();
    pending.set(token, username);
    return reply.header('set-cookie', cookie('shop_pending', token)).redirect('/signin/verify', 303);
  });

  app.get('/signin/verify', async (request, reply) => {
    if (!pendingUser(request)) return reply.redirect('/signin', 303);
    return html(reply, verifyPage());
  });

  app.post('/signin/verify', async (request, reply) => {
    const username = pendingUser(request);
    if (!username) return reply.redirect('/signin', 303);
    const { code = '' } = form(request);
    const result = await verify({
      secret: DEMO_SHOP_ACCOUNT.totpSecret,
      token: code.trim(),
      epochTolerance: 30,
    });
    if (!result.valid) return html(reply, verifyPage('That code is not right. Try the current one.'), 401);

    pending.delete(parseCookies(request.headers.cookie).shop_pending ?? '');
    const session = randomUUID();
    sessions.set(session, username);
    return reply
      .header('set-cookie', [cookie('shop_session', session), cookie('shop_pending', '', { clear: true })])
      .redirect('/account/orders', 303);
  });

  app.post('/signout', async (request, reply) => {
    sessions.delete(parseCookies(request.headers.cookie).shop_session ?? '');
    return reply.header('set-cookie', cookie('shop_session', '', { clear: true })).redirect('/', 303);
  });

  app.get('/account/orders', async (request, reply) => {
    if (!sessionUser(request)) return reply.redirect('/signin', 303);
    return html(reply, ordersPage(switches.current));
  });

  app.get('/orders.js', async (_request, reply) => reply.type('text/javascript').send(ORDERS_JS));

  // The session cookie buys a short-lived bearer token for the orders API.
  app.get('/api/session/token', async (request, reply) => {
    if (!sessionUser(request)) return reply.code(401).send({ error: 'unauthorized' });
    const token = randomBytes(24).toString('base64url');
    tokens.set(token, Date.now() + TOKEN_TTL_MS);
    return { token, expires_in: TOKEN_TTL_MS / 1000 };
  });

  const listOrders = async (request: FastifyRequest, reply: FastifyReply) => {
    const bearer = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1];
    const expiry = bearer ? tokens.get(bearer) : undefined;
    if (!expiry || expiry < Date.now()) return reply.code(401).send({ error: 'invalid_token' });

    const { status, page = '1' } = request.query as { status?: string; page?: string };
    if (status && !isOrderStatus(status)) return reply.code(400).send({ error: 'invalid_status' });
    const pageNumber = Number(page);
    if (!Number.isInteger(pageNumber) || pageNumber < 1)
      return reply.code(400).send({ error: 'invalid_page' });

    const matching = orders.filter((order) => !status || order.status === status);
    const result = pageOf(matching, pageNumber, 5);
    return {
      data: result.items.map(toApiOrder),
      meta: {
        page: pageNumber,
        totalPages: Math.max(1, Math.ceil(matching.length / 5)),
        hasNextPage: result.hasMore,
      },
    };
  };

  app.get('/api/v1/orders', async (request, reply) => {
    if (switches.current.apiMoved)
      return reply.code(410).send({ error: 'gone', message: 'Use /api/v2/orders' });
    return listOrders(request, reply);
  });

  app.get('/api/v2/orders', async (request, reply) => {
    if (!switches.current.apiMoved) return reply.code(404).send({ error: 'not_found' });
    return listOrders(request, reply);
  });

  return app;
}

export function startDemoShopFixture(port = 0): Promise<RunningFixture> {
  return listen(createDemoShopFixture(), port);
}

function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === 'string' && (ORDER_STATUSES as readonly string[]).includes(value);
}

/** The API's own field names, which a recipe maps to the tool's output. */
function toApiOrder(order: Order) {
  return {
    orderId: order.id,
    placedAt: order.placed_on,
    lines: order.items.map((item) => ({ product: item.name, qty: item.quantity })),
    grandTotal: { amount: order.total, currency: 'USD' },
    fulfillment: { status: order.status, expectedDate: order.expected_on, deliveredDate: order.delivered_on },
  };
}

const alert = (message?: string) => (message ? `<p role="alert">${escapeHtml(message)}</p>` : '');

function homePage(): string {
  return htmlPage(
    'Demo Shop',
    `<header><h1>Demo Shop</h1><nav><a href="/signin">Sign in</a></nav></header>
<p>Small goods for your desk. Sign in to see your orders.</p>`,
  );
}

function signInPage(switches: Readonly<DemoShopSwitches>, error?: string): string {
  const label = switches.buttonsRenamed ? 'Log in' : 'Sign in';
  return htmlPage(
    `${label} · Demo Shop`,
    `<h1>${label}</h1>
${alert(error)}
<form method="post" action="/signin">
<label>Username <input name="username" autocomplete="username" required></label>
<label>Password <input name="password" type="password" autocomplete="current-password" required></label>
<button type="submit" data-testid="sign-in">${label}</button>
</form>`,
  );
}

function verifyPage(error?: string): string {
  return htmlPage(
    'Verify · Demo Shop',
    `<h1>Two-step verification</h1>
<p>Enter the 6-digit code from your authenticator app.</p>
${alert(error)}
<form method="post" action="/signin/verify">
<label>Verification code <input name="code" inputmode="numeric" autocomplete="one-time-code" required></label>
<button type="submit">Verify</button>
</form>`,
  );
}

function ordersPage(switches: Readonly<DemoShopSwitches>): string {
  const options = ORDER_STATUSES.map(
    (status) => `<option value="${status}">${status[0]?.toUpperCase()}${status.slice(1)}</option>`,
  ).join('');
  const head = [
    `<meta name="orders-api" content="${switches.apiMoved ? '/api/v2/orders' : '/api/v1/orders'}">`,
    '<script src="/orders.js" type="module"></script>',
  ].join('\n');
  return htmlPage(
    'Your orders · Demo Shop',
    `<header>
<h1>Demo Shop</h1>
<nav aria-label="Account">
<span data-testid="account-menu">Signed in as ${escapeHtml(DEMO_SHOP_ACCOUNT.displayName)}</span>
<form method="post" action="/signout"><button type="submit">Sign out</button></form>
</nav>
</header>
<h2>Your orders</h2>
<form id="filters">
<label>Status <select name="status"><option value="">All</option>${options}</select></label>
<button type="submit" data-testid="show-orders">${switches.buttonsRenamed ? 'View orders' : 'Show orders'}</button>
</form>
<p id="error" role="alert" hidden></p>
<table id="orders" data-testid="orders">
<thead><tr><th scope="col">Order</th><th scope="col">Placed</th><th scope="col">Items</th><th scope="col">Total</th><th scope="col">Status</th><th scope="col">Delivery</th></tr></thead>
<tbody></tbody>
</table>
<button type="button" id="more" hidden>More orders</button>`,
    head,
  );
}
