import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ToolDropError } from '@tooldrop/core';
import { readLibraryRecipe, readToolFile } from '@tooldrop/engine';
import { openEngine } from '../home.ts';

/** `tooldrop tools`: list, add, versions and rollback. */
export async function tools(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { site: { type: 'string' } },
  });
  const [action, path] = positionals;
  const { engine, close } = await openEngine();
  try {
    if (action === 'list') {
      const published = await engine.listTools();
      if (published.length === 0) {
        console.log('No tools yet. Add one with `tooldrop tools add <path>`.');
        return 0;
      }
      for (const tool of published) {
        console.log(
          `${tool.name}  v${tool.version}  ${tool.authority}  ${tool.site.origin}\n  ${tool.description}`,
        );
      }
      return 0;
    }

    if (action === 'add' && path) {
      const isLibraryFolder = statSync(path).isDirectory() && existsSync(join(path, 'manifest.json'));
      const { file, site } = isLibraryFolder
        ? readLibraryRecipe(path)
        : { file: readToolFile(path), site: values.site };
      if (!site) {
        throw new ToolDropError(
          'invalid_input',
          'a tool file needs --site <url>, e.g. --site https://example.com',
        );
      }
      const tool = await engine.publish(file, site);
      console.log(`Published ${tool.name} v${tool.version} for ${tool.site.origin}.`);
      return 0;
    }

    if (action === 'check') {
      const results = await engine.healthCheck();
      if (results.length === 0) console.log('No tool has saved test inputs to check with.');
      for (const result of results) {
        const state = result.ok ? (result.healed ? 'repaired' : 'ok') : 'FAILED';
        console.log(`${state}  ${result.tool}${result.error ? `: ${result.error}` : ''}`);
      }
      // Repairs started by the check finish before the command exits.
      await engine.heals.idle();
      return results.every((result) => result.ok) ? 0 : 1;
    }

    if (action === 'versions' && path) {
      for (const version of await engine.versions(path)) {
        const reason = version.change_reason ? `  ${version.change_reason}` : '';
        console.log(
          `${version.current ? '*' : ' '} v${version.version}  ${version.strategy}  ${version.created_by}  ${version.created_at}${reason}`,
        );
      }
      return 0;
    }

    if (action === 'rollback' && path) {
      const version = Number(positionals[2]);
      if (!Number.isInteger(version)) {
        throw new ToolDropError('invalid_input', 'usage: tooldrop tools rollback <tool> <version>');
      }
      const tool = await engine.rollback(path, version);
      console.log(`${tool.name} is back on version ${tool.version}.`);
      return 0;
    }

    throw new ToolDropError(
      'invalid_input',
      'usage: tooldrop tools list | tools add <path> [--site <url>] | tools check | tools versions <tool> | tools rollback <tool> <version>',
    );
  } finally {
    await close();
  }
}
