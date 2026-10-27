import type { Capture } from '../capture/capture.ts';
import { targetRows } from '../analyze/rank.ts';
import { truncate } from '../prompt/ax-prune.ts';
import { summarizeExchanges } from '../prompt/har-summary.ts';
import { formatSubtree } from '../prompt/html-subtree.ts';
import type { StrategyPlan } from './strategy.ts';

// Prompts for local models (SPEC, Local LLM usage): short and concrete, with
// pruned evidence that fits the budget, asking for JSON a schema checks.
// Each builder takes a level and prunes harder as it rises, for fitPrompt.

export interface TaskContext {
  task: string;
  site: string;
  /** Questions asked during the build, with the caller's answers. */
  answers: { question: string; answer: string }[];
  /** Extra guidance from the caller about inputs (SPEC, build input `inputs_hint`). */
  inputsHint?: string;
}

export const RECIPE_SYSTEM = `You write toolDrop recipes. A recipe is a JSON object that toolDrop's runtime executes step by step; it is never code.

Format: {"strategy": "<strategy>", "steps": [step, ...]}
Steps:
- {"op":"http","method":"GET|POST|PUT|PATCH|DELETE","url":"...","query":{},"headers":{},"body":<json>,"body_format":"json|form","paginate":{"var":"page","start":1,"until":"$.hasMore == false"},"save":{"name":"$.path"}}
- {"op":"map","path":"$.items[*]","fields":{"field_name":"$.path.in.each.item"}}
- {"op":"extract_table","target":[selector],"columns":{"field_name":"Column header"}}
- {"op":"extract_text","target":[selector],"attribute":"content","save":"name"}
- browser_script only: goto {url}, click {target, repeat:{max}}, fill {target, value}, select {target, value}, wait_for {target}
Selectors: {"kind":"role","role":"button","name":"Search"}, {"kind":"test_id","value":"x"}, {"kind":"text","value":"x"}, {"kind":"css","value":"#x"}
Templates in strings: {{site}} the site's origin; {{input.NAME}} a tool input; {{vars.NAME}} a value an earlier step saved; {{loop.VAR}} the page counter of the step that paginates.
The recipe returns what its last map, extract_table or extract_text step produces.
Reply with the JSON object only.`;

/** The task, the inputs and the data the person saw, shared by several prompts. */
function taskLines(context: TaskContext, capture: Capture, rows: number): string[] {
  const lines = [`Task: ${context.task}`, `Site: ${context.site}`];
  if (context.inputsHint) lines.push(`About the inputs: ${context.inputsHint}`);
  lines.push(...inputLines(capture));
  for (const { question, answer } of context.answers) lines.push(`Asked: ${question}`, `Answer: ${answer}`);
  if (capture.target) {
    const { headers, rows: data } = targetRows(capture.target.data);
    lines.push(
      '',
      `The data the tool must return (${capture.target.data.kind}, ${data.length} rows on screen):`,
    );
    lines.push(headers.join(' | '));
    for (const row of data.slice(0, rows)) lines.push(row.map((cell) => truncate(cell, 40)).join(' | '));
  }
  return lines;
}

function inputLines(capture: Capture): string[] {
  if (capture.inputs.length === 0) return ['Inputs: none'];
  return [
    'Inputs:',
    ...capture.inputs.map((input) => {
      const action = capture.actions[input.action];
      const options =
        action?.kind === 'select'
          ? `, one of: ${action.options
              .filter((o) => o.value !== '')
              .map((o) => o.value)
              .slice(0, 12)
              .join(', ')}`
          : '';
      return `- ${input.name} (example "${truncate(input.example, 40)}"${options})`;
    }),
  ];
}

export function recipePrompt(
  context: TaskContext,
  capture: Capture,
  plan: StrategyPlan,
  problem: string | undefined,
  level: number,
): string | undefined {
  if (level > 2) return undefined;
  const lines = taskLines(context, capture, 2 - level);
  if (plan.analysis && plan.strategy === 'http_replay') {
    const summary = summarizeExchanges(
      [{ exchange: plan.analysis.exchange, fields: plan.analysis.fields }],
      level,
    );
    lines.push('', 'The request that returned the data, with what each field is:', summary ?? '');
  }
  if (plan.strategy === 'html_fetch' && capture.target) {
    const page = plan.analysis?.exchange.response_body ?? '';
    const subtree = formatSubtree(page, targetRows(capture.target.data).rows.flat(), level);
    if (subtree) lines.push('', 'Where the data is in the page:', subtree);
  }
  lines.push(
    '',
    `Draft recipe, built from the captured evidence (strategy ${plan.strategy}):`,
    JSON.stringify({ strategy: plan.strategy, steps: plan.draft.steps }),
  );
  if (problem) lines.push('', `The last recipe failed when it ran: ${truncate(problem, 600)}`);
  lines.push(
    '',
    `Reply with the recipe for strategy "${plan.strategy}". Keep the draft's requests, templates, selectors and paths unless the evidence shows they are wrong.`,
    'Name output fields in snake_case after what they mean, and keep only the fields the task needs; always keep a field that identifies each row, such as a number or ID.',
  );
  return lines.join('\n');
}

export const DESCRIBE_SYSTEM = `You name and describe tools that AI agents call. Reply with JSON only.
- name: lowercase snake_case, a verb then a noun, e.g. "list_invoices" or "get_order_status"; at most 40 characters.
- description: one or two plain sentences saying what the tool returns and how the inputs filter it.
- For every input and output field: one short sentence.
- required: true only when the tool cannot work without the input.`;

export function describePrompt(
  context: TaskContext,
  capture: Capture,
  fields: { name: string; samples: unknown[] }[],
  level: number,
): string | undefined {
  if (level > 1) return undefined;
  const sampleWidth = level === 0 ? 40 : 15;
  return [
    ...taskLines({ ...context, answers: [] }, capture, 0),
    '',
    'Output fields, with sample values:',
    ...fields.map(
      ({ name, samples }) =>
        `- ${name}: ${samples
          .slice(0, 2)
          .map((sample) => truncate(JSON.stringify(sample) ?? 'null', sampleWidth))
          .join(', ')}`,
    ),
  ].join('\n');
}

export const CLARIFY_SYSTEM = `You check whether a task for a website tool is clear enough to build. Most tasks are: then reply {"questions": []}.
Ask only when the answer changes what the tool does, for example when the person may mean one of several accounts, or whether to return every page or only the first. Ask at most two short questions, with options when there are a few possible answers. Reply with JSON only.`;

export function clarifyPrompt(
  context: TaskContext,
  capture: Capture,
  notes: string[],
  level: number,
): string | undefined {
  if (level > 1) return undefined;
  return [
    ...taskLines(context, capture, level === 0 ? 2 : 0),
    '',
    'What the capture shows:',
    ...notes.map((note) => `- ${note}`),
  ].join('\n');
}

export const CLASSIFY_SYSTEM = `You classify fields of a captured web request whose purpose is unclear. Reply with JSON only.
Kinds: "constant" (the same on every call, such as an app version), "auth" (a credential or a value tied to one session, such as a signature or nonce), "derived" (an ID from an earlier response).`;

export function classifyPrompt(
  context: TaskContext,
  fields: { location: string; name: string; value: string }[],
  level: number,
): string | undefined {
  if (level > 1) return undefined;
  const width = level === 0 ? 60 : 24;
  return [
    `Task: ${context.task}`,
    `Site: ${context.site}`,
    '',
    'Fields:',
    ...fields.map((field) => `- ${field.location} ${field.name} = "${truncate(field.value, width)}"`),
  ].join('\n');
}
