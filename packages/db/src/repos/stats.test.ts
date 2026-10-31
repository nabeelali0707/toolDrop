import type { Recipe, ToolDefinition } from '@tooldrop/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../client.ts';
import { DIALECTS, openTestDatabase } from '../testing.ts';
import {
  createJob,
  getVersion,
  percentile,
  publishTool,
  recordLlmCall,
  recordRun,
  runStats,
  setJobStatus,
  toolJobs,
  usageByJob,
} from './index.ts';

const definition: ToolDefinition = {
  name: 'list_invoices',
  description: 'List invoices.',
  authority: 'read',
  input_schema: { type: 'object' },
  output_schema: { type: 'array' },
};
const recipe: Recipe = {
  strategy: 'http_replay',
  steps: [{ op: 'http', method: 'GET', url: '{{site}}/api' }],
};

describe('percentile', () => {
  it('takes the nearest rank', () => {
    const values = Array.from({ length: 20 }, (_, i) => (i + 1) * 10);
    expect(percentile(values, 50)).toBe(100);
    expect(percentile(values, 95)).toBe(190);
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([], 50)).toBeNull();
  });
});

describe.each(DIALECTS)('on %s', (dialect) => {
  let handle: DatabaseHandle;
  beforeEach(async () => {
    handle = await openTestDatabase(dialect);
  });
  afterEach(() => handle.close());

  const publish = (name = definition.name) =>
    publishTool(handle.db, {
      site: 'http://127.0.0.1:4101',
      definition: { ...definition, name },
      recipe,
      created_by: 'build',
    });

  it('sums up how a tool’s calls went', async () => {
    const tool = await publish();
    const run = (duration_ms: number, ok = true, strategy_used: Recipe['strategy'] = 'http_replay') =>
      recordRun(handle.db, { tool_id: tool.id, recipe_version: 1, strategy_used, duration_ms, ok });
    for (const ms of [100, 120, 140, 160, 900]) await run(ms);
    await run(3000, true, 'browser_script');
    await run(0, false);
    await recordRun(handle.db, {
      tool_id: tool.id,
      recipe_version: 1,
      strategy_used: 'browser_script',
      duration_ms: 4000,
      ok: true,
      healed: true,
    });

    const stats = await runStats(handle.db, tool.id, new Date(Date.now() - 86_400_000));
    expect(stats).toEqual({
      total: 8,
      ok: 7,
      failed: 1,
      healed: 1,
      success_rate: 7 / 8,
      p50_ms: 160,
      p95_ms: 4000,
      by_strategy: { http_replay: 5, browser_script: 2 },
    });
    expect(await runStats(handle.db, tool.id, new Date(Date.now() + 60_000))).toMatchObject({
      total: 0,
      success_rate: null,
      p50_ms: null,
    });
  });

  it('finds a tool’s builds and heals, with their model use', async () => {
    await publish();
    const build = await createJob(handle.db, { kind: 'build', input: { task: 'List invoices' } });
    await setJobStatus(handle.db, build.id, 'running');
    await setJobStatus(handle.db, build.id, 'succeeded', { result: { tool: 'list_invoices', version: 1 } });
    const heal = await createJob(handle.db, {
      kind: 'heal',
      input: { tool: 'list_invoices', version: 1, trigger: { kind: 'drift' } },
    });
    const other = await createJob(handle.db, { kind: 'heal', input: { tool: 'list_orders', version: 1 } });
    const call = { purpose: 'write_recipe', provider: 'ollama' as const, model: 'm', role: 'code' as const };
    for (const [job, attempt] of [
      [build.id, 1],
      [build.id, 2],
      [heal.id, 1],
    ] as const) {
      await recordLlmCall(handle.db, {
        ...call,
        job_id: job,
        attempt,
        ok: true,
        prompt_tokens: 1000,
        completion_tokens: 100,
        duration_ms: 2000,
      });
    }

    const jobs = await toolJobs(handle.db, 'list_invoices');
    expect(jobs.map((job) => job.id).sort()).toEqual([build.id, heal.id].sort());
    const usage = await usageByJob(handle.db, [build.id, heal.id, other.id]);
    expect(usage.get(build.id)).toEqual({
      calls: 2,
      retries: 1,
      prompt_tokens: 2000,
      completion_tokens: 200,
      duration_ms: 4000,
    });
    expect(usage.get(heal.id)).toMatchObject({ calls: 1, retries: 0 });
    expect(usage.has(other.id)).toBe(false);
  });

  it('reads one version with its recipe', async () => {
    await publish();
    expect(await getVersion(handle.db, 'list_invoices', 1)).toMatchObject({
      version: 1,
      created_by: 'build',
      current: true,
      recipe,
    });
    await expect(getVersion(handle.db, 'list_invoices', 2)).rejects.toThrow('has no version 2');
  });
});
