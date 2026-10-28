import { parseArgs } from 'node:util';
import { ToolDropError } from '@tooldrop/core';
import { openEngine } from '../home.ts';
import { describeApproval } from './approvals.ts';

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
  } catch (error) {
    // A write waits for approval (SPEC, Safe mode): say what it would do and how to decide.
    if (!(error instanceof ToolDropError) || error.code !== 'approval_required') throw error;
    const id = (error.details as { approval_id?: string } | undefined)?.approval_id ?? '';
    console.log(`${name} changes the site, so it waits for your approval.\n`);
    console.log(describeApproval(engine.getApproval(id)));
    console.log(
      `\nApprove it:  tooldrop approvals approve ${id}\nReject it:   tooldrop approvals reject ${id}`,
    );
    return 2;
  } finally {
    await close();
  }
}
