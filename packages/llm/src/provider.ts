import type { JsonSchema, LlmProvider as LlmProviderName } from '@tooldrop/core';

// The one interface every model call goes through (SPEC, Local LLM usage).
// Adapters only move messages; validation, retries, masking and usage
// logging live in `Llm`, so every provider gets them.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  /** JSON Schema the reply must follow; providers that can constrain decoding use it. */
  format?: JsonSchema;
  /** What the call is for, e.g. "write_recipe". Never sent to the model; the fake provider keys replies on it. */
  purpose: string;
  options: {
    /** Context window. Ollama truncates prompts that do not fit, so it is always set (DECISIONS.md, D-006). */
    num_ctx: number;
    /** Most tokens the reply may use. */
    num_predict: number;
    temperature: number;
    seed: number;
    /** How long Ollama keeps the model loaded after the call (DECISIONS.md, D-003). */
    keep_alive: string;
  };
}

export interface ChatReply {
  content: string;
  prompt_tokens: number;
  completion_tokens: number;
  duration_ms: number;
  /** The reply stopped at `num_predict`, so it is probably cut off. */
  truncated: boolean;
}

export interface LlmProvider {
  readonly name: LlmProviderName;
  /** Where calls go, for the local or external check (DECISIONS.md, D-011). */
  readonly endpoint: string;
  chat(request: ChatRequest): Promise<ChatReply>;
  /**
   * Checks that the provider answers and has these models, so a build fails
   * in a second instead of after its capture. Throws `llm_unavailable`.
   */
  ping?(models: string[]): Promise<void>;
}
