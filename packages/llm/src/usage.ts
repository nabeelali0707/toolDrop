import type { LlmProvider as LlmProviderName, LlmRole } from '@tooldrop/core';

// Token and duration logging instead of cost (SPEC, Usage logging;
// DECISIONS.md, D-013). `Llm` reports every call; the engine writes the
// records to the `llm_calls` table.

export interface LlmCallRecord {
  job_id?: string;
  purpose: string;
  provider: LlmProviderName;
  model: string;
  role: LlmRole;
  prompt_tokens: number;
  completion_tokens: number;
  duration_ms: number;
  /** 1 for the first call; each retry after a failed validation adds one. */
  attempt: number;
  /** Whether the reply passed its schema. */
  ok: boolean;
  error_code?: string;
}

export interface UsageTotals {
  calls: number;
  /** Calls after the first for the same request: replies that failed their schema. */
  retries: number;
  prompt_tokens: number;
  completion_tokens: number;
  duration_ms: number;
}

export function usageTotals(records: readonly LlmCallRecord[]): UsageTotals {
  return {
    calls: records.length,
    retries: records.filter((record) => record.attempt > 1).length,
    prompt_tokens: sum(records, 'prompt_tokens'),
    completion_tokens: sum(records, 'completion_tokens'),
    duration_ms: sum(records, 'duration_ms'),
  };
}

function sum(records: readonly LlmCallRecord[], key: 'prompt_tokens' | 'completion_tokens' | 'duration_ms') {
  return records.reduce((total, record) => total + record[key], 0);
}
