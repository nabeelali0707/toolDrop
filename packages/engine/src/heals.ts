import { ToolDropError, type Recipe, type Strategy, type ToolDropErrorJson } from '@tooldrop/core';
import {
  createJob,
  getJob,
  getTool,
  setJobStatus,
  setJobStep,
  setToolStatus,
  testInputs,
  type PublishedTool,
} from '@tooldrop/db';
import { healStep, rebuildPrimary, refreshSelectors, type Healed, type HealTarget } from '@tooldrop/healer';
import type { Attempt } from '@tooldrop/runtime';
import type { Engine } from './engine.ts';
import { JobHolds } from './job-holds.ts';
import { InProcessQueue, type JobQueue } from './queue.ts';

// Heal jobs (SPEC, Self-healing): a repair is a job like a build, published as
// the tool's next version with its reason. Heals have their own queue, so a
// held call never waits behind a long build. With a shared queue a heal may
// run in another process; a call waiting for it watches its job.

export type HealTrigger =
  /** Every strategy failed: repair the browser step that broke. The call waits. */
  | { kind: 'failure'; error: ToolDropErrorJson }
  /** The fast path failed but the browser answered: rebuild the fast path in the background. */
  | { kind: 'fast_path'; error: string }
  /** A browser step found its element only with a later selector: refresh its selectors. */
  | { kind: 'drift'; drift: { strategy: Strategy; steps: { step: number; selector: number }[] } };

export type HealEnd = 'healed' | 'failed' | 'timeout';

/** What a heal job holds: the tool and version to repair, and why. */
interface HealInput {
  tool: string;
  version: number;
  trigger: HealTrigger;
}

/** After a heal fails, a tool is left alone this long, so each call does not start another. */
const COOLDOWN_MS = 60 * 60_000;
/** How often a wait looks at a heal running in another process. */
const POLL_MS = 500;
/** A heal in another process that has not ended after this long no longer holds back another. */
const FORGET_MS = 2 * 60 * 60_000;

export class Heals {
  readonly #engine: Engine;
  readonly #queue: JobQueue;
  readonly #holds: JobHolds;
  /** The heal job starting or unfinished for each tool, as far as this process knows. */
  readonly #running = new Map<string, Promise<string>>();
  /** Heals running in this process, and whether each repaired its tool. */
  readonly #done = new Map<string, Promise<boolean>>();
  readonly #failedAt = new Map<string, number>();

  constructor(engine: Engine, options: { queue?: JobQueue } = {}) {
    this.#engine = engine;
    this.#holds = new JobHolds(engine.db);
    this.#queue = options.queue ?? new InProcessQueue(1);
    this.#queue.process((job) => this.#take(job.id));
  }

  /**
   * Starts a heal for a tool, or returns the one already running for it.
   * Undefined when no heal can start: no model for one that needs it, or a
   * recent heal of this tool failed.
   */
  start(tool: PublishedTool, trigger: HealTrigger): Promise<string | undefined> {
    if (Date.now() - (this.#failedAt.get(tool.name) ?? 0) < COOLDOWN_MS) return Promise.resolve(undefined);
    const running = this.#running.get(tool.name);
    if (running) return running;
    if (trigger.kind !== 'drift' && !this.#engine.builds.llm) return Promise.resolve(undefined);

    // Taken before the job exists, so two calls at once start one heal.
    const started = this.#begin(tool, trigger);
    this.#running.set(tool.name, started);
    const forget = () => {
      if (this.#running.get(tool.name) === started) this.#running.delete(tool.name);
    };
    started.catch(forget);
    // A heal this process runs forgets itself when it ends; one that another process may take is watched.
    if (this.#queue.durable) {
      void started
        .then(async (id) => {
          if ((await this.#watch(id, FORGET_MS, false)) === 'failed') {
            this.#failedAt.set(tool.name, Date.now());
          }
        })
        .catch(() => undefined)
        .finally(forget);
    }
    return started;
  }

  async #begin(tool: PublishedTool, trigger: HealTrigger): Promise<string> {
    const input: HealInput = { tool: tool.name, version: tool.version, trigger };
    const job = await createJob(this.#engine.db, { kind: 'heal', input });
    // A job waiting in this process's own queue is alive as long as this process is.
    if (!this.#queue.durable) this.#holds.hold(job.id);
    await this.#queue.enqueue({ id: job.id, kind: 'heal' });
    return job.id;
  }

  /** Waits up to `ms` for a heal job to end, in this process or another. */
  wait(jobId: string, ms: number): Promise<HealEnd> {
    return this.#watch(jobId, ms, true);
  }

  /** Waits until every heal of this process has finished, e.g. before exit. */
  idle(): Promise<void> {
    return this.#queue.idle();
  }

  /** Stops taking heals from the queue. */
  close(): Promise<void> {
    return this.#queue.close();
  }

  /**
   * Watches a heal job until it ends: its promise when it runs here, or else
   * its row. `keepAlive` false lets the process exit meanwhile, for
   * bookkeeping that nothing waits on.
   */
  async #watch(jobId: string, ms: number, keepAlive: boolean): Promise<HealEnd> {
    const deadline = Date.now() + ms;
    for (;;) {
      const left = Math.max(0, deadline - Date.now());
      const here = this.#done.get(jobId);
      if (here) return race(here, left, keepAlive);
      const job = await getJob(this.#engine.db, jobId);
      if (!job || job.status === 'failed') return 'failed';
      if (job.status === 'succeeded') return 'healed';
      if (left === 0) return 'timeout';
      await sleep(Math.min(POLL_MS, left), keepAlive);
    }
  }

  /** Runs a heal job this process took from the queue. */
  async #take(id: string): Promise<void> {
    const db = this.#engine.db;
    this.#holds.hold(id);
    let tool: string | undefined;
    try {
      const job = await getJob(db, id);
      // Only a job that still waits: one failed meanwhile, or taken before, is left alone.
      if (job?.status !== 'queued') return;
      const input = job.input as HealInput;
      tool = input.tool;
      const done = this.#heal(id, input);
      this.#done.set(id, done);
      await done;
    } finally {
      this.#holds.release(id);
      this.#done.delete(id);
      if (tool) this.#running.delete(tool);
    }
  }

  async #heal(id: string, input: HealInput): Promise<boolean> {
    const db = this.#engine.db;
    const tool = await getTool(db, input.tool);
    // A repair of an older version would undo whatever replaced it.
    if (!tool || tool.version !== input.version) {
      await setJobStatus(db, id, 'failed', {
        step: null,
        error: { code: 'invalid_input', message: `${input.tool} changed before this repair began` },
      });
      return false;
    }
    return this.#run(id, tool, input.trigger);
  }

  async #run(jobId: string, tool: PublishedTool, trigger: HealTrigger): Promise<boolean> {
    const db = this.#engine.db;
    try {
      await setJobStatus(db, jobId, 'running', { step: 'diagnosing' });
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
        test_inputs: await testInputs(db, tool.id, tool.version),
        rate_limit: tool.site.rate_limit,
      };
      const deps = {
        runtime: this.#engine.runtime,
        jobId,
        step: (name: string) => setJobStep(db, jobId, name),
        ...(llm && { llm }),
        ...(browser && { browser }),
        ...(signedIn && { signedIn, secrets: await this.#engine.sessions.secretsFor(tool.site.origin) }),
      };
      let healed: Healed;
      if (trigger.kind === 'drift') healed = await refreshSelectors(target, trigger.drift, deps);
      else if (trigger.kind === 'fast_path') healed = await rebuildPrimary(target, trigger.error, deps);
      else healed = await healStep(target, failingStep(tool.recipe, trigger.error), deps);

      const published = await this.#engine.publish(
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
      await setJobStatus(db, jobId, 'succeeded', {
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
      if (trigger.kind === 'failure') await setToolStatus(db, tool.name, 'degraded');
      this.#failedAt.set(tool.name, Date.now());
      const json =
        error instanceof ToolDropError
          ? error.toJSON()
          : { code: 'internal' as const, message: error instanceof Error ? error.message : String(error) };
      await setJobStatus(db, jobId, 'failed', { step: null, error: json });
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

/** Whether a heal running here repaired its tool, or `timeout` after `ms`. */
async function race(done: Promise<boolean>, ms: number, keepAlive: boolean): Promise<HealEnd> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<HealEnd>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
    if (!keepAlive) timer.unref();
  });
  try {
    return await Promise.race([done.then((healed): HealEnd => (healed ? 'healed' : 'failed')), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number, keepAlive: boolean): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (!keepAlive) timer.unref();
  });
}
