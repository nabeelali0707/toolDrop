import {
  MANAGEMENT_TOOL_NAMES,
  recordingUrl,
  toolFileSchema,
  ToolDropError,
  type JsonSchema,
  type RecordedAction,
  type Recording,
  type Step,
  type ToolFile,
} from '@tooldrop/core';
import { fitPrompt, Masker } from '@tooldrop/llm';
import type { RunnableTool } from '@tooldrop/runtime';
import { z } from 'zod';
import type { BuildDeps, BuildHooks, BuildResult } from '../build.ts';
import { siteUrl } from '../generate/draft.ts';
import { promptBudget, type ModelAccess } from '../generate/recipe.ts';
import { uniqueToolName } from '../generate/schemas.ts';

// Write builds from recordings (PLAN 5.13; DECISIONS.md, D-058): a recorded
// form submission becomes a write recipe whose submit is its commit step, so
// the tool runs through safe mode. The build never submits: it assembles the
// recipe from the recording itself, without replaying it, and checks it with
// safe mode's preview, which runs every step up to the commit and stops.

/** The recording, read as a write: steps up to the submit, the submit, and the confirmation. */
export interface WritePlan {
  site: string;
  /** Steps before the commit. */
  before: Step[];
  commit: Step;
  /** Reads the confirmation the site shows after the submit. */
  confirmation: Step;
  input_schema: JsonSchema;
  /** The values the person used, as the first input set. */
  example: Record<string, unknown>;
  /** What each input fills, for the model to describe. */
  fields: { input: string; label: string; example: string }[];
  submit: string;
}

/**
 * Reads a recording as a write. The last click is the submit; a recording
 * must mark the confirmation the site showed after it, and may not type a
 * password (signing in belongs to login recipes).
 */
export function planWrite(recording: Recording, url: string): WritePlan {
  const site = new URL(url).origin;
  const actions = recording.actions;
  const commitIndex = actions.findLastIndex((action) => action.kind === 'click');
  if (commitIndex < 1) {
    throw new ToolDropError(
      'invalid_input',
      'a write is built from a recording that ends by submitting a form: the recording has no click to submit with',
    );
  }
  if (!recording.target) {
    throw new ToolDropError(
      'invalid_input',
      'mark the confirmation the site shows after the submit (Mark data), so the tool can say how the write went',
    );
  }
  const inputs = new Map(recording.inputs.map((input) => [input.action, input]));
  const properties: Record<string, JsonSchema> = {};
  const example: Record<string, unknown> = {};
  const fields: WritePlan['fields'] = [];
  const before: Step[] = [];
  actions.slice(0, commitIndex).forEach((action, index) => {
    before.push(stepFor(action, index, site, inputs, { properties, example, fields }));
  });
  const commitAction = actions[commitIndex] as Extract<RecordedAction, { kind: 'click' }>;
  return {
    site,
    before,
    commit: { op: 'click', target: commitAction.target, commit: true },
    confirmation: { op: 'extract_text', target: recording.target.selector },
    input_schema: {
      type: 'object',
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    },
    example,
    fields,
    submit: commitAction.label,
  };
}

function stepFor(
  action: RecordedAction,
  index: number,
  site: string,
  inputs: Map<number, Recording['inputs'][number]>,
  out: {
    properties: Record<string, JsonSchema>;
    example: Record<string, unknown>;
    fields: WritePlan['fields'];
  },
): Step {
  switch (action.kind) {
    case 'goto':
      return { op: 'goto', url: siteUrl(action.url, site, true) };
    case 'click':
      return { op: 'click', target: action.target };
    case 'fill':
    case 'select': {
      if (action.value === null) {
        throw new ToolDropError(
          'invalid_input',
          `the recording types a password into ${action.label}; save the login with \`tooldrop logins add\` and record the write signed in`,
        );
      }
      const input = inputs.get(index);
      if (!input) return { op: action.kind, target: action.target, value: action.value };
      const numeric = action.kind === 'fill' && /^-?\d+(\.\d+)?$/.test(input.example);
      out.properties[input.name] = {
        ...(action.kind === 'select'
          ? { type: 'string', enum: action.options.map((option) => option.value).filter(Boolean) }
          : { type: numeric ? 'number' : 'string' }),
        ...(input.description && { description: input.description }),
      };
      out.example[input.name] = numeric ? Number(input.example) : input.example;
      out.fields.push({ input: input.name, label: action.label, example: input.example });
      return { op: action.kind, target: action.target, value: `{{input.${input.name}}}` };
    }
  }
}

export const writeDescriptionSchema = z
  .strictObject({
    name: z
      .string()
      .regex(/^[a-z][a-z0-9_]{2,39}$/, 'lowercase snake_case, 3 to 40 characters, starting with a letter'),
    description: z.string().min(10).max(600),
    inputs: z.array(z.strictObject({ name: z.string(), description: z.string().max(300) })).max(50),
  })
  .refine((reply) => !(MANAGEMENT_TOOL_NAMES as readonly string[]).includes(reply.name), {
    message: 'this name belongs to a toolDrop management tool; choose another',
    path: ['name'],
  });

export const DESCRIBE_WRITE_SYSTEM = `You name a tool that fills in and submits a form on a website, and describe it for an AI agent choosing tools. Reply with JSON only:
{"name":"record_payment","description":"...","inputs":[{"name":"amount","description":"..."}]}
- name: snake_case, a verb first, saying what the submit does.
- description: what the tool changes on the site, in one or two sentences. Say that it changes data.
- inputs: one description per input listed, saying what to pass.`;

/**
 * Builds a write tool from a recording: plan it, check every step before the
 * submit with a preview of each input set, then name and describe it.
 */
export async function buildWriteTool(
  request: { url: string; task: string; recording: Recording },
  deps: BuildDeps,
  hooks: Pick<BuildHooks, 'step'>,
): Promise<BuildResult> {
  await hooks.step('reading the recording');
  const plan = planWrite(request.recording, request.url || recordingUrl(request.recording));
  const recipe = {
    strategy: 'browser_script' as const,
    steps: [...plan.before, plan.commit, plan.confirmation],
  };

  // Safe mode's preview runs the steps up to the commit and stops: nothing is submitted.
  await hooks.step('checking the form, without submitting it');
  const runnable: RunnableTool = {
    name: 'write_build_check',
    authority: 'write',
    input_schema: plan.input_schema,
    output_schema: { type: 'string' },
    version: 0,
    recipe,
    site: plan.site,
    ...(deps.rateLimit && { rate_limit: deps.rateLimit }),
    ...(deps.signedIn && { login: { url: deps.signedIn.loginUrl } }),
  };
  const { preview } = await deps.runtime.preview(runnable, plan.example);

  await hooks.step('describing the tool');
  const masker = new Masker();
  for (const secret of deps.secrets ?? []) masker.add(secret);
  const access: ModelAccess = {
    llm: deps.llm,
    masker,
    ...(deps.jobId !== undefined && { jobId: deps.jobId }),
  };
  const prompt = fitPrompt(
    'describe_write',
    () =>
      [
        `Task: ${request.task}`,
        `Site: ${plan.site}`,
        `The form is on ${preview.url}, and the tool submits it with ${plan.submit}.`,
        'Inputs:',
        ...plan.fields.map(
          (field) => `- ${field.input}: fills ${field.label}, e.g. ${JSON.stringify(field.example)}`,
        ),
      ].join('\n'),
    promptBudget(access, DESCRIBE_WRITE_SYSTEM),
  );
  const described = await deps.llm.generateJson({
    role: 'reasoning',
    purpose: 'describe_write',
    schema: writeDescriptionSchema,
    system: DESCRIBE_WRITE_SYSTEM,
    prompt,
    masker,
    ...(deps.jobId !== undefined && { job_id: deps.jobId }),
  });

  const properties = plan.input_schema.properties as Record<string, JsonSchema>;
  for (const input of described.inputs) {
    const property = properties[input.name];
    if (property && !property.description) property.description = input.description;
  }
  const tool: ToolFile = toolFileSchema.parse({
    name: await uniqueToolName(described.name, deps.nameTaken),
    description: described.description,
    authority: 'write',
    input_schema: plan.input_schema,
    output_schema: { type: 'string', description: 'What the site showed after the submit.' },
    recipe,
  });
  return {
    tool,
    site: plan.site,
    test_inputs: [plan.example],
    sample: preview,
    strategy: 'browser_script',
    capture_id: '',
    attempts: 1,
  };
}
