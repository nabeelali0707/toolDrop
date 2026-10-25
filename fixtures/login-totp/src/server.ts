import { randomUUID } from 'node:crypto';
import {
  acceptFormBodies,
  cookie,
  createInvoices,
  createSwitches,
  escapeHtml,
  htmlPage,
  invoiceTable,
  listen,
  pageOf,
  parseCookies,
  registerControls,
  type Invoice,
  type RunningFixture,
} from '@tooldrop/fixture-kit';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { verify } from 'otplib';

// A site behind a password and a TOTP second factor, for the vault, login
// recipes, 2FA and session refresh (SPEC, Authentication).

/** The only account. Test-only values: never real credentials (SPEC, Instructions rule 8). */
export const FIXTURE_ACCOUNT = {
  username: 'fixture-user',
  password: 'fixture-password-not-real',
  /** RFC 6238's published test secret ("12345678901234567890"), base32-encoded. */
  totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
} as const;

export function createLoginTotpFixture(): FastifyInstance {
  const app = Fastify();
  acceptFormBodies(app);
  const invoices = createInvoices();
  /** Password accepted, code still needed: pending token -> username. */
  const pending = new Map<string, string>();
  /** Signed in: session token -> username. */
  const sessions = new Map<string, string>();

  registerControls(app, createSwitches({}), () => {
    pending.clear();
    sessions.clear();
  });

  // Expires every session, as a site does after a timeout, so tests can check
  // that a call signs in again instead of failing.
  app.post('/__fixture/expire-sessions', async (_request, reply) => {
    sessions.clear();
    return reply.code(204).send();
  });

  const signedInUser = (request: FastifyRequest) =>
    sessions.get(parseCookies(request.headers.cookie).session ?? '');
  const pendingUser = (request: FastifyRequest) =>
    pending.get(parseCookies(request.headers.cookie).pending ?? '');
  const form = (request: FastifyRequest) => (request.body ?? {}) as Record<string, string | undefined>;

  app.get('/', async (_request, reply) => reply.redirect('/invoices'));

  app.get('/login', async (_request, reply) => reply.type('text/html').send(loginPage()));

  app.post('/login', async (request, reply) => {
    const { username, password } = form(request);
    if (username !== FIXTURE_ACCOUNT.username || password !== FIXTURE_ACCOUNT.password) {
      return reply.code(401).type('text/html').send(loginPage('Wrong username or password.'));
    }
    const token = randomUUID();
    pending.set(token, username);
    return reply.header('set-cookie', cookie('pending', token)).redirect('/login/totp', 303);
  });

  app.get('/login/totp', async (request, reply) => {
    if (!pendingUser(request)) return reply.redirect('/login', 303);
    return reply.type('text/html').send(totpPage());
  });

  app.post('/login/totp', async (request, reply) => {
    const username = pendingUser(request);
    if (!username) return reply.redirect('/login', 303);

    const { code = '' } = form(request);
    const result = await verify({
      secret: FIXTURE_ACCOUNT.totpSecret,
      token: code.trim(),
      epochTolerance: 30,
    });
    if (!result.valid) {
      return reply.code(401).type('text/html').send(totpPage('That code is not right. Try the current one.'));
    }

    pending.delete(parseCookies(request.headers.cookie).pending ?? '');
    const token = randomUUID();
    sessions.set(token, username);
    return reply
      .header('set-cookie', [cookie('session', token), cookie('pending', '', { clear: true })])
      .redirect('/invoices', 303);
  });

  app.get('/api/me', async (request, reply) => {
    const username = signedInUser(request);
    if (!username) return reply.code(401).send({ error: 'unauthorized' });
    return { username };
  });

  app.get('/invoices', async (request, reply) => {
    const username = signedInUser(request);
    if (!username) return reply.redirect('/login', 303);
    return reply.type('text/html').send(invoicesPage(username, pageOf(invoices, 1).items));
  });

  app.post('/logout', async (request, reply) => {
    sessions.delete(parseCookies(request.headers.cookie).session ?? '');
    return reply.header('set-cookie', cookie('session', '', { clear: true })).redirect('/login', 303);
  });

  return app;
}

export function startLoginTotpFixture(port = 0): Promise<RunningFixture> {
  return listen(createLoginTotpFixture(), port);
}

const alert = (message?: string) => (message ? `<p role="alert">${escapeHtml(message)}</p>` : '');

function loginPage(error?: string): string {
  return htmlPage(
    'Sign in',
    `<h1>Sign in</h1>
${alert(error)}
<form method="post" action="/login">
<label>Username <input name="username" autocomplete="username" required></label>
<label>Password <input name="password" type="password" autocomplete="current-password" required></label>
<button type="submit">Sign in</button>
</form>`,
  );
}

function totpPage(error?: string): string {
  return htmlPage(
    'Two-step verification',
    `<h1>Two-step verification</h1>
<p>Enter the 6-digit code from your authenticator app.</p>
${alert(error)}
<form method="post" action="/login/totp">
<label>Authentication code <input name="code" inputmode="numeric" autocomplete="one-time-code" required></label>
<button type="submit">Verify</button>
</form>`,
  );
}

function invoicesPage(username: string, items: Invoice[]): string {
  return htmlPage(
    'Invoices',
    `<nav aria-label="Account">
<span data-testid="account-menu">Signed in as ${escapeHtml(username)}</span>
<form method="post" action="/logout"><button type="submit">Sign out</button></form>
</nav>
<h1>Invoices</h1>
${invoiceTable(items)}`,
  );
}
