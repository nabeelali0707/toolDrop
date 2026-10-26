import {
  ToolDropError,
  type Authority,
  type JsonSchema,
  type Recipe,
  type RunMeta,
  type Step,
  type Strategy,
  type ToolDropErrorJson,
} from '@tooldrop/core';
import { BrowserPool } from './browser/pool.ts';
import { runBrowserRecipe } from './executors/browser.ts';
import { runHttpRecipe } from './executors/http.ts';
import { DEFAULT_RATE_LIMIT, SiteLimiter, type RateLimit } from './limits.ts';
import { SessionPool } from './sessions.ts';
import type { TemplateContext } from './templates.ts';
import { SchemaValidator } from './validate.ts';

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
    if (tool.authority === 'write') {
      throw new ToolDropError(
        'approval_required',
        `${tool.name} changes data; write tools need safe mode (PLAN, Phase 4)`,
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
        const result = await this.#execute(plan, tool, args);
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
        return this.#finish(tool, cacheKey, { result, strategy: plan.strategy, started, attempts });
      } catch (error) {
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

  /** Stops the browser. Call before the process exits. */
  async close(): Promise<void> {
    await this.#browsers.close();
  }

  #finish(
    tool: RunnableTool,
    cacheKey: string,
    run: { result: unknown; strategy: Strategy; started: number; attempts: Attempt[] },
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
    };
    if (tool.cache_ttl_ms) this.#cache.set(cacheKey, { expires: Date.now() + tool.cache_ttl_ms, outcome });
    return outcome;
  }

  #execute(plan: { strategy: Strategy; steps: Step[] }, tool: RunnableTool, input: Record<string, unknown>) {
    const context: TemplateContext = { site: tool.site, input, session: {}, vars: {}, loop: {} };
    const limiter = this.#limiter(tool.site, tool.rate_limit);
    if (plan.strategy === 'browser_script') {
      return runBrowserRecipe(plan.steps, context, {
        pool: this.#browsers,
        siteKey: tool.site,
        limiter,
        ...(this.#options.browserWaitMs !== undefined && { waitMs: this.#options.browserWaitMs }),
      });
    }
    return runHttpRecipe(plan.steps, context, {
      cookieJar: this.#sessions.cookieJar(tool.site),
      limiter,
      ...(this.#options.httpTimeoutMs !== undefined && { timeoutMs: this.#options.httpTimeoutMs }),
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
