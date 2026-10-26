import { CookieJar } from 'tough-cookie';

/**
 * Sessions for the HTTP strategies: one cookie jar per site, kept across
 * calls so a call reuses the cookies the last one received (SPEC: reuse
 * sessions instead of logging in per call). Browser sessions live in the
 * browser pool's warm contexts. Signing in again when a session expires
 * arrives with login recipes (PLAN, task 3.5).
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

  /** Forgets a site's cookies, e.g. after the site rejected them. */
  forget(siteKey: string): void {
    this.#jars.delete(siteKey);
  }
}
