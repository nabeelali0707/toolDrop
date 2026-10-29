import { loginSecret, totpCode, waitForEmailCode } from '@tooldrop/auth';
import { buildLoginRecipe } from '@tooldrop/compiler';
import { loginRecipeSchema, needsCode, ToolDropError, type LoginRecipe } from '@tooldrop/core';
import {
  approveAuthOrigin,
  approvedAuthOrigins,
  getLoginRecipe,
  latestSession,
  saveLoginRecipe,
  saveSession,
  setLoginStatus,
  siteLogin,
  type LoginWithSite,
} from '@tooldrop/db';
import { signInByHand, type StorageState } from '@tooldrop/runtime';
import type { Browser } from 'playwright';
import type { Engine } from './engine.ts';

// Signed-in sessions (SPEC, Authentication): a site with a saved login signs
// in with its login recipe, which is built the first time, and keeps the
// session sealed in the vault until the site rejects it.

export interface SignInOptions {
  /** Sign in even when a saved session exists, e.g. after it expired. */
  force?: boolean;
  /**
   * Asks a person: for a code, for logins whose codes arrive another way (SPEC, 2FA: human
   * in the loop); to allow an identity provider; or to sign in by hand past a captcha.
   */
  ask?: (question: { text: string; options?: string[] }) => Promise<string>;
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
    // An SMS code counts if it arrived after this sign-in began (SPEC, SMS codes).
    const started = Date.now();
    const otp = async () => {
      if (secret.totp_secret) return totpCode(secret.totp_secret);
      if (saved.login.twofa_method === 'email') {
        const mailbox = await this.#engine.mailbox();
        if (!mailbox) {
          throw new ToolDropError(
            'session_expired',
            `signing in to ${origin} needs an email code, and no mailbox is connected; run \`tooldrop email connect\``,
          );
        }
        const config = saved.login.twofa_config ?? {};
        return waitForEmailCode(mailbox, {
          after: started,
          ...(config.sender && { sender: config.sender }),
          ...(config.code_pattern && { pattern: config.code_pattern }),
        });
      }
      if (saved.login.twofa_method === 'sms') {
        const config = saved.login.twofa_config ?? {};
        return this.#engine.sms.waitForCode({
          after: started,
          ...(config.sender && { sender: config.sender }),
          ...(config.code_pattern && { pattern: config.code_pattern }),
        });
      }
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
      ({ recipe: used, state } = await this.#signIn(origin, saved, options, async (approved) => {
        if (recipe && byHand(recipe)) {
          throw signInByHand(origin, 'is done by a person, and the last session from it has ended');
        }
        if (recipe) {
          const values = { username: secret.username, password: secret.password };
          const code = needsCode(recipe) ? { otp } : {};
          return {
            recipe,
            state: await this.#engine.runtime.signIn(
              recipe,
              origin,
              { ...values, ...code },
              { approvedOrigins: approved },
            ),
          };
        }
        const built = await buildLoginRecipe(
          origin,
          { username: secret.username, password: secret.password, otp },
          { ...(this.#browser && { browser: this.#browser }), approvedOrigins: approved },
        );
        saveLoginRecipe(db, origin, built.recipe, 'build');
        return built;
      }));
    } catch (error) {
      // A person has to act; the login itself may be fine.
      if (!(error instanceof ToolDropError && error.code === 'human_needed')) {
        setLoginStatus(db, saved.login.id, 'needs_attention');
      }
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

  /**
   * The saved login's values for a site, so prompts mask them. Nothing may
   * ever show the password or the authenticator secret. A signed-in page can
   * show the username, which is masked too, unless it is a plain word such as
   * "admin": sites use the same word in paths and labels, and masking those
   * would hide the recipe from the model.
   */
  async secretsFor(site: string): Promise<string[]> {
    const saved = siteLogin(this.#engine.db, site);
    if (!saved) return [];
    const secret = loginSecret(await this.#engine.vault(), saved.login.encrypted_secret);
    const values = [secret.password, ...(secret.totp_secret ? [secret.totp_secret] : [])];
    return /[^a-z]/i.test(secret.username) ? [secret.username, ...values] : values;
  }

  /**
   * Keeps a session a person made by signing in themselves, such as past a
   * captcha (SPEC: captchas go to a human). Its login recipe only opens the
   * sign-in page, which tells later sign-ins that a person does them.
   */
  async saveByHand(
    site: string,
    signedIn: { state: StorageState; signInUrl: string; landingUrl: string },
  ): Promise<void> {
    const origin = new URL(site).origin;
    const db = this.#engine.db;
    const saved = siteLogin(db, origin);
    if (!saved) {
      throw new ToolDropError(
        'not_found',
        `there is no saved login for ${origin}; add one first with \`tooldrop logins add ${origin}\``,
      );
    }
    const recipe = loginRecipeSchema.parse({
      url: signedIn.signInUrl,
      steps: [{ op: 'goto', url: signedIn.signInUrl }],
      check: { kind: 'page', url: signedIn.landingUrl },
    });
    saveLoginRecipe(db, origin, recipe, 'user');
    saveSession(db, {
      login_id: saved.login.id,
      storage_state: (await this.#engine.vault()).sealJson(signedIn.state),
      expires_at: expiry(signedIn.state),
    });
    setLoginStatus(db, saved.login.id, 'verified');
    await this.#use(origin, saved, { loginUrl: signedIn.signInUrl, state: signedIn.state });
  }

  /**
   * Signs in, asking a person when the site needs one (SPEC, Authentication):
   * to allow an identity provider on another origin, once, or to sign in by
   * hand past a captcha while a build waits. Without anyone to ask, the error
   * says what to do.
   */
  async #signIn(
    origin: string,
    saved: LoginWithSite,
    options: SignInOptions,
    attempt: (approved: string[]) => Promise<{ recipe: LoginRecipe; state: StorageState }>,
  ): Promise<{ recipe: LoginRecipe; state: StorageState }> {
    const db = this.#engine.db;
    const approved = approvedAuthOrigins(db, origin);
    for (let round = 1; ; round++) {
      try {
        return await attempt(approved);
      } catch (error) {
        if (!(error instanceof ToolDropError) || error.code !== 'human_needed' || !options.ask || round > 3) {
          throw error;
        }
        const { approve_origin: other } = (error.details ?? {}) as { approve_origin?: string };
        if (other) {
          const answer = await options.ask({
            text: `Signing in to ${origin} goes through ${other}, another site. Should toolDrop type the saved login there from now on?`,
            options: ['allow', 'deny'],
          });
          if (answer.trim().toLowerCase() !== 'allow') {
            throw new ToolDropError(
              'human_needed',
              `toolDrop will not type the login for ${origin} on ${other}: it was not allowed`,
              {
                details: { approve_origin: other, denied: true },
              },
            );
          }
          approveAuthOrigin(db, origin, other);
          approved.push(other);
          continue;
        }
        // A person signs in by hand; the build waits until they say it is done.
        const asked = Date.now();
        await options.ask({ text: `${error.message} Answer "done" once you have.`, options: ['done'] });
        const session = latestSession(db, saved.login.id);
        const recipe = getLoginRecipe(db, origin);
        if (!session || !recipe || session.created_at.getTime() < asked) throw error;
        return { recipe, state: (await this.#engine.vault()).openJson<StorageState>(session.storage_state) };
      }
    }
  }

  async #use(origin: string, saved: LoginWithSite, signedIn: SignedIn): Promise<SignedIn> {
    await this.#engine.runtime.useSession(origin, signedIn.state);
    this.#loaded.set(origin, { loginId: saved.login.id, signedIn });
    return signedIn;
  }
}

/** A login recipe that only opens pages: a person signs in, as after a captcha. */
function byHand(recipe: LoginRecipe): boolean {
  return recipe.steps.every((step) => step.op === 'goto');
}

function resolve(url: string, origin: string): string {
  return url.replaceAll('{{site}}', origin);
}

/** When the first of the session's cookies runs out, if any does. */
function expiry(state: StorageState): Date | null {
  const times = state.cookies.map((cookie) => cookie.expires).filter((expires) => expires > 0);
  return times.length > 0 ? new Date(Math.min(...times) * 1000) : null;
}
