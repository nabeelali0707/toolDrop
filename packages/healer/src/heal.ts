import {
  recipeSchema,
  ToolDropError,
  type JsonSchema,
  type Recipe,
  type Step,
  type Strategy,
} from '@tooldrop/core';
import {
  CaptureSession,
  collectSecrets,
  planStrategies,
  promptBudget,
  replaySteps,
  validateTwice,
  writeRecipe,
  type CaptureOptions,
  type ModelAccess,
  type StrategyPlan,
} from '@tooldrop/compiler';
import { fitPrompt, Masker, type Llm } from '@tooldrop/llm';
import {
  renderText,
  type RateLimit,
  type Runtime,
  type StorageState,
  type TemplateContext,
} from '@tooldrop/runtime';
import type { Browser } from 'playwright';
import { z } from 'zod';
import { applyPatch, patchSchema } from './patch.ts';
import { PATCH_SYSTEM, patchPrompt, REASON_SYSTEM, reasonPrompt } from './prompts.ts';

// Repairs (SPEC, Self-healing): diagnose, patch, test, and hand back a new
// recipe with a reason for the history. Publishing, and escalating after
// failed attempts, belong to the engine.

export interface HealTarget {
  name: string;
  description: string;
  site: string;
  recipe: Recipe;
  input_schema: JsonSchema;
  output_schema: JsonSchema;
  /** The input sets the tool was validated with: a repair must pass every one. */
  test_inputs: Record<string, unknown>[];
  rate_limit?: RateLimit;
}

export interface HealDeps {
  /** Needed by patches and rebuilds; refreshing selectors uses no model. */
  llm?: Llm;
  runtime: Runtime;
  browser?: Browser;
  jobId?: string;
  signedIn?: { loginUrl: string; state: StorageState };
  /** Values every prompt masks, such as the saved login's username and password. */
  secrets?: string[];
  /** How long replayed steps wait for the page (default 10 s). */
  waitMs?: number;
  /** What the heal is doing now, for get_job. */
  step?: (name: string) => void;
}

export interface Healed {
  recipe: Recipe;
  /** For the tool's history, e.g. "The date filter moved into a Search options panel". */
  reason: string;
  attempts: number;
}

/** Repairs tried before the tool is marked degraded (SPEC, Self-healing step 5). */
export const MAX_HEAL_ATTEMPTS = 3;

type BrowserPlan = { strategy: 'browser_script'; steps: Step[] };

/** The recipe's browser plan: the primary, or else the fallback. */
function browserPlan(recipe: Recipe, which: 'primary' | 'fallback'): BrowserPlan {
  const plan = which === 'fallback' ? recipe.fallback : recipe;
  if (!plan || plan.strategy !== 'browser_script') {
    throw new ToolDropError('internal', `the recipe has no browser ${which} to repair`);
  }
  return { strategy: 'browser_script', steps: plan.steps };
}

function options(deps: HealDeps): CaptureOptions {
  return {
    ...(deps.browser && { browser: deps.browser }),
    ...(deps.waitMs !== undefined && { waitMs: deps.waitMs }),
    ...(deps.signedIn && { storageState: deps.signedIn.state }),
  };
}

/** Starts a capture where the plan starts: at its first page when it opens with one. */
async function startAt(target: HealTarget, steps: readonly Step[], context: TemplateContext, deps: HealDeps) {
  const first = steps[0];
  const url = first?.op === 'goto' ? renderText(first.url, context) : target.site;
  const session = await CaptureSession.start(url, options(deps));
  return { session, from: first?.op === 'goto' ? 1 : 0 };
}

/** A masker that knows the login's values, as every heal prompt must. */
function maskerFor(deps: HealDeps): Masker {
  const masker = new Masker();
  for (const secret of deps.secrets ?? []) masker.add(secret);
  return masker;
}

function access(deps: HealDeps, masker: Masker): ModelAccess {
  if (!deps.llm)
    throw new ToolDropError('llm_unavailable', 'repairing this recipe needs a model; run `tooldrop init`');
  return { llm: deps.llm, masker, ...(deps.jobId !== undefined && { jobId: deps.jobId }) };
}

/** Runs every saved test input through one plan; throws on the first that fails or misses the schema. */
async function testPlan(
  target: HealTarget,
  plan: { strategy: Strategy; steps: Step[] },
  deps: HealDeps,
): Promise<void> {
  const inputs = target.test_inputs.length > 0 ? target.test_inputs : [{}];
  for (const input of inputs) {
    await deps.runtime.run(
      {
        name: target.name,
        authority: 'read',
        input_schema: target.input_schema,
        output_schema: target.output_schema,
        version: 0,
        recipe: { strategy: plan.strategy, steps: plan.steps },
        site: target.site,
        ...(target.rate_limit && { rate_limit: target.rate_limit }),
        ...(deps.signedIn && { login: { url: deps.signedIn.loginUrl } }),
      },
      input,
    );
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isModelError(error: unknown): boolean {
  return error instanceof ToolDropError && error.code.startsWith('llm_');
}

/**
 * Repairs a browser step that stopped working (SPEC, Self-healing steps 2 to
 * 4): replay up to it, show the code model the page as it is now, apply the
 * patch it proposes, and test it on every saved input. Each failed attempt
 * goes back to the model with what went wrong.
 */
export async function healStep(
  target: HealTarget,
  failure: { plan: 'primary' | 'fallback'; step: number; error: string },
  deps: HealDeps,
): Promise<Healed> {
  const masker = maskerFor(deps);
  const model = access(deps, masker);
  const plan = browserPlan(target.recipe, failure.plan);
  const context: TemplateContext = {
    site: target.site,
    input: { ...target.test_inputs[0] },
    session: {},
    vars: {},
    loop: {},
  };
  let feedback: string | undefined;
  for (let attempt = 1; attempt <= MAX_HEAL_ATTEMPTS; attempt++) {
    deps.step?.(`repairing step ${failure.step + 1} (attempt ${attempt} of ${MAX_HEAL_ATTEMPTS})`);
    let steps: Step[];
    const { session, from } = await startAt(target, plan.steps, context, deps);
    try {
      await replaySteps(session, plan.steps.slice(from, failure.step), { ...context, vars: {} });
      const page = await session.snapshot();
      const prompt = fitPrompt(
        'heal_patch',
        (level) => patchPrompt(target, plan.steps, failure, page, feedback, level),
        promptBudget(model, PATCH_SYSTEM),
      );
      const patch = await model.llm.generateJson({
        role: 'code',
        purpose: 'heal_patch',
        schema: patchSchema,
        system: PATCH_SYSTEM,
        prompt,
        ...(model.jobId !== undefined && { job_id: model.jobId }),
        masker,
      });
      steps = await applyPatch(session, plan.steps, patch);
    } catch (error) {
      if (isModelError(error)) throw error;
      feedback = message(error);
      continue;
    } finally {
      await session.abort();
    }

    const recipe =
      failure.plan === 'fallback'
        ? { ...target.recipe, fallback: { strategy: 'browser_script' as const, steps } }
        : { ...target.recipe, steps };
    try {
      deps.step?.(`testing the repair (attempt ${attempt} of ${MAX_HEAL_ATTEMPTS})`);
      await testPlan(target, { strategy: 'browser_script', steps }, deps);
    } catch (error) {
      feedback = message(error);
      continue;
    }
    return {
      recipe: recipeSchema.parse(recipe),
      reason: await describeChange(model, plan.steps, steps),
      attempts: attempt,
    };
  }
  throw new ToolDropError(
    'strategy_failed',
    `no repair worked after ${MAX_HEAL_ATTEMPTS} attempts: ${feedback ?? 'unknown'}`,
  );
}

/**
 * Rebuilds a fast path that stopped working while the browser fallback still
 * answers, e.g. after an API moved: capture what the fallback does now, find
 * the request behind the data again, and have the code model write the
 * recipe. The fallback and the tool's field names stay as they are.
 */
export async function rebuildPrimary(target: HealTarget, error: string, deps: HealDeps): Promise<Healed> {
  const masker = maskerFor(deps);
  const model = access(deps, masker);
  const fallback = target.recipe.fallback;
  if (!fallback || target.recipe.strategy === 'browser_script') {
    throw new ToolDropError('internal', 'only a recipe with a browser fallback can rebuild its fast path');
  }
  const context: TemplateContext = {
    site: target.site,
    input: { ...target.test_inputs[0] },
    session: {},
    vars: {},
    loop: {},
  };
  let problem = `the old ${target.recipe.strategy} recipe stopped working: ${error}`;
  for (let attempt = 1; attempt <= MAX_HEAL_ATTEMPTS; attempt++) {
    deps.step?.(
      `rebuilding the ${target.recipe.strategy} recipe (attempt ${attempt} of ${MAX_HEAL_ATTEMPTS})`,
    );
    const { session, from } = await startAt(target, fallback.steps, context, deps);
    let capture: Awaited<ReturnType<CaptureSession['finish']>>;
    try {
      await replaySteps(session, fallback.steps.slice(from), { ...context, vars: {} }, { markTarget: true });
      capture = await session.finish();
    } catch (caught) {
      await session.abort();
      problem = message(caught);
      continue;
    }
    collectSecrets(capture.exchanges, masker);
    const plans = planStrategies(capture, target.site).filter((plan) => plan.strategy !== 'browser_script');
    const plan = plans.find((candidate) => candidate.strategy === target.recipe.strategy) ?? plans[0];
    if (!plan)
      throw new ToolDropError('strategy_failed', 'the site no longer offers a faster way than the browser');
    keepFieldNames(plan, fallback.steps);

    const primary = await writeRecipe(
      model,
      { task: target.description, site: target.site, answers: [] },
      capture,
      plan,
      problem,
    );
    const recipe = recipeSchema.parse({ ...primary, fallback });
    deps.step?.(`testing the rebuilt recipe (attempt ${attempt} of ${MAX_HEAL_ATTEMPTS})`);
    const report = await validateTwice(
      deps.runtime,
      {
        name: target.name,
        input_schema: target.input_schema,
        output_schema: target.output_schema,
        recipe,
        site: target.site,
        ...(target.rate_limit && { rate_limit: target.rate_limit }),
        ...(deps.signedIn && { login: { url: deps.signedIn.loginUrl } }),
      },
      target.test_inputs.length > 0 ? target.test_inputs : [{}],
    );
    if (!report.ok) {
      problem = report.problem ?? 'the rebuilt recipe did not agree with the browser';
      continue;
    }
    return {
      recipe,
      reason: await describeChange(model, target.recipe.steps, primary.steps),
      attempts: attempt,
    };
  }
  throw new ToolDropError(
    'strategy_failed',
    `no rebuilt recipe worked after ${MAX_HEAL_ATTEMPTS} attempts: ${problem}`,
  );
}

/**
 * Renames a draft's output fields after the fallback's, column by column, so
 * the rebuilt recipe returns the fields callers and the schema expect.
 */
function keepFieldNames(plan: StrategyPlan, fallbackSteps: readonly Step[]): void {
  const table = fallbackSteps.findLast((step) => step.op === 'extract_table');
  if (table?.op !== 'extract_table') return;
  const byHeader = new Map(
    Object.entries(table.columns).map(([field, header]) => [String(header).toLowerCase(), field]),
  );
  const renames = new Map<string, string>();
  for (const binding of plan.draft.bindings) {
    const kept = binding.header ? byHeader.get(binding.header.toLowerCase()) : undefined;
    if (kept && kept !== binding.field) renames.set(binding.field, kept);
    if (kept) binding.field = kept;
  }
  const last = plan.draft.steps.at(-1);
  if (last?.op === 'map') {
    last.fields = Object.fromEntries(
      Object.entries(last.fields).map(([field, path]) => [renames.get(field) ?? field, path]),
    );
  } else if (last?.op === 'extract_table') {
    last.columns = Object.fromEntries(
      Object.entries(last.columns).map(([field, header]) => [renames.get(field) ?? field, header]),
    );
  }
}

/**
 * Refreshes the selectors of browser steps that found their element only with
 * a later selector (SPEC, Self-healing: try the ranked-selector fallback before
 * calling the model). No model: the element is still found, and described
 * again from the page.
 */
export async function refreshSelectors(
  target: HealTarget,
  drift: { strategy: Strategy; steps: { step: number; selector: number }[] },
  deps: HealDeps,
): Promise<Healed> {
  const which = target.recipe.strategy === 'browser_script' ? 'primary' : 'fallback';
  const plan = browserPlan(target.recipe, which);
  const steps = [...plan.steps];
  const context: TemplateContext = {
    site: target.site,
    input: { ...target.test_inputs[0] },
    session: {},
    vars: {},
    loop: {},
  };
  const labels: string[] = [];
  deps.step?.('refreshing selectors');
  const { session, from } = await startAt(target, steps, context, deps);
  try {
    let next = from;
    for (const { step: index } of [...drift.steps].sort((a, b) => a.step - b.step)) {
      const step = steps[index];
      if (!step || !('target' in step) || !step.target) continue;
      await replaySteps(session, steps.slice(next, index), { ...context, vars: {} });
      const fresh = await session.selectorsFor(await session.refFor(step.target));
      steps[index] = { ...step, target: fresh.target };
      labels.push(fresh.label);
      next = index;
    }
  } finally {
    await session.abort();
  }
  const recipe =
    which === 'fallback'
      ? { ...target.recipe, fallback: { strategy: 'browser_script' as const, steps } }
      : { ...target.recipe, steps };
  deps.step?.('testing the refreshed selectors');
  await testPlan(target, { strategy: 'browser_script', steps }, deps);
  const reason = `${labels.join(', ')}: the first selector no longer matched, so the selectors were refreshed from the page`;
  return { recipe: recipeSchema.parse(recipe), reason, attempts: 1 };
}

const reasonSchema = z.strictObject({ reason: z.string().min(5).max(200) });

/** The reasoning model's one line for the history (SPEC, Self-healing: the heal reason). */
async function describeChange(
  model: ModelAccess,
  before: readonly Step[],
  after: readonly Step[],
): Promise<string> {
  const prompt = fitPrompt(
    'heal_reason',
    () => reasonPrompt(before, after),
    promptBudget(model, REASON_SYSTEM),
  );
  const reply = await model.llm.generateJson({
    role: 'reasoning',
    purpose: 'heal_reason',
    schema: reasonSchema,
    system: REASON_SYSTEM,
    prompt,
    ...(model.jobId !== undefined && { job_id: model.jobId }),
    ...(model.masker && { masker: model.masker }),
  });
  return reply.reason;
}
