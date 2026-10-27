import { fitPrompt } from '@tooldrop/llm';
import { z } from 'zod';
import type { Capture } from '../capture/capture.ts';
import {
  CLARIFY_SYSTEM,
  clarifyPrompt,
  CLASSIFY_SYSTEM,
  classifyPrompt,
  type TaskContext,
} from './prompts.ts';
import { promptBudget, type ModelAccess } from './recipe.ts';
import type { StrategyPlan } from './strategy.ts';

// The reasoning model's two small jobs before a recipe is written: decide
// what the heuristics could not about opaque request fields (SPEC, Build
// pipeline step 5), and ask the caller when the task is ambiguous (step 4).

export const questionsSchema = z.strictObject({
  questions: z
    .array(
      z.strictObject({
        text: z.string().min(5).max(300),
        options: z.array(z.string().min(1).max(100)).max(6).optional(),
      }),
    )
    .max(2),
});
export type BuildQuestion = z.infer<typeof questionsSchema>['questions'][number];

/** What the capture shows, in short notes the clarify prompt can weigh. */
export function captureNotes(capture: Capture, plans: StrategyPlan[]): string[] {
  const best = plans[0];
  const notes: string[] = [];
  if (best?.strategy === 'http_replay') notes.push("The data comes from the site's own JSON API.");
  else if (best?.strategy === 'html_fetch') notes.push("The data is in the page's HTML.");
  else notes.push('The data is only reachable in a browser.');
  const paged = best?.analysis?.pagination ?? capture.target?.more;
  if (paged) notes.push('The list has more pages; the recipe fetches every page, at most 50.');
  notes.push(
    capture.inputs.length > 0
      ? `Inputs found: ${capture.inputs.map((input) => input.name).join(', ')}.`
      : 'The tool takes no inputs.',
  );
  return notes;
}

/** Questions for the caller, usually none. */
export async function clarify(
  access: ModelAccess,
  context: TaskContext,
  capture: Capture,
  plans: StrategyPlan[],
): Promise<BuildQuestion[]> {
  const notes = captureNotes(capture, plans);
  const prompt = fitPrompt(
    'clarify',
    (level) => clarifyPrompt(context, capture, notes, level),
    promptBudget(access, CLARIFY_SYSTEM),
  );
  const reply = await access.llm.generateJson({
    role: 'reasoning',
    purpose: 'clarify',
    schema: questionsSchema,
    system: CLARIFY_SYSTEM,
    prompt,
    ...(access.jobId !== undefined && { job_id: access.jobId }),
    ...(access.masker && { masker: access.masker }),
  });
  return reply.questions;
}

export const leftoverSchema = z.strictObject({
  fields: z.array(z.strictObject({ name: z.string(), kind: z.enum(['constant', 'auth', 'derived']) })),
});

/**
 * Asks the reasoning model about request fields the heuristics could not
 * explain, and drops the plans that cannot replay them: a field that is a
 * credential or comes from somewhere unseen cannot be sent as a constant.
 */
export async function resolveLeftovers(
  access: ModelAccess,
  context: TaskContext,
  plans: StrategyPlan[],
): Promise<StrategyPlan[]> {
  const kept: StrategyPlan[] = [];
  for (const plan of plans) {
    const leftovers = plan.analysis?.fields.filter((field) => field.leftover) ?? [];
    if (leftovers.length === 0) {
      kept.push(plan);
      continue;
    }
    const fields = leftovers.map((field) => ({
      location: field.location,
      name: field.name,
      value: field.value,
    }));
    const prompt = fitPrompt(
      'classify_fields',
      (level) => classifyPrompt(context, fields, level),
      promptBudget(access, CLASSIFY_SYSTEM),
    );
    const reply = await access.llm.generateJson({
      role: 'reasoning',
      purpose: 'classify_fields',
      schema: leftoverSchema,
      system: CLASSIFY_SYSTEM,
      prompt,
      ...(access.jobId !== undefined && { job_id: access.jobId }),
      ...(access.masker && { masker: access.masker }),
    });
    const unexplained = reply.fields.filter((field) => field.kind !== 'constant');
    if (unexplained.length === 0) kept.push(plan);
  }
  return kept;
}
