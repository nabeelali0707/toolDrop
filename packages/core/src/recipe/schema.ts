import { z } from 'zod';
import { strategySchema, type Strategy } from '../common.ts';
import {
  clickOpSchema,
  extractTableOpSchema,
  extractTextOpSchema,
  fillOpSchema,
  gotoOpSchema,
  httpOpSchema,
  mapOpSchema,
  selectOpSchema,
  waitForOpSchema,
} from './ops.ts';
import { collectTemplateRefs } from './templates.ts';

export const stepSchema = z.discriminatedUnion('op', [
  httpOpSchema,
  mapOpSchema,
  gotoOpSchema,
  clickOpSchema,
  fillOpSchema,
  selectOpSchema,
  waitForOpSchema,
  extractTableOpSchema,
  extractTextOpSchema,
]);
export type Step = z.infer<typeof stepSchema>;
export type StepOp = Step['op'];

/**
 * The ops each strategy may use. `http_replay` may read a value out of a page
 * with `extract_text`, such as a CSRF token in a <meta> tag, before replaying
 * the requests that need it.
 */
export const OPS_BY_STRATEGY: Record<Strategy, readonly StepOp[]> = {
  official_api: ['http', 'map'],
  http_replay: ['http', 'map', 'extract_text'],
  html_fetch: ['http', 'extract_table', 'extract_text'],
  browser_script: ['goto', 'click', 'fill', 'select', 'wait_for', 'extract_table', 'extract_text', 'map'],
};

const stepsSchema = z.array(stepSchema).min(1).max(100);

/**
 * A compiled recipe: a declarative step list that our runtime executes. Never
 * code (SPEC, Security). Model replies are validated against this schema, so
 * its messages say what to change.
 *
 * `fallback` is the browser version of the same tool, which the runtime falls
 * back to when the primary strategy fails (SPEC, Runtime step 5). Both are
 * versioned together, so a heal updates them as one.
 */
export const recipeSchema = z
  .strictObject({
    strategy: strategySchema,
    steps: stepsSchema,
    fallback: z.strictObject({ strategy: z.literal('browser_script'), steps: stepsSchema }).optional(),
  })
  .superRefine((recipe, ctx) => {
    checkSteps(recipe.strategy, recipe.steps, ['steps'], ctx);
    if (recipe.fallback) {
      if (recipe.strategy === 'browser_script') {
        ctx.addIssue({
          code: 'custom',
          message: 'a browser_script recipe has nothing to fall back to; remove "fallback"',
          path: ['fallback'],
        });
      }
      checkSteps('browser_script', recipe.fallback.steps, ['fallback', 'steps'], ctx);
    }
  });
export type Recipe = z.infer<typeof recipeSchema>;

/** Checks that need the whole step list: allowed ops, selectors and template references. */
function checkSteps(strategy: Strategy, steps: Step[], at: string[], ctx: z.RefinementCtx): void {
  const allowedOps = OPS_BY_STRATEGY[strategy];
  const saved = new Set<string>();

  steps.forEach((step, index) => {
    const issue = (message: string, ...path: string[]) =>
      ctx.addIssue({ code: 'custom', message, path: [...at, index, ...path] });

    if (!allowedOps.includes(step.op)) {
      issue(`"${step.op}" is not allowed in a ${strategy} recipe; allowed: ${allowedOps.join(', ')}`, 'op');
    }
    if (strategy !== 'browser_script' && 'target' in step && step.target) {
      const parseable = step.target.some(
        (selector) => selector.kind === 'css' || selector.kind === 'test_id',
      );
      if (!parseable) {
        issue(
          `${strategy} has no browser to resolve role or text selectors; add a css or test_id selector`,
          'target',
        );
      }
    }

    const scan = collectTemplateRefs(step);
    for (const error of scan.errors) issue(error);
    for (const ref of scan.refs) {
      const name = ref.path[0];
      if (ref.root === 'loop' && !(step.op === 'http' && step.paginate?.var === name)) {
        issue(`{{${ref.raw}}} only works inside the http step whose paginate.var is "${name}"`);
      }
      if (ref.root === 'vars' && (name === undefined || !saved.has(name))) {
        issue(`{{${ref.raw}}} is used before an earlier step saves "${name}"`);
      }
    }

    for (const name of savedNames(step)) saved.add(name);
  });
}

function savedNames(step: Step): string[] {
  if (step.op === 'http') return Object.keys(step.save ?? {});
  if ('save' in step && step.save) return [step.save];
  return [];
}
