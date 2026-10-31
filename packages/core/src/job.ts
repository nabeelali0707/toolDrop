import { z } from 'zod';
import { authoritySchema, idSchema } from './common.ts';

export const JOB_KINDS = ['build', 'heal', 'discover', 'workflow'] as const;
export const jobKindSchema = z.enum(JOB_KINDS);
export type JobKind = z.infer<typeof jobKindSchema>;

export const JOB_STATUSES = ['queued', 'running', 'waiting_for_answer', 'succeeded', 'failed'] as const;
export const jobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof jobStatusSchema>;

/** A job pauses in `waiting_for_answer` until the caller answers its question. */
export const JOB_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  queued: ['running', 'failed'],
  running: ['waiting_for_answer', 'succeeded', 'failed'],
  waiting_for_answer: ['running', 'failed'],
  succeeded: [],
  failed: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

/** Input to a build job (SPEC, Build pipeline step 1). */
export const buildInputSchema = z.strictObject({
  url: z.url({ protocol: /^https?$/ }),
  task: z.string().min(1).max(2000),
  authority: authoritySchema,
  inputs_hint: z.string().max(2000).optional(),
  recording_id: idSchema.optional(),
});
export type BuildInput = z.infer<typeof buildInputSchema>;

/** POST /v1/discover and discover_tools: a URL only (SPEC, URL-first discovery). */
export const discoverInputSchema = z.strictObject({
  url: z.url({ protocol: /^https?$/ }),
  /** Most pages the crawl visits (default 12). */
  max_pages: z.number().int().min(1).max(50).optional(),
});
export type DiscoverInput = z.infer<typeof discoverInputSchema>;

/** A clarifying question. Times are epoch milliseconds, like every timestamp. */
export const jobQuestionSchema = z.strictObject({
  id: idSchema,
  text: z.string().min(1),
  options: z.array(z.string().min(1)).optional(),
  asked_at: z.number().int(),
});
export type JobQuestion = z.infer<typeof jobQuestionSchema>;

export const jobAnswerSchema = z.strictObject({
  question_id: idSchema,
  text: z.string().min(1),
  answered_at: z.number().int(),
});
export type JobAnswer = z.infer<typeof jobAnswerSchema>;
