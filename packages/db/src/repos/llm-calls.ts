import { newId, type LlmProvider, type LlmRole } from '@tooldrop/core';
import { and, eq, gt, sql } from 'drizzle-orm';
import { first, tablesOf, type Queryable } from '../client.ts';

// One row per model call, and the totals a job shows (SPEC, Usage logging;
// DECISIONS.md, D-013). No cost is tracked.

export interface LlmCallInput {
  job_id: string;
  purpose: string;
  provider: LlmProvider;
  model: string;
  role: LlmRole;
  prompt_tokens: number;
  completion_tokens: number;
  duration_ms: number;
  attempt: number;
  ok: boolean;
  error_code?: string;
}

export async function recordLlmCall(db: Queryable, call: LlmCallInput): Promise<void> {
  const { llm_calls } = tablesOf(db);
  await db.insert(llm_calls).values({ id: newId(), ...call, error_code: call.error_code ?? null });
}

export interface JobUsage {
  calls: number;
  /** Calls that repeated a request after its reply failed validation. */
  retries: number;
  prompt_tokens: number;
  completion_tokens: number;
  duration_ms: number;
}

export async function jobUsage(db: Queryable, jobId: string): Promise<JobUsage> {
  const { llm_calls } = tablesOf(db);
  // Postgres returns counts and sums as bigint or numeric, which arrive as strings.
  const totals = first(
    await db
      .select({
        calls: sql`count(*)`.mapWith(Number),
        prompt_tokens: sql`coalesce(sum(${llm_calls.prompt_tokens}), 0)`.mapWith(Number),
        completion_tokens: sql`coalesce(sum(${llm_calls.completion_tokens}), 0)`.mapWith(Number),
        duration_ms: sql`coalesce(sum(${llm_calls.duration_ms}), 0)`.mapWith(Number),
      })
      .from(llm_calls)
      .where(eq(llm_calls.job_id, jobId)),
  );
  const retries = first(
    await db
      .select({ count: sql`count(*)`.mapWith(Number) })
      .from(llm_calls)
      .where(and(eq(llm_calls.job_id, jobId), gt(llm_calls.attempt, 1))),
  );
  return {
    calls: totals?.calls ?? 0,
    retries: retries?.count ?? 0,
    prompt_tokens: totals?.prompt_tokens ?? 0,
    completion_tokens: totals?.completion_tokens ?? 0,
    duration_ms: totals?.duration_ms ?? 0,
  };
}

export async function listLlmCalls(db: Queryable, jobId: string) {
  const { llm_calls } = tablesOf(db);
  const rows = await db
    .select()
    .from(llm_calls)
    .where(eq(llm_calls.job_id, jobId))
    .orderBy(llm_calls.created_at);
  return rows;
}
