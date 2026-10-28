import { parseArgs } from 'node:util';
import { ToolDropError } from '@tooldrop/core';
import { openEngine } from '../home.ts';

/** `tooldrop run <tool> --input '{...}'`: runs a published tool and prints its result. */
export async function run(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { input: { type: 'string', default: '{}' } },
  });
  const [name] = positionals;
  if (!name) throw new ToolDropError('invalid_input', 'usage: tooldrop run <tool> [--input JSON]');

  let input: unknown;
  try {
    input = JSON.parse(values.input);
  } catch {
    throw new ToolDropError('invalid_input', '--input must be JSON, e.g. --input \'{"status":"open"}\'');
  }

  // A one-shot command exits after printing, so it leaves background repairs to serve and mcp.
  const { engine, close } = openEngine({ backgroundHeals: false });
  try {
    const { result, meta } = await engine.runTool(name, input);
    console.log(JSON.stringify({ result, meta }, null, 2));
    return 0;
  } finally {
    await close();
  }
}
