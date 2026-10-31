import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ToolDropError } from '@tooldrop/core';
import { openEngine } from '../home.ts';

// `tooldrop export <tool>`: the tool as a standalone npm package that runs
// without toolDrop (SPEC, Code export). It never holds a login.

const USAGE = 'usage: tooldrop export <tool> [--out <folder>]';

export async function exportTool(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { out: { type: 'string' } },
  });
  const [name] = positionals;
  if (!name) throw new ToolDropError('invalid_input', USAGE);
  const out = resolve(values.out ?? name);
  if (existsSync(out) && readdirSync(out).length > 0) {
    throw new ToolDropError('invalid_input', `${out} is not empty; pick another folder with --out`);
  }

  const { engine, close } = await openEngine({ backgroundHeals: false });
  try {
    const files = await engine.exportTool(name);
    for (const [path, content] of Object.entries(files)) {
      const target = join(out, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    const write = files['index.js']?.includes('export async function commit') === true;
    console.log(`Exported ${name} to ${out}. It runs without toolDrop:

  cd ${out}
  npm install
  ${files['README.md']?.includes('playwright install') ? 'npx playwright install chromium\n  ' : ''}node -e "import('./index.js').then(async (m) => console.log(await m.${write ? 'preview' : name}({})))"

See README.md there for its inputs, signing in${write ? ', and making the write' : ''}.`);
    return 0;
  } finally {
    await close();
  }
}
