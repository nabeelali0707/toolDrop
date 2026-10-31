import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { ToolDropError, type MarkedInput } from '@tooldrop/core';
import { identifier, Recorder, suggestedInputName } from '@tooldrop/compiler';
import { openEngine } from '../home.ts';

/**
 * `tooldrop record <url>`: do a task once in a browser window, mark the data,
 * and name the inputs. The recording makes the most reliable builds, with no
 * model exploring the site (DECISIONS.md, D-016).
 */
export async function record(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { task: { type: 'string' }, out: { type: 'string' } },
  });
  const [url] = positionals;
  if (!url) {
    throw new ToolDropError('invalid_input', 'usage: tooldrop record <url> [--task "..."] [--out file.json]');
  }
  if (!process.stdin.isTTY) {
    throw new ToolDropError(
      'invalid_input',
      'tooldrop record opens a browser window and asks you questions: run it in a terminal',
    );
  }

  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const { engine, close } = await openEngine({ backgroundHeals: false });
  try {
    // A site with a saved login opens signed in, so the recording holds only the task.
    const signedIn = await engine.sessions.ensure(url, {
      ask: async ({ text }) => (await terminal.question(`${text}\nCode: `)).trim(),
    });
    console.log(`Opening a browser at ${url}${signedIn ? ', signed in with your saved login' : ''}.
1. Do the task once: search, filter, open pages.
2. Click "Mark data" in the toolDrop bar, then click the table or list you want.
3. Click "Finish".`);
    const recorder = await Recorder.start(url, { ...(signedIn && { storageState: signedIn.state }) });
    for (;;) {
      await recorder.nextFinish();
      if (recorder.target || recorder.closed) break;
      console.log('Mark the data first: click "Mark data", then the table or list, then "Finish".');
    }
    if (!recorder.target) {
      await recorder.stop([]).catch(() => undefined);
      console.error('The window closed before the data was marked; nothing was saved.');
      return 1;
    }

    const inputs: MarkedInput[] = [];
    const typed = recorder.valueActions();
    if (typed.length > 0) {
      console.log('\nYou typed or picked:');
      typed.forEach(({ action }, n) => console.log(`  ${n + 1}) ${action.label}: "${action.value}"`));
      const picked = (
        await terminal.question(
          'Which should the tool ask for on every call? Numbers, comma-separated, or Enter for none: ',
        )
      )
        .split(',')
        .map((text) => Number(text.trim()))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= typed.length);
      for (const n of [...new Set(picked)]) {
        const { index, action } = typed[n - 1]!;
        const suggested = suggestedInputName(action.label);
        const answer = (await terminal.question(`Name for ${action.label} [${suggested}]: `)).trim();
        const name = answer ? identifier(answer) : suggested;
        inputs.push({ name, action: index, example: action.value ?? '' });
      }
    }

    const recording = await recorder.stop(inputs, values.task);
    const { id } = engine.saveRecording(recording);
    if (values.out) writeFileSync(values.out, `${JSON.stringify(recording, null, 2)}\n`);
    console.log(`\nSaved the recording as ${id}${values.out ? ` and in ${values.out}` : ''}. Build the tool with:
  tooldrop build ${url} --task "${values.task ?? 'what the tool does'}" --recording ${id}`);
    return 0;
  } finally {
    terminal.close();
    await close();
  }
}
