import { z } from 'zod';
import { strategySchema } from './common.ts';

/** What every tool call returns next to its result (SPEC, Runtime step 8). */
export const runMetaSchema = z.strictObject({
  strategy: strategySchema,
  duration_ms: z.number().int().nonnegative(),
  recipe_version: z.number().int().positive(),
  healed: z.boolean(),
});
export type RunMeta = z.infer<typeof runMetaSchema>;

export const runResultSchema = z.strictObject({
  result: z.unknown(),
  meta: runMetaSchema,
});
export type RunResult = z.infer<typeof runResultSchema>;
