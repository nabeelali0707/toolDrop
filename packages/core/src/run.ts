import { z } from 'zod';
import { strategySchema } from './common.ts';

/** What every tool call returns next to its result (SPEC, Runtime step 8). */
export const runMetaSchema = z.strictObject({
  strategy: strategySchema,
  duration_ms: z.number().int().nonnegative(),
  recipe_version: z.number().int().positive(),
  healed: z.boolean(),
  /** The approval a write ran on (SPEC, Safe mode). */
  approval_id: z.string().optional(),
  /** A write tool's dry run: the result is its preview, and nothing changed. */
  dry_run: z.boolean().optional(),
});
export type RunMeta = z.infer<typeof runMetaSchema>;

export const runResultSchema = z.strictObject({
  result: z.unknown(),
  meta: runMetaSchema,
});
export type RunResult = z.infer<typeof runResultSchema>;

/** A write preview waiting in safe mode (SPEC, Differentiating features). */
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const;
export const approvalStatusSchema = z.enum(APPROVAL_STATUSES);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;
