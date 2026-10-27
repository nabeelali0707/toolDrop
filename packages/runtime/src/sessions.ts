import { Cookie, CookieJar } from 'tough-cookie';
import type { StorageState } from './browser/pool.ts';

/**
 * Sessions for the HTTP strategies: one cookie jar per site, kept across
 * calls so a call reuses the cookies the last one received (SPEC: reuse
 * sessions instead of logging in per call). A signed-in site's jar starts
 * from its saved session; browser sessions live in the browser pool.
 */
export class SessionPool {
  readonly #jars = new Map<string, CookieJar>();

  cookieJar(siteKey: string): CookieJar {
    let jar = this.#jars.get(siteKey);
    if (!jar) {
      jar = new CookieJar();
      this.#jars.set(siteKey, jar);
    }
    return jar;
  }

  /** Replaces a site's cookies with a saved session's. */
  load(siteKey: string, cookies: StorageState['cookies']): void {
    const jar = new CookieJar();
    for (const cookie of cookies) {
      const shared = cookie.domain.startsWith('.');
      const host = cookie.domain.replace(/^\./, '');
      jar.setCookieSync(
        new Cookie({
          key: cookie.name,
          value: cookie.value,
          // A host-only cookie takes its host from the URL; a domain on it would make
          // the jar treat an address like 127.0.0.1 as a public suffix and refuse it.
          ...(shared && { domain: host }),
          path: cookie.path,
          httpOnly: cookie.httpOnly,
          secure: cookie.secure,
          ...(cookie.expires > 0 && { expires: new Date(cookie.expires * 1000) }),
        }),
        `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path}`,
      );
    }
    this.#jars.set(siteKey, jar);
  }

  /** Forgets a site's cookies, e.g. after the site rejected them. */
  forget(siteKey: string): void {
    this.#jars.delete(siteKey);
  }
}
