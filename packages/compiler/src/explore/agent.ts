import { identifierSchema, ToolDropError } from '@tooldrop/core';
import { fitPrompt } from '@tooldrop/llm';
import { z } from 'zod';
import { CaptureSession, type Capture, type CaptureOptions } from '../capture/capture.ts';
import type { PageSnapshot } from '../capture/page-helpers.ts';
import { formatSnapshot, truncate } from '../prompt/ax-prune.ts';
import type { TaskContext } from '../generate/prompts.ts';
import { promptBudget, type ModelAccess } from '../generate/recipe.ts';

// Agent mode (SPEC, Build pipeline step 3): without a recording, the
// reasoning model drives the page from its pruned accessibility tree, one
// action per turn, within a budget. When it cannot reach the data, the build
// asks for a recording instead of exploring further (DECISIONS.md, D-007).

export const DEFAULT_ACTION_BUDGET = 30;

const ref = z.string().regex(/^e\d+$/, 'a ref from the page list, such as e12');
const reason = z.string().max(300);
const input = identifierSchema.optional();

export const exploreActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('click'), ref, reason }),
  z.strictObject({ action: z.literal('fill'), ref, value: z.string().max(500), input, reason }),
  z.strictObject({ action: z.literal('select'), ref, value: z.string().max(200), input, reason }),
  z.strictObject({ action: z.literal('navigate'), url: z.string().min(1).max(2000), reason }),
  z.strictObject({ action: z.literal('wait'), reason }),
  z.strictObject({ action: z.literal('extract'), ref, reason }),
  z.strictObject({ action: z.literal('give_up'), reason }),
]);
export type ExploreAction = z.infer<typeof exploreActionSchema>;

export const EXPLORE_SYSTEM = `You explore a website to reach the data a task needs, acting on the page as a person would. You see the page as a list of elements, each with a ref such as [e12].
Reply with one action as JSON:
- {"action":"click","ref":"e12","reason":"..."}
- {"action":"fill","ref":"e3","value":"...","input":"name","reason":"..."}
- {"action":"select","ref":"e4","value":"option","input":"name","reason":"..."}
- {"action":"navigate","url":"/path","reason":"..."}
- {"action":"wait","reason":"..."}
- {"action":"extract","ref":"e7","reason":"..."} when the data the task needs is on screen: the ref of the table, list or text holding it.
- {"action":"give_up","reason":"..."} when you cannot find the data.
Set "input" (snake_case) when the value is one the tool's caller should choose, such as a filter or a search term; leave it out for fixed values.
Never do anything that changes data: no orders, payments, messages, deletions or saved settings. Searching, filtering and opening pages is fine. Stay on this site.`;

export type ExploreOutcome = { capture: Capture } | { gaveUp: string };

export interface ExploreOptions extends CaptureOptions {
  /** Most actions before giving up (default 30). */
  budget?: number;
}

export async function explore(
  access: ModelAccess,
  context: TaskContext,
  url: string,
  options: ExploreOptions = {},
): Promise<ExploreOutcome> {
  const budget = options.budget ?? DEFAULT_ACTION_BUDGET;
  const session = await CaptureSession.start(url, options);
  const history: string[] = [];
  try {
    for (let turn = 0; turn < budget; turn++) {
      const snapshot = await session.snapshot();
      const prompt = fitPrompt(
        'explore',
        (level) => explorePrompt(context, snapshot, history, budget, level),
        promptBudget(access, EXPLORE_SYSTEM),
      );
      const action = await access.llm.generateJson({
        role: 'reasoning',
        purpose: 'explore',
        schema: exploreActionSchema,
        system: EXPLORE_SYSTEM,
        prompt,
        ...(access.jobId !== undefined && { job_id: access.jobId }),
        ...(access.masker && { masker: access.masker }),
      });
      if (action.action === 'give_up') {
        await session.abort();
        return { gaveUp: action.reason };
      }
      try {
        if (action.action === 'extract') {
          await session.markTarget(action.ref);
          return { capture: await session.finish() };
        }
        await act(session, action, snapshot, context.site);
        history.push(`${turn + 1}. ${describe(action, snapshot)}`);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        history.push(`${turn + 1}. ${describe(action, snapshot)} failed: ${truncate(text, 200)}`);
      }
    }
    await session.abort();
    return { gaveUp: `the data was not reached within ${budget} actions` };
  } catch (error) {
    await session.abort();
    throw error;
  }
}

async function act(
  session: CaptureSession,
  action: ExploreAction,
  snapshot: PageSnapshot,
  site: string,
): Promise<void> {
  const named = (name: string | undefined) => (name ? { name } : undefined);
  switch (action.action) {
    case 'click':
      return session.click(action.ref);
    case 'fill':
      return session.fill(action.ref, action.value, named(action.input));
    case 'select':
      return session.select(action.ref, action.value, named(action.input));
    case 'navigate': {
      const target = new URL(action.url, snapshot.url);
      if (target.origin !== new URL(site).origin) {
        throw new ToolDropError('invalid_input', `${target.origin} is another site; stay on ${site}`);
      }
      return session.goto(target.href);
    }
    case 'wait':
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      return;
    default:
      return;
  }
}

function describe(action: ExploreAction, snapshot: PageSnapshot): string {
  const node = 'ref' in action ? snapshot.nodes.find((n) => n.ref === action.ref) : undefined;
  const element = node ? `[${node.ref}] ${node.role}${node.name ? ` "${truncate(node.name, 40)}"` : ''}` : '';
  switch (action.action) {
    case 'fill':
    case 'select':
      return `${action.action} ${element} with "${truncate(action.value, 40)}"${action.input ? ` (input ${action.input})` : ''}`;
    case 'navigate':
      return `navigate to ${truncate(action.url, 80)}`;
    default:
      return `${action.action} ${element}`.trim();
  }
}

export function explorePrompt(
  context: TaskContext,
  snapshot: PageSnapshot,
  history: string[],
  budget: number,
  level: number,
): string | undefined {
  const page = formatSnapshot(snapshot, level);
  if (page === undefined) return undefined;
  const recent = level === 0 ? history : history.slice(-5);
  return [
    `Task: ${context.task}`,
    `Site: ${context.site}`,
    ...context.answers.flatMap(({ question, answer }) => [`Asked: ${question}`, `Answer: ${answer}`]),
    '',
    history.length > 0
      ? `Actions so far (${history.length} of ${budget}):`
      : `No actions yet (budget: ${budget}).`,
    ...recent,
    '',
    'The page now:',
    page,
    '',
    'What is the next action?',
  ].join('\n');
}
