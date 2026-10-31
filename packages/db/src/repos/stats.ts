import type { Strategy } from '@tooldrop/core';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { tablesOf, type Queryable } from '../client.ts';
import type { JobRow } from './jobs.ts';
import type { JobUsage } from './llm-calls.ts';

// What the transparency dashboard shows for a tool (SPEC, Differentiating
// features): how its calls went, and what its builds and heals cost in model
// time. Percentiles are worked out here rather than in SQL, which SQLite and
// Postgres do differently.

export interface RunStats {
  total: number;
  ok: number;
  failed: number;
  /** Calls that waited for a repair and then worked. */
  healed: number;
  /** Share of calls that worked, from 0 to 1; null without calls. */
  success_rate: number | null;
  /** Of the calls that worked, in milliseconds; null without any. */
  p50_ms: number | null;
  p95_ms: number | null;
  /** Calls that worked, by the strategy that answered. */
  by_strategy: Partial<Record<Strategy, number>>;
}

/** The most runs a summary reads: enough for a month of a busy tool. */
const MAX_RUNS = 20_000;

/** How a tool's calls went since `since`. */
export async function runStats(db: Queryable, toolId: string, since: Date): Promise<RunStats> {
  const { runs } = tablesOf(db);
  const rows = await db
    .select({
      ok: runs.ok,
      duration_ms: runs.duration_ms,
      strategy_used: runs.strategy_used,
      healed: runs.healed,
    })
    .from(runs)
    .where(and(eq(runs.tool_id, toolId), gte(runs.created_at, since)))
    .orderBy(desc(runs.created_at))
    .limit(MAX_RUNS);
  const worked = rows.filter((row) => row.ok);
  const durations = worked.map((row) => row.duration_ms).sort((a, b) => a - b);
  const byStrategy: Partial<Record<Strategy, number>> = {};
  for (const row of worked) byStrategy[row.strategy_used] = (byStrategy[row.strategy_used] ?? 0) + 1;
  return {
    total: rows.length,
    ok: worked.length,
    failed: rows.length - worked.length,
    healed: rows.filter((row) => row.healed).length,
    success_rate: rows.length > 0 ? worked.length / rows.length : null,
    p50_ms: percentile(durations, 50),
    p95_ms: percentile(durations, 95),
    by_strategy: byStrategy,
  };
}

/** The nearest-rank percentile of sorted values. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? null;
}

/** How many jobs a tool's history reads, newest first. */
const MAX_JOBS = 500;

/** A tool's builds and heals, newest first: builds that published it, and heals of it. */
export async function toolJobs(db: Queryable, name: string): Promise<JobRow[]> {
  const { jobs } = tablesOf(db);
  // The tool's name is inside each job's JSON, which the two databases query differently.
  const rows = await db
    .select()
    .from(jobs)
    .where(inArray(jobs.kind, ['build', 'heal']))
    .orderBy(desc(jobs.created_at))
    .limit(MAX_JOBS * 4);
  return rows
    .filter((job) =>
      job.kind === 'heal'
        ? (job.input as { tool?: unknown } | null)?.tool === name
        : (job.result as { tool?: unknown } | null)?.tool === name,
    )
    .slice(0, MAX_JOBS);
}

/** Model use per job, for many jobs at once. Jobs without calls are left out. */
export async function usageByJob(db: Queryable, jobIds: string[]): Promise<Map<string, JobUsage>> {
  const { llm_calls } = tablesOf(db);
  const usage = new Map<string, JobUsage>();
  // In chunks, well under either database's limit on query parameters.
  for (let start = 0; start < jobIds.length; start += 500) {
    const rows = await db
      .select({
        job_id: llm_calls.job_id,
        calls: sql`count(*)`.mapWith(Number),
        retries: sql`coalesce(sum(case when ${llm_calls.attempt} > 1 then 1 else 0 end), 0)`.mapWith(Number),
        prompt_tokens: sql`coalesce(sum(${llm_calls.prompt_tokens}), 0)`.mapWith(Number),
        completion_tokens: sql`coalesce(sum(${llm_calls.completion_tokens}), 0)`.mapWith(Number),
        duration_ms: sql`coalesce(sum(${llm_calls.duration_ms}), 0)`.mapWith(Number),
      })
      .from(llm_calls)
      .where(inArray(llm_calls.job_id, jobIds.slice(start, start + 500)))
      .groupBy(llm_calls.job_id);
    for (const { job_id: id, ...totals } of rows) usage.set(id, totals);
  }
  return usage;
}
