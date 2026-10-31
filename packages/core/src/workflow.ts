import { z } from 'zod';
import { identifierSchema, jsonSchemaSchema, type Authority } from './common.ts';
import { toolNameSchema } from './tool.ts';

// Multi-site workflows (SPEC, Differentiating features): tools chained into
// one, such as onboard_employee across an HR site, an IT portal and email.
// Each step calls a published tool; its inputs may come from the workflow's
// inputs and from earlier steps' results. A step can be retried, and can name
// the step that undoes it should a later one fail.

/** Inputs of a step: plain values, or templates such as "{{input.email}}" and "{{steps.find.result.0.id}}". */
const stepInputsSchema = z.record(z.string(), z.unknown());

export const workflowStepSchema = z.strictObject({
  /** How later steps and templates refer to this one. */
  id: identifierSchema,
  /** A published tool, on any site. */
  tool: toolNameSchema,
  inputs: stepInputsSchema.default({}),
  /** Tries after the first, waiting 1, 2 and 4 seconds between them. */
  retries: z.number().int().min(0).max(3).default(0),
  /** Undoes this step, should a later step fail: a tool, and its inputs, which may use this step's result. */
  compensate: z.strictObject({ tool: toolNameSchema, inputs: stepInputsSchema.default({}) }).optional(),
});
export type WorkflowStep = z.infer<typeof workflowStepSchema>;

/** A workflow file, as `tooldrop workflows add` and POST /v1/workflows take it. */
export const workflowFileSchema = z
  .strictObject({
    name: toolNameSchema,
    description: z.string().min(1).max(2000),
    input_schema: jsonSchemaSchema.refine(
      (schema) => schema.type === 'object',
      'input_schema must have type "object"',
    ),
    steps: z.array(workflowStepSchema).min(1).max(20),
    /** The workflow's result, as templates; the last step's result when absent. */
    output: z.unknown().optional(),
  })
  .superRefine((workflow, context) => {
    const seen = new Set<string>();
    workflow.steps.forEach((step, index) => {
      if (seen.has(step.id)) {
        context.addIssue({
          code: 'custom',
          path: ['steps', index, 'id'],
          message: `step id ${step.id} is used twice`,
        });
      }
      // A step reads only steps before it; a compensation may read its own step too.
      for (const name of referencedSteps(step.inputs)) {
        if (!seen.has(name)) {
          context.addIssue({
            code: 'custom',
            path: ['steps', index, 'inputs'],
            message: `step ${step.id} uses step ${name}, which does not come before it`,
          });
        }
      }
      for (const name of referencedSteps(step.compensate?.inputs ?? {})) {
        if (!seen.has(name) && name !== step.id) {
          context.addIssue({
            code: 'custom',
            path: ['steps', index, 'compensate', 'inputs'],
            message: `the compensation of ${step.id} uses step ${name}, which does not come before it`,
          });
        }
      }
      seen.add(step.id);
    });
    for (const name of referencedSteps(workflow.output)) {
      if (!seen.has(name)) {
        context.addIssue({
          code: 'custom',
          path: ['output'],
          message: `the output uses step ${name}, which does not exist`,
        });
      }
    }
  });
export type WorkflowFile = z.infer<typeof workflowFileSchema>;

/** A workflow as callers see it. */
export interface WorkflowView {
  name: string;
  description: string;
  /** "write" when any step or compensation changes a site. */
  authority: Authority;
  input_schema: Record<string, unknown>;
  steps: WorkflowStep[];
  output?: unknown;
  created_at: string;
  updated_at: string;
}

/** POST /v1/workflows/:name/run and calling a workflow over MCP. */
export interface WorkflowRunInput {
  workflow: string;
  input: Record<string, unknown>;
}

const TEMPLATE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const WHOLE = /^\{\{\s*([^{}]+?)\s*\}\}$/;

/** The step ids a value's templates read: "{{steps.find.result}}" reads find. */
export function referencedSteps(value: unknown): string[] {
  const names = new Set<string>();
  const walk = (item: unknown): void => {
    if (typeof item === 'string') {
      for (const match of item.matchAll(TEMPLATE)) {
        const [root, name] = (match[1] ?? '').split('.');
        if (root === 'steps' && name) names.add(name);
      }
    } else if (Array.isArray(item)) {
      item.forEach(walk);
    } else if (item && typeof item === 'object') {
      Object.values(item).forEach(walk);
    }
  };
  walk(value);
  return [...names];
}

/**
 * Fills a value's templates from the workflow's inputs and its steps'
 * results. A string that is one template keeps the value's type, so
 * "{{steps.find.result.0.amount}}" stays a number; a template inside other
 * text becomes text. A missing value is undefined, or empty inside text.
 */
export function fillTemplates(
  value: unknown,
  context: { input: unknown; steps: Record<string, { result: unknown }> },
): unknown {
  if (typeof value === 'string') {
    const whole = WHOLE.exec(value);
    if (whole) return lookup(context, whole[1] ?? '');
    return value.replace(TEMPLATE, (_match, path: string) => {
      const found = lookup(context, path);
      if (found === undefined || found === null) return '';
      if (typeof found === 'string') return found;
      if (typeof found === 'number' || typeof found === 'boolean') return String(found);
      return JSON.stringify(found) ?? '';
    });
  }
  if (Array.isArray(value)) return value.map((item) => fillTemplates(item, context));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, fillTemplates(item, context)]),
    );
  }
  return value;
}

/** A dotted path, such as "input.email" or "steps.find.result.0.id", read from the context. */
function lookup(
  context: { input: unknown; steps: Record<string, { result: unknown }> },
  path: string,
): unknown {
  let current: unknown = context;
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
