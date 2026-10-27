import type { JsonSchema, Recipe, Step, Strategy } from '@tooldrop/core';
import { stringify, type RateLimit, type Runtime } from '@tooldrop/runtime';
import type { Capture } from '../capture/capture.ts';
import { asNumber, normalize } from '../analyze/values.ts';

// Validate twice (SPEC, Build pipeline step 9): run 2 to 3 input sets through
// the chosen strategy and through the browser recipe, and require both to
// match the schemas and agree with each other.

export interface ToolUnderTest {
  name: string;
  input_schema: JsonSchema;
  output_schema: JsonSchema;
  recipe: Recipe;
  site: string;
  rate_limit?: RateLimit;
  /** The sign-in page of a signed-in site, so an expired session is reported as one. */
  login?: { url: string };
}

export interface ValidationRun {
  input: Record<string, unknown>;
  primary?: unknown;
  fallback?: unknown;
  problem?: string;
}

export interface ValidationReport {
  ok: boolean;
  runs: ValidationRun[];
  /** The first problem, said so it can go back to the model. */
  problem?: string;
}

/** Share of compared values that may differ, e.g. text the page formats differently. */
const MAX_MISMATCH = 0.1;

/**
 * Input sets to validate with: the values the person used; another option
 * for each input that has options; and, when there are inputs, none at all.
 */
export function inputSets(capture: Capture): Record<string, unknown>[] {
  const examples = Object.fromEntries(capture.inputs.map((input) => [input.name, input.example]));
  const other: Record<string, unknown> = {};
  for (const input of capture.inputs) {
    const action = capture.actions[input.action];
    const option =
      action?.kind === 'select'
        ? action.options.find((o) => o.value !== '' && o.value !== input.example)
        : undefined;
    if (option) other[input.name] = option.value;
  }
  const sets: Record<string, unknown>[] = [examples];
  if (Object.keys(other).length > 0) sets.push({ ...examples, ...other });
  if (capture.inputs.length > 0) sets.push({});
  return sets;
}

export async function validateTwice(
  runtime: Runtime,
  tool: ToolUnderTest,
  inputs: Record<string, unknown>[],
): Promise<ValidationReport> {
  const runs: ValidationRun[] = [];
  const fields = fallbackFields(tool.recipe);
  for (const input of inputs) {
    const run: ValidationRun = { input };
    runs.push(run);
    const label = JSON.stringify(input);
    try {
      run.primary = await runOnly(runtime, tool, tool.recipe, input);
    } catch (error) {
      run.problem = `${tool.recipe.strategy} failed for input ${label}: ${message(error)}`;
      continue;
    }
    if (!tool.recipe.fallback) continue;
    try {
      run.fallback = await runOnly(runtime, tool, tool.recipe.fallback, input);
    } catch (error) {
      run.problem = `the browser recipe failed for input ${label}: ${message(error)}`;
      continue;
    }
    const difference = compareResults(run.primary, run.fallback, fields);
    if (difference)
      run.problem = `for input ${label}, ${tool.recipe.strategy} and the browser disagree: ${difference}`;
  }
  const problem = runs.find((run) => run.problem)?.problem;
  return { ok: problem === undefined, runs, ...(problem !== undefined && { problem }) };
}

/** Runs one strategy of a recipe on its own, with the runtime's input and output checks. */
async function runOnly(
  runtime: Runtime,
  tool: ToolUnderTest,
  plan: { strategy: Strategy; steps: Step[] },
  input: Record<string, unknown>,
): Promise<unknown> {
  const outcome = await runtime.run(
    {
      name: tool.name,
      authority: 'read',
      input_schema: tool.input_schema,
      output_schema: tool.output_schema,
      version: 0,
      recipe: { strategy: plan.strategy, steps: plan.steps },
      site: tool.site,
      ...(tool.rate_limit && { rate_limit: tool.rate_limit }),
      ...(tool.login && { login: tool.login }),
    },
    input,
  );
  return outcome.result;
}

/** The fields the browser recipe reads, which both strategies return. */
function fallbackFields(recipe: Recipe): string[] {
  const last = recipe.fallback?.steps.at(-1);
  return last?.op === 'extract_table' ? Object.keys(last.columns) : [];
}

/**
 * Where two results differ, or undefined when they agree: the same rows in
 * the same order, compared on the fields both return. A shorter result that
 * is the start of the longer one agrees: a browser stops clicking "Load more"
 * sooner than an API runs out of pages.
 */
export function compareResults(
  primary: unknown,
  fallback: unknown,
  fields: readonly string[],
): string | undefined {
  if (!Array.isArray(primary) || !Array.isArray(fallback)) {
    return same(primary, fallback) ? undefined : `${short(primary)} against ${short(fallback)}`;
  }
  if (primary.length === 0 && fallback.length === 0) return undefined;
  if (primary.length === 0 || fallback.length === 0) {
    return `one returned ${primary.length} rows and the other ${fallback.length}`;
  }
  const rows = Math.min(primary.length, fallback.length);
  let compared = 0;
  const differences: string[] = [];
  for (let row = 0; row < rows; row++) {
    const a = primary[row] as Record<string, unknown> | null;
    const b = fallback[row] as Record<string, unknown> | null;
    for (const field of fields) {
      compared++;
      if (!same(a?.[field], b?.[field])) {
        differences.push(`row ${row + 1} ${field}: ${short(a?.[field])} against ${short(b?.[field])}`);
      }
    }
  }
  if (compared > 0 && differences.length / compared > MAX_MISMATCH) {
    return `${differences.length} of ${compared} values differ, e.g. ${differences.slice(0, 3).join('; ')}`;
  }
  return undefined;
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const x = normalize(stringify(a ?? ''));
  const y = normalize(stringify(b ?? ''));
  if (x === y) return true;
  const m = asNumber(x);
  const n = asNumber(y);
  return m !== undefined && n !== undefined && Math.abs(m - n) < 1e-9;
}

function short(value: unknown): string {
  const text = JSON.stringify(value) ?? 'undefined';
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
