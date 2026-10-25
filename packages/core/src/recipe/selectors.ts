import { z } from 'zod';

// A target element is stored as a ranked list of selectors (SPEC, Recipe step
// format). The runtime tries them in order, so a heal can fall back to the
// next one before it calls the model.
export const selectorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('role'), role: z.string().min(1), name: z.string().min(1).optional() }),
  z.strictObject({ kind: z.literal('test_id'), value: z.string().min(1) }),
  z.strictObject({ kind: z.literal('text'), value: z.string().min(1), exact: z.boolean().optional() }),
  z.strictObject({ kind: z.literal('css'), value: z.string().min(1) }),
]);
export type Selector = z.infer<typeof selectorSchema>;

export const rankedSelectorSchema = z.array(selectorSchema).min(1).max(8);
export type RankedSelector = z.infer<typeof rankedSelectorSchema>;
