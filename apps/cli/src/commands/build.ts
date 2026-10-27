import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { idSchema, ToolDropError } from '@tooldrop/core';
import type { Engine, JobView } from '@tooldrop/engine';
import { openEngine } from '../home.ts';

const USAGE =
  'usage: tooldrop build <url> --task "what the tool does" [--recording <id or file>] [--hint "about the inputs"]';

/**
 * `tooldrop build`: builds a tool in this process (SPEC, Build pipeline),
 * printing each step and asking the build's questions in the terminal.
 */
export async function build(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      task: { type: 'string' },
      recording: { type: 'string' },
      hint: { type: 'string' },
    },
  });
  const [url] = positionals;
  if (!url || !values.task) throw new ToolDropError('invalid_input', USAGE);

  const { engine, close } = openEngine();
  const terminal = process.stdin.isTTY
    ? createInterface({ input: process.stdin, output: process.stderr })
    : undefined;
  try {
    const recordingId = values.recording ? recordingFor(engine, values.recording) : undefined;
    let job = engine.startBuild({
      url,
      task: values.task,
      authority: 'read',
      ...(values.hint !== undefined && { inputs_hint: values.hint }),
      ...(recordingId && { recording_id: recordingId }),
    });
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
            `the build asks: "${open.text}" Run tooldrop build in a terminal to answer, or answer over REST: POST /v1/jobs/${job.id}/answers`,
          );
        }
        console.error(`\n${open.text}`);
        open.options?.forEach((option, index) => console.error(`  ${index + 1}) ${option}`));
        const reply = (await terminal.question('> ')).trim();
        job = engine.answerQuestion(job.id, open.id, open.options?.[Number(reply) - 1] ?? reply);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      job = engine.getJob(job.id);
    }
    return report(job);
  } finally {
    terminal?.close();
    await close();
  }
}

/** A recording ID as is; a file is stored first, like an upload. */
function recordingFor(engine: Engine, value: string): string {
  if (idSchema.safeParse(value).success) return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(value, 'utf8'));
  } catch {
    throw new ToolDropError(
      'invalid_input',
      `--recording takes a recording ID or a recording file; cannot read ${value}`,
    );
  }
  return engine.saveRecording(parsed).id;
}

function report(job: JobView): number {
  if (job.status === 'failed') {
    console.error(`\nThe build failed: ${job.error?.message ?? 'unknown error'}`);
    return 1;
  }
  const result = job.result as {
    tool: string;
    reused?: boolean;
    strategy?: string;
    version?: number;
    attempts?: number;
    input_schema?: { properties?: Record<string, unknown> };
    sample?: unknown;
  };
  if (result.reused) {
    console.log(`${result.tool} already does this. Run it with: tooldrop run ${result.tool}`);
    return 0;
  }
  const inputs = Object.keys(result.input_schema?.properties ?? {});
  const { usage } = job;
  console.log(
    [
      '',
      `Built ${result.tool} (${result.strategy}, version ${result.version}) in ${result.attempts} attempt${result.attempts === 1 ? '' : 's'}.`,
      `Inputs: ${inputs.length > 0 ? inputs.join(', ') : 'none'}`,
      'First results:',
      JSON.stringify(result.sample, null, 2),
      `Model use: ${usage.calls} calls, ${usage.prompt_tokens} prompt and ${usage.completion_tokens} completion tokens, ${(usage.duration_ms / 1000).toFixed(1)} s.`,
      '',
      `Run it: tooldrop run ${result.tool}${inputs.length > 0 ? ` --input '{"${inputs[0]}": "..."}'` : ''}`,
      'Your MCP client lists it as a tool now.',
    ].join('\n'),
  );
  return 0;
}
