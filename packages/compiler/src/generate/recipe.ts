import { recipeSchema, type Recipe, type Step, type Strategy } from '@tooldrop/core';
import { DEFAULT_BUDGET_TOKENS, estimateTokens, fitPrompt, type Llm, type Masker } from '@tooldrop/llm';
import type { Capture } from '../capture/capture.ts';
import { targetRows } from '../analyze/rank.ts';
import { browserDraft, type ColumnBinding } from './draft.ts';
import { RECIPE_SYSTEM, recipePrompt, type TaskContext } from './prompts.ts';
import type { StrategyPlan } from './strategy.ts';

/** What every model call of a build shares. */
export interface ModelAccess {
  llm: Llm;
  jobId?: string;
  /** Secrets found so far in the job, masked in every prompt. */
  masker?: Masker;
  budget?: number;
}

const DATA_OPS = new Set(['map', 'extract_table', 'extract_text']);

/** The prompt budget left once the system prompt is counted. */
export function promptBudget(access: ModelAccess, system: string): number {
  return (access.budget ?? DEFAULT_BUDGET_TOKENS) - estimateTokens(system);
}

/**
 * The code model reviews the draft against the task and returns the recipe
 * (SPEC, Build pipeline step 7). The reply must be a valid recipe for the
 * plan's strategy that ends with a data step; a fallback it writes is
 * dropped, because the compiler builds the fallback itself.
 */
export async function writeRecipe(
  access: ModelAccess,
  context: TaskContext,
  capture: Capture,
  plan: StrategyPlan,
  problem?: string,
): Promise<{ strategy: Strategy; steps: Step[] }> {
  const schema = recipeSchema
    .refine((recipe) => recipe.strategy === plan.strategy, {
      message: `the strategy must be "${plan.strategy}"`,
      path: ['strategy'],
    })
    .refine((recipe) => DATA_OPS.has(recipe.steps.at(-1)?.op ?? ''), {
      message: 'the last step must be map, extract_table or extract_text',
      path: ['steps'],
    });
  const prompt = fitPrompt(
    'write_recipe',
    (level) => recipePrompt(context, capture, plan, problem, level),
    promptBudget(access, RECIPE_SYSTEM),
  );
  const recipe = await access.llm.generateJson({
    role: 'code',
    purpose: 'write_recipe',
    schema,
    system: RECIPE_SYSTEM,
    prompt,
    ...(access.jobId !== undefined && { job_id: access.jobId }),
    ...(access.masker && { masker: access.masker }),
  });
  return { strategy: recipe.strategy, steps: recipe.steps };
}

/**
 * Which column on screen each output field of a recipe shows in: found by
 * the field's path, or else by its draft name. Keeping a field that the
 * model pointed at another path tied to its column is what lets validation
 * catch the change.
 */
export function bindingsOf(steps: Step[], capture: Capture, draft: ColumnBinding[]): ColumnBinding[] {
  const last = steps.at(-1);
  if (last?.op === 'map') {
    return Object.entries(last.fields).map(([field, path]) => ({
      field,
      path,
      header: (
        draft.find((binding) => binding.path === path) ?? draft.find((binding) => binding.field === field)
      )?.header,
    }));
  }
  if (last?.op === 'extract_table') {
    const headers = capture.target ? targetRows(capture.target.data).headers : [];
    return Object.entries(last.columns).map(([field, column]) => ({
      field,
      header: typeof column === 'string' ? column : headers[column],
    }));
  }
  return [];
}

/**
 * The complete recipe: the primary steps and, unless the primary already
 * drives a browser, the browser recipe the runtime falls back to, reading the
 * same fields from the page (SPEC, Runtime step 5).
 */
export function assembleRecipe(
  primary: { strategy: Strategy; steps: Step[] },
  capture: Capture,
  site: string,
  draft: ColumnBinding[],
): { recipe: Recipe; bindings: ColumnBinding[] } {
  const bindings = bindingsOf(primary.steps, capture, draft);
  if (primary.strategy === 'browser_script' || !bindings.some((binding) => binding.header)) {
    return { recipe: recipeSchema.parse(primary), bindings };
  }
  const fallback = browserDraft(
    capture,
    site,
    bindings.filter((binding) => binding.header),
  );
  return {
    recipe: recipeSchema.parse({
      ...primary,
      fallback: { strategy: 'browser_script', steps: fallback.steps },
    }),
    bindings,
  };
}
