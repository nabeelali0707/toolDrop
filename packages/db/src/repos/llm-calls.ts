import { newId, type LlmProvider, type LlmRole } from '@tooldrop/core';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { Queryable } from '../client.ts';
import { llm_calls } from '../schema.ts';

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

export function recordLlmCall(db: Queryable, call: LlmCallInput): void {
  db.insert(llm_calls)
    .values({ id: newId(), ...call, error_code: call.error_code ?? null })
    .run();
}

export interface JobUsage {
  calls: number;
  /** Calls that repeated a request after its reply failed validation. */
  retries: number;
  prompt_tokens: number;
  completion_tokens: number;
  duration_ms: number;
}

export function jobUsage(db: Queryable, jobId: string): JobUsage {
  const totals = db
    .select({
      calls: sql<number>`count(*)`,
      prompt_tokens: sql<number>`coalesce(sum(${llm_calls.prompt_tokens}), 0)`,
      completion_tokens: sql<number>`coalesce(sum(${llm_calls.completion_tokens}), 0)`,
      duration_ms: sql<number>`coalesce(sum(${llm_calls.duration_ms}), 0)`,
    })
    .from(llm_calls)
    .where(eq(llm_calls.job_id, jobId))
    .get();
  const retries = db
    .select({ count: sql<number>`count(*)` })
    .from(llm_calls)
    .where(and(eq(llm_calls.job_id, jobId), gt(llm_calls.attempt, 1)))
    .get();
  return {
    calls: totals?.calls ?? 0,
    retries: retries?.count ?? 0,
    prompt_tokens: totals?.prompt_tokens ?? 0,
    completion_tokens: totals?.completion_tokens ?? 0,
    duration_ms: totals?.duration_ms ?? 0,
  };
}

export function listLlmCalls(db: Queryable, jobId: string) {
  return db.select().from(llm_calls).where(eq(llm_calls.job_id, jobId)).orderBy(llm_calls.created_at).all();
}
