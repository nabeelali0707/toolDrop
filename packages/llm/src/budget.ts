import { ToolDropError } from '@tooldrop/core';

// Prompt budgets (DECISIONS.md, D-006). Tokens are estimated at 3 characters
// each, which overestimates for JSON and code and needs no tokenizer. Ollama
// reports the real count, which is logged, so the ratio can be tuned.

export const DEFAULT_BUDGET_TOKENS = 6_000;
export const DEFAULT_NUM_CTX = 8_192;
const CHARS_PER_TOKEN = 3;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function fitsBudget(text: string, budget = DEFAULT_BUDGET_TOKENS): boolean {
  return estimateTokens(text) <= budget;
}

/** Throws when a prompt is over budget. Prompts are pruned by their builders, never cut here. */
export function checkBudget(purpose: string, text: string, budget = DEFAULT_BUDGET_TOKENS): void {
  const tokens = estimateTokens(text);
  if (tokens > budget) {
    throw new ToolDropError(
      'llm_prompt_too_large',
      `the ${purpose} prompt needs about ${tokens} tokens, over the budget of ${budget}`,
      { details: { purpose, tokens, budget } },
    );
  }
}

/**
 * Picks the most detailed version of a prompt that fits: `build(level)` for
 * level 0, 1, 2... prunes harder each time, and returns undefined when it
 * cannot prune any further.
 */
export function fitPrompt(
  purpose: string,
  build: (level: number) => string | undefined,
  budget = DEFAULT_BUDGET_TOKENS,
): string {
  let last: string | undefined;
  for (let level = 0; ; level++) {
    const text = build(level);
    if (text === undefined) break;
    if (fitsBudget(text, budget)) return text;
    last = text;
  }
  checkBudget(purpose, last ?? '', budget);
  return last ?? '';
}
