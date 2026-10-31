import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { ToolDropError } from '@tooldrop/core';
import { openEngine } from '../home.ts';

// `tooldrop workflows`: tools on several sites chained into one (SPEC,
// Multi-site workflows). A run follows its job in the terminal and asks there
// when a write waits for approval.

const USAGE = `usage:
  tooldrop workflows add <file.json>
  tooldrop workflows list
  tooldrop workflows show <name>
  tooldrop workflows run <name> [--input '{"amount":100}']
  tooldrop workflows remove <name>`;

export async function workflows(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { input: { type: 'string', default: '{}' } },
  });
  const [action = 'list', target] = positionals;
  const { engine, close } = await openEngine({ backgroundHeals: false });
  try {
    if (action === 'list') {
      const all = await engine.listWorkflows();
      if (all.length === 0) console.log('No workflows. Add one with `tooldrop workflows add <file.json>`.');
      for (const workflow of all) {
        const steps = workflow.steps.map((step) => step.tool).join(' → ');
        console.log(`${workflow.name}  ${workflow.authority}  ${steps}\n  ${workflow.description}`);
      }
      return 0;
    }
    if (!target) throw new ToolDropError('invalid_input', USAGE);
    if (action === 'add') {
      let file: unknown;
      try {
        file = JSON.parse(readFileSync(target, 'utf8'));
      } catch {
        throw new ToolDropError('invalid_input', `cannot read ${target} as JSON`);
      }
      const saved = await engine.saveWorkflow(file);
      console.log(
        `Saved ${saved.name} (${saved.steps.length} steps, ${saved.authority === 'write' ? 'writes: each write waits for approval' : 'reads'}).`,
      );
      return 0;
    }
    if (action === 'show') {
      console.log(JSON.stringify(await engine.getWorkflow(target), null, 2));
      return 0;
    }
    if (action === 'remove') {
      await engine.deleteWorkflow(target);
      console.log(`Removed ${target}.`);
      return 0;
    }
    if (action === 'run') {
      let input: unknown;
      try {
        input = JSON.parse(values.input);
      } catch {
        throw new ToolDropError('invalid_input', '--input must be JSON, e.g. --input \'{"amount":100}\'');
      }
      return await follow(engine, await engine.runWorkflow(target, input));
    }
    throw new ToolDropError('invalid_input', USAGE);
  } finally {
    await close();
  }
}

type Engine = Awaited<ReturnType<typeof openEngine>>['engine'];
type Job = Awaited<ReturnType<Engine['getJob']>>;

/** Follows a run to its end, asking in the terminal when a write waits for approval. */
async function follow(engine: Engine, started: Job): Promise<number> {
  const terminal = process.stdin.isTTY
    ? createInterface({ input: process.stdin, output: process.stderr })
    : undefined;
  try {
    let job = started;
    let shown: string | null = null;
    while (['queued', 'running', 'waiting_for_answer'].includes(job.status)) {
      if (job.step && job.step !== shown) {
        console.error(`... ${job.step}`);
        shown = job.step;
      }
      const open =
        job.status === 'waiting_for_answer' ? job.questions.find((q) => q.answer === undefined) : undefined;
      if (open) {
        if (!terminal) {
          throw new ToolDropError(
            'invalid_input',
            `the run asks: "${open.text}" Answer in a terminal, on the dashboard, or over REST: POST /v1/jobs/${job.id}/answers`,
          );
        }
        console.error(`\n${open.text}`);
        const reply = (await terminal.question('approve or reject? > ')).trim().toLowerCase();
        job = await engine.answerQuestion(job.id, open.id, reply === 'approve' ? 'approve' : 'reject');
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      job = await engine.getJob(job.id);
    }
    if (job.status === 'failed') {
      console.error(`\nThe run failed: ${job.error?.message ?? 'unknown error'}`);
      return 1;
    }
    const { output } = job.result as { output: unknown };
    console.log(typeof output === 'string' ? output : JSON.stringify(output, null, 2));
    return 0;
  } finally {
    terminal?.close();
  }
}
