import { loginSecret, totpCode } from '@tooldrop/auth';
import { buildLoginRecipe } from '@tooldrop/compiler';
import { needsCode, ToolDropError, type LoginRecipe } from '@tooldrop/core';
import {
  getLoginRecipe,
  latestSession,
  saveLoginRecipe,
  saveSession,
  setLoginStatus,
  siteLogin,
  type LoginWithSite,
} from '@tooldrop/db';
import type { StorageState } from '@tooldrop/runtime';
import type { Browser } from 'playwright';
import type { Engine } from './engine.ts';

// Signed-in sessions (SPEC, Authentication): a site with a saved login signs
// in with its login recipe, which is built the first time, and keeps the
// session sealed in the vault until the site rejects it.

export interface SignInOptions {
  /** Sign in even when a saved session exists, e.g. after it expired. */
  force?: boolean;
  /** Asks a person for a code, for logins whose codes arrive another way (SPEC, 2FA: human in the loop). */
  ask?: (question: { text: string }) => Promise<string>;
}

/** What calls to a signed-in site need. */
export interface SignedIn {
  /** The sign-in page, where an expired session lands. */
  loginUrl: string;
  state: StorageState;
}

export class Sessions {
  readonly #engine: Engine;
  readonly #browser: Browser | undefined;
  /** The session the runtime uses for each site, and the login it belongs to. */
  readonly #loaded = new Map<string, { loginId: string; signedIn: SignedIn }>();
  /** Sign-ins in progress, so concurrent calls to a site share one. */
  readonly #pending = new Map<string, Promise<SignedIn | undefined>>();

  constructor(engine: Engine, options: { browser?: Browser } = {}) {
    this.#engine = engine;
    this.#browser = options.browser;
  }

  /**
   * Makes the runtime use a signed-in session for the site, when the site has
   * a saved login: the saved session if there is one, or a fresh sign-in.
   * Undefined for a site without a saved login.
   */
  ensure(site: string, options: SignInOptions = {}): Promise<SignedIn | undefined> {
    const origin = new URL(site).origin;
    const running = this.#pending.get(origin);
    if (running && !options.force) return running;
    const next = this.#ensure(origin, options).finally(() => {
      if (this.#pending.get(origin) === next) this.#pending.delete(origin);
    });
    this.#pending.set(origin, next);
    return next;
  }

  async #ensure(origin: string, options: SignInOptions): Promise<SignedIn | undefined> {
    const db = this.#engine.db;
    const saved = siteLogin(db, origin);
    if (!saved) return undefined;
    const loaded = this.#loaded.get(origin);
    if (!options.force && loaded?.loginId === saved.login.id) return loaded.signedIn;

    const vault = await this.#engine.vault();
    const recipe = getLoginRecipe(db, origin);
    const session = latestSession(db, saved.login.id);
    if (!options.force && recipe && session) {
      return this.#use(origin, saved, {
        loginUrl: resolve(recipe.url, origin),
        state: vault.openJson<StorageState>(session.storage_state),
      });
    }

    const secret = loginSecret(vault, saved.login.encrypted_secret);
    const otp = async () => {
      if (secret.totp_secret) return totpCode(secret.totp_secret);
      if (saved.login.twofa_method === 'human' && options.ask) {
        return (await options.ask({ text: `Enter the sign-in code ${origin} just sent you.` })).trim();
      }
      throw new ToolDropError(
        'session_expired',
        `signing in to ${origin} needs a one-time code, and its saved login has no authenticator secret`,
      );
    };
    let used: LoginRecipe;
    let state: StorageState;
    try {
      if (recipe) {
        used = recipe;
        state = await this.#engine.runtime.signIn(recipe, origin, {
          username: secret.username,
          password: secret.password,
          ...(needsCode(recipe) && { otp: await otp() }),
        });
      } else {
        const built = await buildLoginRecipe(
          origin,
          { username: secret.username, password: secret.password, otp },
          this.#browser ? { browser: this.#browser } : {},
        );
        saveLoginRecipe(db, origin, built.recipe, 'build');
        used = built.recipe;
        state = built.state;
      }
    } catch (error) {
      setLoginStatus(db, saved.login.id, 'needs_attention');
      throw error;
    }
    saveSession(db, {
      login_id: saved.login.id,
      storage_state: vault.sealJson(state),
      expires_at: expiry(state),
    });
    setLoginStatus(db, saved.login.id, 'verified');
    return this.#use(origin, saved, { loginUrl: resolve(used.url, origin), state });
  }

  async #use(origin: string, saved: LoginWithSite, signedIn: SignedIn): Promise<SignedIn> {
    await this.#engine.runtime.useSession(origin, signedIn.state);
    this.#loaded.set(origin, { loginId: saved.login.id, signedIn });
    return signedIn;
  }
}

function resolve(url: string, origin: string): string {
  return url.replaceAll('{{site}}', origin);
}

/** When the first of the session's cookies runs out, if any does. */
function expiry(state: StorageState): Date | null {
  const times = state.cookies.map((cookie) => cookie.expires).filter((expires) => expires > 0);
  return times.length > 0 ? new Date(Math.min(...times) * 1000) : null;
}
