import type { FastifyInstance } from 'fastify';

export interface RunningFixture {
  /** Base URL, e.g. http://127.0.0.1:4101 */
  url: string;
  close(): Promise<void>;
}

/** Starts a fixture on 127.0.0.1. Port 0 picks a free port, which tests use. */
export async function listen(app: FastifyInstance, port = 0): Promise<RunningFixture> {
  await app.listen({ host: '127.0.0.1', port });
  const address = app.server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;
  return { url: `http://127.0.0.1:${actualPort}`, close: () => app.close() };
}

/** Parses HTML form posts, which Fastify does not do by default. */
export function acceptFormBodies(app: FastifyInstance): void {
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    },
  );
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator > 0) cookies[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
  }
  return cookies;
}

/** A Set-Cookie value. An empty value with `clear` deletes the cookie. */
export function cookie(name: string, value: string, options: { clear?: boolean } = {}): string {
  const expiry = options.clear ? '; Max-Age=0' : '';
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax${expiry}`;
}
