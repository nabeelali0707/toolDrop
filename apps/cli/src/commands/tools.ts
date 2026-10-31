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

    if (action === 'stats' && path) {
      const stats = await engine.toolStats(path);
      const { runs, model } = stats;
      const ms = (value: number | null) => (value === null ? '–' : `${value} ms`);
      const rate = runs.success_rate === null ? '–' : `${Math.round(runs.success_rate * 1000) / 10}%`;
      const strategies = Object.entries(runs.by_strategy)
        .map(([strategy, count]) => `${strategy} ${count}`)
        .join(', ');
      console.log(`${path}, last ${stats.days} days:
  calls ${runs.total}, worked ${rate}, repaired during the call ${runs.healed}
  latency p50 ${ms(runs.p50_ms)}, p95 ${ms(runs.p95_ms)}${
    strategies
      ? `
  answered by ${strategies}`
      : ''
  }
Model use, all time:
  builds: ${model.builds.jobs} jobs, ${model.builds.calls} calls, ${model.builds.prompt_tokens + model.builds.completion_tokens} tokens, ${Math.round(model.builds.duration_ms / 1000)} s
  repairs: ${model.heals.jobs} jobs, ${model.heals.calls} calls, ${model.heals.prompt_tokens + model.heals.completion_tokens} tokens, ${Math.round(model.heals.duration_ms / 1000)} s`);
      for (const job of stats.jobs.filter((entry) => entry.kind === 'heal').slice(0, 10)) {
        console.log(`  ${job.created_at}  repair ${job.status}${job.reason ? `: ${job.reason}` : ''}`);
      }
      return 0;
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
      'usage: tooldrop tools list | tools add <path> [--site <url>] | tools check | tools stats <tool> | tools versions <tool> | tools rollback <tool> <version>',
    );
  } finally {
    await close();
  }
}
