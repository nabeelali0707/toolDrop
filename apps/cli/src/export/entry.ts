import {
  ToolDropError,
  type Authority,
  type JsonSchema,
  type LoginRecipe,
  type Recipe,
} from '@tooldrop/core';
import { Runtime, type RateLimit, type RunnableTool } from '@tooldrop/runtime';
import { generate } from 'otplib';

// The runtime an exported tool carries (SPEC, Code export): toolDrop's own
// runtime, bundled into the package's runtime.js, so the tool runs without
// toolDrop. It signs in with the login its caller passes and keeps nothing.

/** What an exported package's tool.json holds. */
export interface ExportedTool {
  name: string;
  description: string;
  authority: Authority;
  input_schema: JsonSchema;
  output_schema: JsonSchema;
  version: number;
  recipe: Recipe;
  /** The site's origin when the tool was exported. */
  site: string;
  rate_limit?: RateLimit;
  /** How toolDrop signed in to the site, for a site that needs it: steps, never a login. */
  login_recipe?: LoginRecipe;
}

export interface ToolOptions {
  /** Another origin for the same site, such as a staging copy. */
  site?: string;
  /** The account to sign in with, for a site that needs one. Read it from the environment, never from code. */
  login?: {
    username: string;
    password: string;
    /** The authenticator secret, for sites that ask for a one-time code. */
    totp_secret?: string;
    /** Or a way to get the code, e.g. by asking a person. */
    otp?: () => Promise<string>;
  };
  /** How long a browser step waits for the page, in milliseconds (default 10 000). */
  browserWaitMs?: number;
}

export function createTool(definition: ExportedTool) {
  let runtime: Runtime | undefined;
  /** The origin signed in to, and how that went. */
  let signedIn: { origin: string; done: Promise<void> } | undefined;

  const origin = (options: ToolOptions) => new URL(options.site ?? definition.site).origin;
  const runnable = (options: ToolOptions): RunnableTool => ({
    name: definition.name,
    authority: definition.authority,
    input_schema: definition.input_schema,
    output_schema: definition.output_schema,
    version: definition.version,
    recipe: definition.recipe,
    site: origin(options),
    ...(definition.rate_limit && { rate_limit: definition.rate_limit }),
    ...(definition.login_recipe && {
      login: { url: definition.login_recipe.url.replaceAll('{{site}}', origin(options)) },
    }),
  });
  const runtimeFor = (options: ToolOptions) =>
    (runtime ??= new Runtime(
      options.browserWaitMs !== undefined ? { browserWaitMs: options.browserWaitMs } : {},
    ));

  /** Signs in once per origin, and again when `renew` says the session ended. */
  function signIn(options: ToolOptions, renew = false): Promise<void> {
    const recipe = definition.login_recipe;
    if (!recipe) return Promise.resolve();
    const site = origin(options);
    if (signedIn?.origin === site && !renew) return signedIn.done;
    const login = options.login;
    if (!login) {
      return Promise.reject(
        new ToolDropError(
          'session_expired',
          `${definition.name} needs a login for ${site}: pass { login: { username, password } }`,
        ),
      );
    }
    const done = (async () => {
      const { totp_secret: secret, otp, username, password } = login;
      const code = secret ? () => generate({ secret }) : otp;
      const state = await runtimeFor(options).signIn(recipe, site, {
        username,
        password,
        ...(code && { otp: code }),
      });
      await runtimeFor(options).useSession(site, state);
    })();
    signedIn = { origin: site, done };
    done.catch(() => {
      if (signedIn?.done === done) signedIn = undefined;
    });
    return done;
  }

  /** Runs `work` signed in; an expired session signs in again and runs it once more. */
  async function withSession<T>(options: ToolOptions, work: () => Promise<T>): Promise<T> {
    await signIn(options);
    try {
      return await work();
    } catch (error) {
      if (!definition.login_recipe || !(error instanceof ToolDropError && error.code === 'session_expired')) {
        throw error;
      }
      await signIn(options, true);
      return work();
    }
  }

  return {
    /** Calls a read tool and returns its result. */
    run(input: unknown = {}, options: ToolOptions = {}): Promise<unknown> {
      if (definition.authority === 'write') {
        return Promise.reject(
          new ToolDropError(
            'approval_required',
            `${definition.name} changes the site: call preview(), then commit()`,
          ),
        );
      }
      return withSession(
        options,
        async () => (await runtimeFor(options).run(runnable(options), input)).result,
      );
    },

    /** A write tool's preview: the page, the action and the fields, and a PNG of the filled form. Nothing is submitted. */
    preview(input: unknown = {}, options: ToolOptions = {}) {
      return withSession(options, () => runtimeFor(options).preview(runnable(options), input));
    },

    /** Makes a write tool's write, and returns what the site answered. Call it only for a write you mean to make. */
    async commit(input: unknown = {}, options: ToolOptions = {}): Promise<unknown> {
      await signIn(options);
      const { outcome, error, evidence } = await runtimeFor(options).commit(runnable(options), input);
      if (outcome) return outcome.result;
      // Past the submit, the site may have taken the write: never try it again blindly.
      const made = evidence.committed
        ? 'The write was submitted, but a step after it failed, so check the site before trying again'
        : 'The write was not made';
      throw new ToolDropError(error?.code ?? 'strategy_failed', `${made}: ${error?.message ?? 'it failed'}`, {
        details: { committed: evidence.committed === true },
      });
    },

    /** Closes the browser, if one opened. */
    async close(): Promise<void> {
      await runtime?.close();
      runtime = undefined;
      signedIn = undefined;
    },
  };
}
