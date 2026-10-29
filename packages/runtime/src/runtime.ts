import {
  ToolDropError,
  type Authority,
  type JsonSchema,
  type LoginRecipe,
  type Recipe,
  type RunMeta,
  type Step,
  type Strategy,
  type ToolDropErrorJson,
  type WritePreview,
} from '@tooldrop/core';
import { BrowserPool, type StorageState } from './browser/pool.ts';
import { runBrowserRecipe, toLocator, trackRequests } from './executors/browser.ts';
import { runHttpRecipe } from './executors/http.ts';
import { DEFAULT_RATE_LIMIT, SiteLimiter, type RateLimit } from './limits.ts';
import { SessionPool } from './sessions.ts';
import { samePage } from './steps.ts';
import { renderText, type TemplateContext } from './templates.ts';
import { SchemaValidator } from './validate.ts';
import type { WriteMode, WriteRecord } from './write.ts';

/** Everything the runtime needs to call one published tool. */
export interface RunnableTool {
  name: string;
  authority: Authority;
  input_schema: JsonSchema;
  output_schema: JsonSchema;
  /** The published recipe version. */
  version: number;
  recipe: Recipe;
  /** The site's origin, e.g. http://127.0.0.1:4101 */
  site: string;
  rate_limit?: RateLimit;
  /** Optional response cache for read tools, set at publish time (default off). */
  cache_ttl_ms?: number;
  /** For a site that needs signing in: its sign-in page, where an expired session lands. */
  login?: { url: string };
}

/** What a login recipe signs in with; the one-time code only when the site asks for one. */
export interface LoginValues {
  username: string;
  password: string;
  /** The one-time code, or how to get it once the site has sent it, as with an SMS code. */
  otp?: string | (() => Promise<string>);
}

export interface Attempt {
  strategy: Strategy;
  ok: boolean;
  duration_ms: number;
  error?: ToolDropErrorJson;
}

export interface RunOutcome {
  result: unknown;
  meta: RunMeta;
  /** Every strategy tried, in order, for the run log. */
  attempts: Attempt[];
  /** A write tool's dry run: the filled form (SPEC, Safe mode). */
  screenshot?: Buffer;
  /** Browser steps of the answering plan that found their element only with a later selector. */
  drift?: { strategy: Strategy; steps: { step: number; selector: number }[] };
}

export interface RuntimeOptions {
  /** How long a browser step waits for the page (default 10 s). */
  browserWaitMs?: number;
  httpTimeoutMs?: number;
}

/**
 * Runs published tools without a model (SPEC, Runtime execution cascade):
 * validate the input, run the primary strategy, validate the output, fall back
 * to the browser recipe on failure. Heals arrive in Phase 3; until then a call
 * that every strategy fails ends in a `strategy_failed` error.
 */
export class Runtime {
  readonly #browsers = new BrowserPool();
  readonly #sessions = new SessionPool();
  readonly #limiters = new Map<string, SiteLimiter>();
  readonly #validator = new SchemaValidator();
  readonly #cache = new Map<string, { expires: number; outcome: RunOutcome }>();
  readonly #options: RuntimeOptions;

  constructor(options: RuntimeOptions = {}) {
    this.#options = options;
  }

  async run(tool: RunnableTool, input: unknown = {}): Promise<RunOutcome> {
    const started = performance.now();
    const args = this.#checkedInput(tool, input);
    if (tool.authority === 'write') {
      throw new ToolDropError(
        'approval_required',
        `${tool.name} changes data: it runs through safe mode, as a preview and then an approved commit`,
      );
    }

    const cacheKey = `${tool.name}@${tool.version}:${JSON.stringify(args)}`;
    const cached = tool.cache_ttl_ms ? this.#cache.get(cacheKey) : undefined;
    if (cached && cached.expires > Date.now()) return cached.outcome;

    const plans: { strategy: Strategy; steps: Step[] }[] = [tool.recipe];
    if (tool.recipe.fallback) plans.push(tool.recipe.fallback);

    const attempts: Attempt[] = [];
    let empty: { strategy: Strategy; result: unknown } | undefined;
    for (const [index, plan] of plans.entries()) {
      const attemptStarted = performance.now();
      try {
        const drift: { step: number; selector: number }[] = [];
        const result = await this.#execute(plan, tool, args, drift);
        const output = this.#validator.output(tool.output_schema, result);
        if (!output.ok) {
          throw new ToolDropError(
            'invalid_output',
            `${plan.strategy} returned data that does not match the output schema: ${output.errors.slice(0, 5).join('; ')}`,
            { details: { errors: output.errors } },
          );
        }
        attempts.push({ strategy: plan.strategy, ok: true, duration_ms: elapsed(attemptStarted) });
        // An empty result may be a real answer or a sign the site changed, so
        // the fallback gets a say before it is accepted. If it agrees, the
        // primary strategy's answer stands.
        if (isEmpty(result)) {
          if (index < plans.length - 1) {
            empty ??= { strategy: plan.strategy, result };
            continue;
          }
          if (empty) return this.#finish(tool, cacheKey, { ...empty, started, attempts });
        }
        return this.#finish(tool, cacheKey, { result, strategy: plan.strategy, started, attempts, drift });
      } catch (error) {
        // An expired session fails every strategy alike: the caller signs in again instead.
        if (error instanceof ToolDropError && error.code === 'session_expired') throw error;
        attempts.push({
          strategy: plan.strategy,
          ok: false,
          duration_ms: elapsed(attemptStarted),
          error: toJson(error),
        });
      }
    }
    if (empty) return this.#finish(tool, cacheKey, { ...empty, started, attempts });

    throw new ToolDropError(
      'strategy_failed',
      `every strategy failed for ${tool.name}: ${attempts.map((a) => `${a.strategy}: ${a.error?.message}`).join(' | ')}`,
      { details: { attempts } },
    );
  }

  /**
   * Safe mode: runs a write tool's recipe up to its first commit step and
   * shows what the write would do. Nothing on the site changes (SPEC, Safe
   * mode). A write runs one plan only, the primary.
   */
  async preview(
    tool: RunnableTool,
    input: unknown = {},
  ): Promise<{ preview: WritePreview; screenshot?: Buffer }> {
    const args = this.#checkedInput(tool, input);
    const record: WriteRecord = { fields: [] };
    await this.#execute(tool.recipe, tool, args, [], { mode: 'preview', record });
    if (record.action === undefined) {
      throw new ToolDropError('internal', `${tool.name} has no commit step, so it cannot show a preview`);
    }
    return {
      preview: { url: record.url ?? tool.site, action: record.action, fields: record.fields },
      ...(record.before && { screenshot: record.before }),
    };
  }

  /**
   * Safe mode: makes an approved write, with evidence from before and after
   * its commit step. Only the engine calls this, once an approval allows it.
   * It never throws: `evidence.committed` says whether the site changed even
   * when a later step failed, so the caller knows not to try again blindly.
   */
  async commit(
    tool: RunnableTool,
    input: unknown = {},
  ): Promise<{ outcome?: RunOutcome; error?: ToolDropErrorJson; evidence: WriteRecord }> {
    const started = performance.now();
    const record: WriteRecord = { fields: [] };
    try {
      const args = this.#checkedInput(tool, input);
      const result = await this.#execute(tool.recipe, tool, args, [], { mode: 'commit', record });
      // The write is made: a result in another shape is returned as it is, never as a failure to retry.
      this.#validator.output(tool.output_schema, result);
      const duration = elapsed(started);
      return {
        outcome: {
          result,
          meta: {
            strategy: tool.recipe.strategy,
            duration_ms: duration,
            recipe_version: tool.version,
            healed: false,
          },
          attempts: [{ strategy: tool.recipe.strategy, ok: true, duration_ms: duration }],
        },
        evidence: record,
      };
    } catch (error) {
      return { error: toJson(error), evidence: record };
    }
  }

  /**
   * Signs in with a login recipe in a fresh browser context and returns the
   * session (SPEC, Authentication). Fails with `session_expired` when the
   * signed-in check does not pass, e.g. after a wrong password or code.
   */
  async signIn(
    recipe: LoginRecipe,
    site: string,
    values: LoginValues,
    options: { approvedOrigins?: readonly string[] } = {},
  ): Promise<StorageState> {
    const context = await this.#browsers.fresh();
    try {
      const { otp, ...account } = values;
      const templates: TemplateContext = { site, input: { ...account }, session: {}, vars: {}, loop: {} };
      const waitMs = this.#options.browserWaitMs ?? 10_000;
      await runBrowserRecipe(recipe.steps, templates, {
        context: () => Promise.resolve(context),
        limiter: this.#limiter(site),
        waitMs,
        // The login is typed only on the site or an allowed identity provider, and never past a captcha.
        signIn: { site, approved: options.approvedOrigins ?? [] },
        // A code is asked for only when its step comes: an SMS code exists once the password is in.
        beforeStep: async (step) => {
          if (otp === undefined || templates.input.otp !== undefined) return;
          if (!JSON.stringify(step).includes('input.otp')) return;
          templates.input.otp = typeof otp === 'string' ? otp : await otp();
        },
      });
      const login = renderText(recipe.url, templates);
      const page = await context.newPage();
      try {
        const settle = trackRequests(page);
        const check = recipe.check;
        await page.goto(renderText(check.url, templates), { waitUntil: 'domcontentloaded', timeout: waitMs });
        await settle();
        const onSignIn =
          samePage(page.url(), login) || (await page.locator('input[type=password]').first().isVisible());
        let shown = check.kind !== 'element';
        for (const selector of check.kind === 'element' ? check.target : []) {
          if (await toLocator(page, selector).first().isVisible()) shown = true;
        }
        if (onSignIn || !shown) {
          throw new ToolDropError(
            'session_expired',
            `signing in to ${site} did not work: the site still asks to sign in`,
          );
        }
      } finally {
        await page.close();
      }
      return await context.storageState();
    } finally {
      await context.close();
    }
  }

  /** Makes calls to a site use a saved session: its browser context and its cookie jar. */
  async useSession(site: string, state: StorageState): Promise<void> {
    await this.#browsers.useState(site, state);
    this.#sessions.load(site, state.cookies);
  }

  /** Stops the browser. Call before the process exits. */
  async close(): Promise<void> {
    await this.#browsers.close();
  }

  #finish(
    tool: RunnableTool,
    cacheKey: string,
    run: {
      result: unknown;
      strategy: Strategy;
      started: number;
      attempts: Attempt[];
      drift?: { step: number; selector: number }[];
    },
  ): RunOutcome {
    const outcome: RunOutcome = {
      result: run.result,
      meta: {
        strategy: run.strategy,
        duration_ms: elapsed(run.started),
        recipe_version: tool.version,
        healed: false,
      },
      attempts: run.attempts,
      ...(run.drift && run.drift.length > 0 && { drift: { strategy: run.strategy, steps: run.drift } }),
    };
    if (tool.cache_ttl_ms) this.#cache.set(cacheKey, { expires: Date.now() + tool.cache_ttl_ms, outcome });
    return outcome;
  }

  #checkedInput(tool: RunnableTool, input: unknown): Record<string, unknown> {
    const args = structuredClone(input) as Record<string, unknown>;
    const checked = this.#validator.input(tool.input_schema, args);
    if (!checked.ok) {
      throw new ToolDropError(
        'invalid_input',
        `input does not match ${tool.name}'s schema: ${checked.errors.join('; ')}`,
        {
          details: { errors: checked.errors },
        },
      );
    }
    return args;
  }

  #execute(
    plan: { strategy: Strategy; steps: Step[] },
    tool: RunnableTool,
    input: Record<string, unknown>,
    drift: { step: number; selector: number }[] = [],
    write?: WriteMode,
  ) {
    const context: TemplateContext = { site: tool.site, input, session: {}, vars: {}, loop: {} };
    const limiter = this.#limiter(tool.site, tool.rate_limit);
    if (plan.strategy === 'browser_script') {
      return runBrowserRecipe(plan.steps, context, {
        context: () => this.#browsers.context(tool.site),
        limiter,
        ...(tool.login && { loginUrl: tool.login.url }),
        onDrift: (step, selector) => drift.push({ step, selector }),
        ...(this.#options.browserWaitMs !== undefined && { waitMs: this.#options.browserWaitMs }),
        ...(write && { write }),
      });
    }
    return runHttpRecipe(plan.steps, context, {
      cookieJar: this.#sessions.cookieJar(tool.site),
      limiter,
      ...(tool.login && { loginUrl: tool.login.url }),
      ...(this.#options.httpTimeoutMs !== undefined && { timeoutMs: this.#options.httpTimeoutMs }),
      ...(write && { write }),
    });
  }

  #limiter(site: string, limit: RateLimit = DEFAULT_RATE_LIMIT): SiteLimiter {
    let limiter = this.#limiters.get(site);
    if (!limiter) {
      limiter = new SiteLimiter(limit);
      this.#limiters.set(site, limiter);
    }
    return limiter;
  }
}

function elapsed(since: number): number {
  return Math.round(performance.now() - since);
}

function isEmpty(result: unknown): boolean {
  return (
    result === undefined || result === null || result === '' || (Array.isArray(result) && result.length === 0)
  );
}

function toJson(error: unknown): ToolDropErrorJson {
  if (error instanceof ToolDropError) return error.toJSON();
  return { code: 'internal', message: error instanceof Error ? error.message : String(error) };
}
