import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { ToolDropError } from '@tooldrop/core';
import type { JobView } from '@tooldrop/engine';
import { openEngine } from '../home.ts';

// `tooldrop discover <url>`: look around a site from one URL and propose tools
// to build (SPEC, URL-first discovery). Each proposal comes with the
// `tooldrop build` command that builds it.

const USAGE = 'usage: tooldrop discover <url> [--max-pages 12]';

interface Proposal {
  name: string;
  description: string;
  task: string;
  url: string;
  authority: 'read' | 'write';
  inputs: string[];
  existing?: string;
}

export async function discover(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { 'max-pages': { type: 'string' } },
  });
  const [url] = positionals;
  if (!url) throw new ToolDropError('invalid_input', USAGE);
  const maxPages = values['max-pages'] === undefined ? undefined : Number(values['max-pages']);

  const { engine, close } = await openEngine();
  const terminal = process.stdin.isTTY
    ? createInterface({ input: process.stdin, output: process.stderr })
    : undefined;
  try {
    let job = await engine.startDiscover({ url, ...(maxPages !== undefined && { max_pages: maxPages }) });
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
            `discovery asks: "${open.text}" Run tooldrop discover in a terminal to answer`,
          );
        }
        console.error(`\n${open.text}`);
        open.options?.forEach((option, index) => console.error(`  ${index + 1}) ${option}`));
        const reply = (await terminal.question('> ')).trim();
        job = await engine.answerQuestion(job.id, open.id, open.options?.[Number(reply) - 1] ?? reply);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      job = await engine.getJob(job.id);
    }
    return report(job);
  } finally {
    terminal?.close();
    await close();
  }
}

function report(job: JobView): number {
  if (job.status === 'failed') {
    console.error(`\nDiscovery failed: ${job.error?.message ?? 'unknown error'}`);
    return 1;
  }
  const result = job.result as { site: string; pages: { url: string }[]; tools: Proposal[] };
  console.log(`\nLooked at ${result.pages.length} pages of ${result.site}.`);
  if (result.tools.length === 0) {
    console.log(
      'No tools to propose. Try a deeper start page, or build one with `tooldrop build <url> --task "..."`.',
    );
    return 0;
  }
  console.log('Tools worth building:\n');
  for (const tool of result.tools) {
    const inputs = tool.inputs.length > 0 ? `; inputs: ${tool.inputs.join(', ')}` : '';
    console.log(`${tool.name} (${tool.authority}${inputs})\n  ${tool.description}`);
    if (tool.existing) {
      console.log(`  Already built as ${tool.existing}.\n`);
      continue;
    }
    if (tool.authority === 'write') {
      // Builds make read tools; a write tool is a tool file with a commit step (docs: Safe mode).
      console.log(`  A write: make it as a tool file with a commit step, starting from ${tool.url}\n`);
      continue;
    }
    console.log(`  tooldrop build ${tool.url} --task ${JSON.stringify(tool.task)}\n`);
  }
  return 0;
}
