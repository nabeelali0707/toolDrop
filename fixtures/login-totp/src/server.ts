import { createHmac, randomInt, randomUUID } from 'node:crypto';
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
// recipes, 2FA and session refresh (SPEC, Authentication). Two switches
// change how it signs in: through an identity provider on another origin
// (localhost instead of 127.0.0.1, served by the same server), or behind a
// captcha that only a person can solve.

export interface LoginTotpSwitches extends Record<string, boolean> {
  /** Sign-in goes through an identity provider on another origin, which sends back a one-time code. */
  ssoLogin: boolean;
  /** The sign-in form shows a captcha and is refused until it is solved. */
  captcha: boolean;
  /** The code comes by SMS instead of an authenticator: sent to the forwarder set with /__fixture/sms-forwarder. */
  smsCode: boolean;
}

/** Who the fixture's SMS codes come from: a number reserved for fiction. */
export const FIXTURE_SMS_SENDER = '+1 555 555 0100';

/** The captcha's answer a person gives; a test plays the person. */
export const CAPTCHA_SOLVED = 'solved-by-a-person';

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

  /** Identity provider codes: one-time code -> username. */
  const ssoCodes = new Map<string, string>();
  const switches = createSwitches<LoginTotpSwitches>({ ssoLogin: false, captcha: false, smsCode: false });
  /** The code each pending sign-in was sent by SMS: pending token -> code. */
  const smsCodes = new Map<string, string>();
  /** Where the phone's forwarder posts SMS, as SMS to URL Forwarder does: the URL and its signing secret. */
  let forwarder: { url: string; secret: string } | undefined;
  registerControls(app, switches, () => {
    pending.clear();
    sessions.clear();
    ssoCodes.clear();
    smsCodes.clear();
    forwarder = undefined;
  });

  app.post('/__fixture/sms-forwarder', async (request, reply) => {
    const { url, secret } = (request.body ?? {}) as { url?: string; secret?: string };
    if (!url || !secret) return reply.code(400).send({ error: 'send {"url": "...", "secret": "..."}' });
    forwarder = { url, secret };
    return reply.code(204).send();
  });
  /** This server under another host name: the identity provider's origin, or the site's. */
  const on = (request: FastifyRequest, host: 'localhost' | '127.0.0.1') =>
    `http://${host}:${(request.headers.host ?? '').split(':')[1] ?? ''}`;

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

  app.get('/login', async (request, reply) => {
    if (switches.current.ssoLogin) return reply.redirect(`${on(request, 'localhost')}/sso/login`, 303);
    return reply.type('text/html').send(loginPage(undefined, switches.current.captcha));
  });

  app.post('/login', async (request, reply) => {
    const { username, password, 'g-recaptcha-response': captcha } = form(request);
    if (switches.current.captcha && captcha !== CAPTCHA_SOLVED) {
      return reply.code(401).type('text/html').send(loginPage('Please prove you are not a robot.', true));
    }
    if (username !== FIXTURE_ACCOUNT.username || password !== FIXTURE_ACCOUNT.password) {
      return reply
        .code(401)
        .type('text/html')
        .send(loginPage('Wrong username or password.', switches.current.captcha));
    }
    const token = randomUUID();
    pending.set(token, username);
    if (switches.current.smsCode) {
      const code = String(100_000 + randomInt(900_000));
      smsCodes.set(token, code);
      await sendSms(forwarder, `Your Example Invoices code is ${code}. It expires in 10 minutes.`);
    }
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
    const sent = smsCodes.get(parseCookies(request.headers.cookie).pending ?? '');
    const result = sent
      ? { valid: code.trim() === sent }
      : await verify({
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

  // The identity provider: its own sign-in page, then a one-time code back to the site.
  app.get('/sso/login', async (_request, reply) => reply.type('text/html').send(ssoPage()));

  app.post('/sso/login', async (request, reply) => {
    const { username, password } = form(request);
    if (username !== FIXTURE_ACCOUNT.username || password !== FIXTURE_ACCOUNT.password) {
      return reply.code(401).type('text/html').send(ssoPage('Wrong username or password.'));
    }
    const code = randomUUID();
    ssoCodes.set(code, username);
    return reply.redirect(`${on(request, '127.0.0.1')}/sso/callback?code=${code}`, 303);
  });

  app.get('/sso/callback', async (request, reply) => {
    const { code = '' } = request.query as { code?: string };
    const username = ssoCodes.get(code);
    if (!username) return reply.redirect('/login', 303);
    ssoCodes.delete(code);
    const token = randomUUID();
    sessions.set(token, username);
    return reply.header('set-cookie', cookie('session', token)).redirect('/invoices', 303);
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

/** Posts an SMS the way SMS to URL Forwarder does: its JSON template, signed with HMAC-SHA256. */
async function sendSms(forwarder: { url: string; secret: string } | undefined, text: string): Promise<void> {
  if (!forwarder) return;
  const body = JSON.stringify({ from: FIXTURE_SMS_SENDER, text, receivedStamp: String(Date.now()) });
  const signature = createHmac('sha256', forwarder.secret).update(body).digest('hex');
  await fetch(forwarder.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature': signature },
    body,
  }).catch(() => undefined);
}

export function startLoginTotpFixture(port = 0): Promise<RunningFixture> {
  return listen(createLoginTotpFixture(), port);
}

const alert = (message?: string) => (message ? `<p role="alert">${escapeHtml(message)}</p>` : '');

function loginPage(error?: string, captcha = false): string {
  // Shaped like reCAPTCHA's widget; the hidden answer stays empty until a person solves it.
  const challenge = captcha
    ? '<div class="g-recaptcha" data-sitekey="fixture-sitekey-not-real">I am not a robot</div><input type="hidden" name="g-recaptcha-response" value="">'
    : '';
  return htmlPage(
    'Sign in',
    `<h1>Sign in</h1>
${alert(error)}
<form method="post" action="/login">
${challenge}
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

function ssoPage(error?: string): string {
  return htmlPage(
    'Example Identity',
    `<h1>Example Identity</h1>
<p>Sign in to continue to the invoice site.</p>
${alert(error)}
<form method="post" action="/sso/login">
<label>Username <input name="username" autocomplete="username" required></label>
<label>Password <input name="password" type="password" autocomplete="current-password" required></label>
<button type="submit">Continue</button>
</form>`,
  );
}
