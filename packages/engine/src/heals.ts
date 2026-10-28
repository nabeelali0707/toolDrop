import { ToolDropError, type Recipe, type Strategy, type ToolDropErrorJson } from '@tooldrop/core';
import {
  createJob,
  setJobStatus,
  setJobStep,
  setToolStatus,
  testInputs,
  touchJob,
  type PublishedTool,
} from '@tooldrop/db';
import { healStep, rebuildPrimary, refreshSelectors, type Healed, type HealTarget } from '@tooldrop/healer';
import type { Attempt } from '@tooldrop/runtime';
import type { Engine } from './engine.ts';
import { InProcessQueue } from './queue.ts';

// Heal jobs (SPEC, Self-healing): a repair is a job like a build, published as
// the tool's next version with its reason. Heals have their own queue, so a
// held call never waits behind a long build.

export type HealTrigger =
  /** Every strategy failed: repair the browser step that broke. The call waits. */
  | { kind: 'failure'; error: ToolDropErrorJson }
  /** The fast path failed but the browser answered: rebuild the fast path in the background. */
  | { kind: 'fast_path'; error: string }
  /** A browser step found its element only with a later selector: refresh its selectors. */
  | { kind: 'drift'; drift: { strategy: Strategy; steps: { step: number; selector: number }[] } };

export type HealEnd = 'healed' | 'failed' | 'timeout';

/** After a heal fails, a tool is left alone this long, so each call does not start another. */
const COOLDOWN_MS = 60 * 60_000;
const HEARTBEAT_MS = 10_000;

export class Heals {
  readonly #engine: Engine;
  readonly #queue = new InProcessQueue(1);
  /** The heal job running for each tool. */
  readonly #running = new Map<string, string>();
  readonly #done = new Map<string, Promise<boolean>>();
  readonly #failedAt = new Map<string, number>();

  constructor(engine: Engine) {
    this.#engine = engine;
  }

  /**
   * Starts a heal for a tool, or returns the one already running for it.
   * Undefined when no heal can start: no model for one that needs it, or a
   * recent heal of this tool failed.
   */
  start(tool: PublishedTool, trigger: HealTrigger): string | undefined {
    const running = this.#running.get(tool.name);
    if (running) return running;
    if (Date.now() - (this.#failedAt.get(tool.name) ?? 0) < COOLDOWN_MS) return undefined;
    if (trigger.kind !== 'drift' && !this.#engine.builds.llm) return undefined;

    const db = this.#engine.db;
    const job = createJob(db, { kind: 'heal', input: { tool: tool.name, version: tool.version, trigger } });
    this.#running.set(tool.name, job.id);
    const heartbeat = setInterval(() => touchJob(db, job.id), HEARTBEAT_MS);
    heartbeat.unref();
    const done = new Promise<boolean>((resolve) => {
      this.#queue.enqueue(async () => {
        try {
          resolve(await this.#run(job.id, tool, trigger));
        } finally {
          clearInterval(heartbeat);
          this.#running.delete(tool.name);
        }
      });
    });
    this.#done.set(job.id, done);
    return job.id;
  }

  /** Waits up to `ms` for a heal job of this process to finish. */
  async wait(jobId: string, ms: number): Promise<HealEnd> {
    const done = this.#done.get(jobId);
    if (!done) return 'failed';
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<HealEnd>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), ms);
    });
    try {
      return await Promise.race([done.then((healed): HealEnd => (healed ? 'healed' : 'failed')), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Waits until every heal of this process has finished, e.g. before exit. */
  idle(): Promise<void> {
    return this.#queue.idle();
  }

  async #run(jobId: string, tool: PublishedTool, trigger: HealTrigger): Promise<boolean> {
    const db = this.#engine.db;
    try {
      setJobStatus(db, jobId, 'running', { step: 'diagnosing' });
      const signedIn = await this.#engine.sessions.ensure(tool.site.origin);
      const llm = this.#engine.builds.llm;
      const browser = this.#engine.builds.browser;
      const target: HealTarget = {
        name: tool.name,
        description: tool.description,
        site: tool.site.origin,
        recipe: tool.recipe,
        input_schema: tool.input_schema,
        output_schema: tool.output_schema,
        test_inputs: testInputs(db, tool.id, tool.version),
        rate_limit: tool.site.rate_limit,
      };
      const deps = {
        runtime: this.#engine.runtime,
        jobId,
        step: (name: string) => setJobStep(db, jobId, name),
        ...(llm && { llm }),
        ...(browser && { browser }),
        ...(signedIn && { signedIn }),
      };
      let healed: Healed;
      if (trigger.kind === 'drift') healed = await refreshSelectors(target, trigger.drift, deps);
      else if (trigger.kind === 'fast_path') healed = await rebuildPrimary(target, trigger.error, deps);
      else healed = await healStep(target, failingStep(tool.recipe, trigger.error), deps);

      const published = this.#engine.publish(
        {
          name: tool.name,
          description: tool.description,
          authority: tool.authority,
          input_schema: tool.input_schema,
          output_schema: tool.output_schema,
          recipe: healed.recipe,
        },
        tool.site.origin,
        { created_by: 'heal', change_reason: healed.reason, test_inputs: target.test_inputs },
      );
      setJobStatus(db, jobId, 'succeeded', {
        step: null,
        result: {
          tool: tool.name,
          version: published.version,
          reason: healed.reason,
          attempts: healed.attempts,
          kind: trigger.kind,
        },
      });
      return true;
    } catch (error) {
      // A tool that does not work at all and could not be repaired is degraded (SPEC, Self-healing step 5).
      if (trigger.kind === 'failure') setToolStatus(db, tool.name, 'degraded');
      this.#failedAt.set(tool.name, Date.now());
      const json =
        error instanceof ToolDropError
          ? error.toJSON()
          : { code: 'internal' as const, message: error instanceof Error ? error.message : String(error) };
      setJobStatus(db, jobId, 'failed', { step: null, error: json });
      return false;
    }
  }
}

/** Which browser step broke, from a strategy_failed error's attempts. */
export function failingStep(
  recipe: Recipe,
  error: ToolDropErrorJson,
): { plan: 'primary' | 'fallback'; step: number; error: string } {
  const plan = recipe.fallback ? 'fallback' : recipe.strategy === 'browser_script' ? 'primary' : undefined;
  if (!plan) {
    throw new ToolDropError(
      'strategy_failed',
      'the recipe has no browser steps to repair: rebuild the tool instead',
    );
  }
  const attempts = (error.details?.attempts ?? []) as Attempt[];
  const attempt = attempts.findLast((candidate) => candidate.strategy === 'browser_script');
  const step = attempt?.error?.details?.step;
  return {
    plan,
    step: typeof step === 'number' ? step : 0,
    error: attempt?.error?.message ?? error.message,
  };
}
