import { ToolDropError, type Step } from '@tooldrop/core';
import type { CaptureSession } from '@tooldrop/compiler';
import { z } from 'zod';

// A heal patch (SPEC, Self-healing step 3): the smallest change to a browser
// recipe's steps. The model names elements by the refs in the page list it
// was shown; the healer turns each ref into ranked selectors checked on the
// live page, so a model never writes a selector.

const ref = z.string().regex(/^e\d+$/, 'a ref from the page list, such as e12');
const step = z.number().int().nonnegative();

/** An action a patch can add: the browser actions a person takes. */
export const patchActionSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('click'), ref }),
  z.strictObject({ op: z.literal('fill'), ref, value: z.string().max(500) }),
  z.strictObject({ op: z.literal('select'), ref, value: z.string().max(200) }),
  z.strictObject({ op: z.literal('wait_for'), ref }),
]);

export const patchSchema = z.strictObject({
  changes: z
    .array(
      z.discriminatedUnion('change', [
        /** The same action on another element: a renamed button, a moved field. */
        z.strictObject({ change: z.literal('retarget'), step, ref }),
        /** An extra action first, such as opening a panel. */
        z.strictObject({ change: z.literal('insert_before'), step, add: patchActionSchema }),
        /** A step the site no longer needs. */
        z.strictObject({ change: z.literal('remove'), step }),
      ]),
    )
    .min(1)
    .max(5),
});
export type Patch = z.infer<typeof patchSchema>;

/**
 * The steps with the patch applied. Changes refer to step numbers in the
 * original list; they are applied from the last step back, so the numbers
 * stay valid. Elements are described on the page the session shows now.
 */
export async function applyPatch(
  session: CaptureSession,
  steps: readonly Step[],
  patch: Patch,
): Promise<Step[]> {
  const result: Step[] = [...steps];
  // At one step, change the step itself before inserting in front of it.
  const inserts = (change: Patch['changes'][number]) => (change.change === 'insert_before' ? 1 : 0);
  const ordered = [...patch.changes].sort((a, b) => b.step - a.step || inserts(a) - inserts(b));
  for (const change of ordered) {
    const original = steps[change.step];
    if (!original) throw new ToolDropError('invalid_input', `the recipe has no step ${change.step}`);
    if (change.change === 'remove') {
      result.splice(change.step, 1);
      continue;
    }
    if (change.change === 'retarget') {
      if (!('target' in original) || !original.target) {
        throw new ToolDropError(
          'invalid_input',
          `step ${change.step} (${original.op}) has no element to change`,
        );
      }
      const { target } = await session.selectorsFor(change.ref);
      result[change.step] = { ...original, target };
      continue;
    }
    const { target } = await session.selectorsFor(change.add.ref);
    const added: Step =
      change.add.op === 'fill' || change.add.op === 'select'
        ? { op: change.add.op, target, value: change.add.value }
        : { op: change.add.op, target };
    result.splice(change.step, 0, added);
  }
  return result;
}
