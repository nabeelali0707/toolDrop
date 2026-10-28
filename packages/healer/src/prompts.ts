import type { Step } from '@tooldrop/core';
import { formatSnapshot, truncate, type PageSnapshot } from '@tooldrop/compiler';

// Prompts for heals (SPEC, Self-healing step 2): the failing step, the
// recipe around it and the page as it is now, as a pruned accessibility
// tree. Never screenshots or full HTML.

export const PATCH_SYSTEM = `You repair toolDrop recipes. A recipe is a list of browser steps; one stopped working because the website changed. Propose the smallest change that makes it work again. Name elements by the refs in the page list, such as e12. Reply with JSON only.
Changes:
- {"change":"retarget","step":N,"ref":"e7"}: the same action on another element, e.g. a renamed button or a moved field.
- {"change":"insert_before","step":N,"add":{"op":"click","ref":"e5"}}: an action first, e.g. opening a panel or a tab. "fill" and "select" also take a "value".
- {"change":"remove","step":N}: a step the site no longer needs.`;

/** One step as a short line: what it does and to which element. */
export function describeStep(step: Step): string {
  const target =
    'target' in step && step.target
      ? ` [${step.target
          .map((selector) =>
            selector.kind === 'role'
              ? `${selector.role}${selector.name ? ` "${selector.name}"` : ''}`
              : `${selector.kind}=${selector.value}`,
          )
          .join(' | ')}]`
      : '';
  switch (step.op) {
    case 'goto':
      return `goto ${step.url}`;
    case 'fill':
    case 'select':
      return `${step.op}${target} with ${JSON.stringify(step.value)}`;
    case 'click':
      return `click${target}${step.repeat ? ` while it shows, at most ${step.repeat.max} times` : ''}`;
    default:
      return `${step.op}${target}`;
  }
}

export function patchPrompt(
  tool: { name: string; description: string; site: string },
  steps: readonly Step[],
  failing: { step: number; error: string },
  page: PageSnapshot,
  feedback: string | undefined,
  level: number,
): string | undefined {
  const tree = formatSnapshot(page, level);
  if (tree === undefined) return undefined;
  return [
    `Tool: ${tool.name}: ${tool.description}`,
    `Site: ${tool.site}`,
    '',
    'The recipe:',
    ...steps.map(
      (step, index) =>
        `${index}. ${describeStep(step)}${index === failing.step ? `   <- failed: ${truncate(failing.error, 200)}` : ''}`,
    ),
    ...(feedback ? ['', `Your last change did not work: ${truncate(feedback, 400)}`] : []),
    '',
    `The page just before step ${failing.step}:`,
    tree,
    '',
    'Reply with the changes.',
  ].join('\n');
}

export const REASON_SYSTEM = `You write one line for a tool's history: what changed on the website, in plain words, for a person. At most 15 words, no step numbers. Reply with JSON only: {"reason": "..."}`;

export function reasonPrompt(before: readonly Step[], after: readonly Step[]): string {
  return [
    'Before:',
    ...before.map((step) => `- ${describeStep(step)}`),
    'After:',
    ...after.map((step) => `- ${describeStep(step)}`),
  ].join('\n');
}
