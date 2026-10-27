import { z } from 'zod';
import { identifierSchema } from './common.ts';
import { rankedSelectorSchema } from './recipe/selectors.ts';

// Recording format v1: a task done once by a person, in `tooldrop record` or
// the Chrome extension (SPEC, Build pipeline step 3). A build replays the
// actions in its own browser, so a recording needs no network log; the
// extension may attach one as HAR for sites that block automated browsers.

const label = z.string().max(200);

export const recordedActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('goto'), url: z.url({ protocol: /^https?$/ }) }),
  z.strictObject({ kind: z.literal('click'), target: rankedSelectorSchema, label }),
  z.strictObject({
    kind: z.literal('fill'),
    target: rankedSelectorSchema,
    label,
    /** Null for a password field: recorders never keep what was typed into one. */
    value: z.string().max(2000).nullable(),
    secret: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal('select'),
    target: rankedSelectorSchema,
    label,
    /** The option's value, which is what a recipe selects. */
    value: z.string().max(500),
    options: z.array(z.strictObject({ value: z.string(), label: z.string() })).max(500),
  }),
]);
export type RecordedAction = z.infer<typeof recordedActionSchema>;

/** A value the person typed or picked that becomes a tool input. */
export const markedInputSchema = z.strictObject({
  name: identifierSchema,
  /** Index of the fill or select action whose value the input replaces. */
  action: z.number().int().nonnegative(),
  example: z.string().max(2000),
  description: z.string().max(500).optional(),
});
export type MarkedInput = z.infer<typeof markedInputSchema>;

export const RECORDERS = ['cli', 'extension'] as const;

export const recordingSchema = z
  .strictObject({
    version: z.literal(1),
    recorder: z.enum(RECORDERS),
    recorded_at: z.number().int(),
    /** What the person was doing, in their words. */
    task: z.string().max(2000).optional(),
    /** Starts with the page the recording began on. */
    actions: z.array(recordedActionSchema).min(1).max(500),
    inputs: z.array(markedInputSchema).max(50),
    /** The table, list or text holding the data the tool returns. */
    target: z.strictObject({ selector: rankedSelectorSchema, label: label.optional() }).optional(),
    /** The network log as HAR 1.2, masked; optional. */
    har: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((recording, ctx) => {
    if (recording.actions[0]?.kind !== 'goto') {
      ctx.addIssue({
        code: 'custom',
        message: 'a recording starts with the page it began on',
        path: ['actions', 0],
      });
    }
    const names = new Set<string>();
    recording.inputs.forEach((input, index) => {
      const action = recording.actions[input.action];
      if (!action || (action.kind !== 'fill' && action.kind !== 'select') || action.value === null) {
        ctx.addIssue({
          code: 'custom',
          message: `input ${input.name} must point at a fill or select action with a value`,
          path: ['inputs', index, 'action'],
        });
      }
      if (names.has(input.name)) {
        ctx.addIssue({
          code: 'custom',
          message: `input ${input.name} is marked twice`,
          path: ['inputs', index, 'name'],
        });
      }
      names.add(input.name);
    });
  });
export type Recording = z.infer<typeof recordingSchema>;

/** The page a recording starts on. */
export function recordingUrl(recording: Recording): string {
  const first = recording.actions[0];
  return first?.kind === 'goto' ? first.url : '';
}
