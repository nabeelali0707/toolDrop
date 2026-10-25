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

/** The ops each strategy may use. */
export const OPS_BY_STRATEGY: Record<Strategy, readonly StepOp[]> = {
  official_api: ['http', 'map'],
  http_replay: ['http', 'map'],
  html_fetch: ['http', 'extract_table', 'extract_text'],
  browser_script: ['goto', 'click', 'fill', 'select', 'wait_for', 'extract_table', 'extract_text', 'map'],
};

/**
 * A compiled recipe: a declarative step list that our runtime executes. Never
 * code (SPEC, Security). Model replies are validated against this schema, so
 * its messages say what to change.
 */
export const recipeSchema = z
  .strictObject({
    strategy: strategySchema,
    steps: z.array(stepSchema).min(1).max(100),
  })
  .superRefine((recipe, ctx) => {
    const allowedOps = OPS_BY_STRATEGY[recipe.strategy];
    const saved = new Set<string>();

    recipe.steps.forEach((step, index) => {
      const at = ['steps', index];
      const issue = (message: string, ...path: string[]) =>
        ctx.addIssue({ code: 'custom', message, path: [...at, ...path] });

      if (!allowedOps.includes(step.op)) {
        issue(
          `"${step.op}" is not allowed in a ${recipe.strategy} recipe; allowed: ${allowedOps.join(', ')}`,
          'op',
        );
      }
      if (recipe.strategy === 'html_fetch' && 'target' in step && step.target) {
        const parseable = step.target.some(
          (selector) => selector.kind === 'css' || selector.kind === 'test_id',
        );
        if (!parseable) {
          issue(
            'html_fetch has no browser to resolve role or text selectors; add a css or test_id selector',
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
  });
export type Recipe = z.infer<typeof recipeSchema>;

function savedNames(step: Step): string[] {
  if (step.op === 'http') return Object.keys(step.save ?? {});
  if ('save' in step && step.save) return [step.save];
  return [];
}
