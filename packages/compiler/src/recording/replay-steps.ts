import type { Step } from '@tooldrop/core';
import { render, renderText, type TemplateContext } from '@tooldrop/runtime';
import type { CaptureSession } from '../capture/capture.ts';

// Replays a recipe's browser steps in a capture session, so a heal sees the
// page as the recipe left it (SPEC, Self-healing: re-run up to the failing
// step with full capture). Values that are whole {{input.*}} templates are
// marked as inputs, so a capture made this way analyzes like a recording.

const WHOLE_INPUT = /^\{\{\s*input\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;

export interface ReplayOptions {
  /** Mark the element an extract step reads as the data, as `Mark data` does. */
  markTarget?: boolean;
}

export async function replaySteps(
  session: CaptureSession,
  steps: readonly Step[],
  context: TemplateContext,
  options: ReplayOptions = {},
): Promise<void> {
  for (const step of steps) {
    switch (step.op) {
      case 'goto':
        await session.goto(renderText(step.url, context));
        break;
      case 'click':
        if (step.repeat) {
          // "Load more": click while the button shows, as the runtime does.
          for (let clicks = 0; clicks < step.repeat.max; clicks++) {
            const ref = await session.visibleRef(step.target);
            if (!ref) break;
            await session.click(ref);
          }
        } else {
          await session.click(await session.refFor(step.target));
        }
        break;
      case 'fill':
      case 'select': {
        const value = render(step.value, context);
        // An optional input the call left out leaves the field alone, as at run time.
        if (value === undefined) break;
        const name = WHOLE_INPUT.exec(step.value)?.[1];
        const input = name ? { name } : undefined;
        const ref = await session.refFor(step.target);
        if (step.op === 'fill') await session.fill(ref, renderText(step.value, context), input);
        else await session.select(ref, renderText(step.value, context), input);
        break;
      }
      case 'wait_for':
        if (step.target) await session.refFor(step.target);
        break;
      case 'extract_table':
      case 'extract_text':
        if (options.markTarget) await session.markTarget(await session.refFor(step.target));
        break;
      default:
        break;
    }
  }
}
