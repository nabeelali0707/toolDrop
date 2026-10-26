import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ToolDropError } from '@tooldrop/core';
import { readLibraryRecipe, readToolFile } from '@tooldrop/engine';
import { openEngine } from '../home.ts';

/** `tooldrop tools list` and `tooldrop tools add <path>`. */
export async function tools(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { site: { type: 'string' } },
  });
  const [action, path] = positionals;
  const { engine, close } = openEngine();
  try {
    if (action === 'list') {
      const published = engine.listTools();
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
      const tool = engine.publish(file, site);
      console.log(`Published ${tool.name} v${tool.version} for ${tool.site.origin}.`);
      return 0;
    }

    throw new ToolDropError(
      'invalid_input',
      'usage: tooldrop tools list | tooldrop tools add <path> [--site <url>]',
    );
  } finally {
    await close();
  }
}
