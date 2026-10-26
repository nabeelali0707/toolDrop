import { ToolDropError, type LlmRole } from '@tooldrop/core';
import type { z } from 'zod';
import { checkBudget, DEFAULT_BUDGET_TOKENS, DEFAULT_NUM_CTX, estimateTokens, fitsBudget } from './budget.ts';
import { isExternal } from './endpoint.ts';
import { formatIssues, modelSchema, parseReply } from './json.ts';
import type { ChatMessage, ChatReply, LlmProvider } from './provider.ts';
import { Masker, redactPii } from './redact.ts';
import type { LlmCallRecord } from './usage.ts';

/** One call plus up to 3 retries with the validation errors: at most 4 calls (DECISIONS.md, D-005). */
export const MAX_RETRIES = 3;

export interface LlmOptions {
  provider: LlmProvider;
  /** The model for each role (SPEC, Default models). */
  models: Record<LlmRole, string>;
  numCtx?: number;
  budgetTokens?: number;
  /** Most tokens a reply may use (default 2,048, which fits next to a full prompt). */
  numPredict?: number;
  seed?: number;
  keepAlive?: string;
  /** Redact PII for local endpoints too. External endpoints always get it. */
  redactPii?: boolean;
  /** Receives every call, for the `llm_calls` table and job totals. */
  onCall?: (record: LlmCallRecord) => void;
}

export interface JsonCall<T> {
  role: LlmRole;
  /** What the call is for, e.g. "write_recipe": logged, and the key for recorded replies. */
  purpose: string;
  schema: z.ZodType<T>;
  system: string;
  prompt: string;
  job_id?: string;
  /** Secrets found so far in this job; masking runs on every prompt either way. */
  masker?: Masker;
}

/**
 * Every model call goes through here (SPEC, Local LLM usage): masking and
 * redaction, the prompt budget, constrained JSON, validation with retries,
 * and a usage record per call. Temperature 0 and a fixed seed keep replies
 * repeatable.
 */
export class Llm {
  readonly provider: LlmProvider;
  readonly models: Record<LlmRole, string>;
  readonly #options: LlmOptions;

  constructor(options: LlmOptions) {
    this.provider = options.provider;
    this.models = options.models;
    this.#options = options;
  }

  /** Whether calls for this role leave the machine (DECISIONS.md, D-011). */
  isExternal(role: LlmRole): boolean {
    return isExternal(this.provider.endpoint, this.models[role]);
  }

  async generateJson<T>(call: JsonCall<T>): Promise<T> {
    const model = this.models[call.role];
    const budget = this.#options.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
    const clean = this.#cleaner(call);
    const system = clean(call.system);
    const prompt = clean(call.prompt);
    checkBudget(call.purpose, system + prompt, budget);

    const format = modelSchema(call.schema);
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ];
    let problems: string[] = [];
    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
      const reply = await this.provider.chat({
        model,
        messages: [...messages],
        format,
        purpose: call.purpose,
        options: {
          num_ctx: this.#options.numCtx ?? DEFAULT_NUM_CTX,
          num_predict: this.#options.numPredict ?? 2_048,
          temperature: 0,
          seed: this.#options.seed ?? 42,
          keep_alive: this.#options.keepAlive ?? '30m',
        },
      });

      const checked = check(call.schema, reply);
      this.#record(call, model, attempt, reply, messages, checked.ok);
      if (checked.ok) return checked.value;

      problems = checked.problems;
      messages.splice(2, messages.length, ...retryMessages(reply.content, problems, system + prompt, budget));
    }
    throw new ToolDropError(
      'llm_invalid_output',
      `the model's ${call.purpose} reply did not match its schema after ${MAX_RETRIES + 1} tries: ${problems.slice(0, 3).join('; ')}`,
      { details: { purpose: call.purpose, model, problems } },
    );
  }

  #cleaner(call: JsonCall<unknown>): (text: string) => string {
    const masker = call.masker ?? new Masker();
    const redact = this.isExternal(call.role) || this.#options.redactPii === true;
    return (text) => (redact ? redactPii(masker.apply(text)) : masker.apply(text));
  }

  #record(
    call: JsonCall<unknown>,
    model: string,
    attempt: number,
    reply: ChatReply,
    messages: ChatMessage[],
    ok: boolean,
  ): void {
    this.#options.onCall?.({
      ...(call.job_id !== undefined && { job_id: call.job_id }),
      purpose: call.purpose,
      provider: this.provider.name,
      model,
      role: call.role,
      // Ollama leaves the count out when it reused a cached prompt; the estimate stands in.
      prompt_tokens: reply.prompt_tokens || estimateTokens(messages.map((m) => m.content).join('')),
      completion_tokens: reply.completion_tokens,
      duration_ms: reply.duration_ms,
      attempt,
      ok,
      ...(!ok && { error_code: 'llm_invalid_output' }),
    });
  }
}

type Checked<T> = { ok: true; value: T } | { ok: false; problems: string[] };

function check<T>(schema: z.ZodType<T>, reply: ChatReply): Checked<T> {
  const parsed = parseReply(reply.content);
  if (!parsed.ok) {
    const cut = reply.truncated ? ' The reply was cut off: keep it shorter.' : '';
    return { ok: false, problems: [`${parsed.error}.${cut}`] };
  }
  const result = schema.safeParse(parsed.value);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, problems: formatIssues(result.error.issues) };
}

/**
 * The messages that follow the original prompt on a retry: the bad reply and
 * what was wrong with it. When they do not fit the budget, the reply goes
 * first, then problems from the end of the list (D-005).
 */
function retryMessages(reply: string, problems: string[], original: string, budget: number): ChatMessage[] {
  const feedback = (count: number) =>
    [
      'Your reply did not match the required JSON format:',
      ...problems.slice(0, count).map((problem) => `- ${problem}`),
      ...(count < problems.length ? [`- ...and ${problems.length - count} more problems`] : []),
      'Reply again with the complete JSON object, corrected. Reply with JSON only.',
    ].join('\n');
  for (let count = problems.length; count >= 1; count--) {
    if (fitsBudget(original + reply + feedback(count), budget)) {
      return [
        { role: 'assistant', content: reply },
        { role: 'user', content: feedback(count) },
      ];
    }
    if (fitsBudget(original + feedback(count), budget)) return [{ role: 'user', content: feedback(count) }];
  }
  return [{ role: 'user', content: feedback(1) }];
}
