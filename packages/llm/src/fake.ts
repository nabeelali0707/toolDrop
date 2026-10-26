import { readFileSync, writeFileSync } from 'node:fs';
import type { LlmProvider as LlmProviderName } from '@tooldrop/core';
import { estimateTokens } from './budget.ts';
import type { ChatReply, ChatRequest, LlmProvider } from './provider.ts';

// CI never calls a model (DECISIONS.md, D-019). Tests use FakeProvider, which
// replays replies by purpose, in order: recorded from real models with
// RecordingProvider and `pnpm test:llm`, or written by the test. Keying on the
// purpose rather than the prompt text keeps recorded replies valid when a
// prompt's wording changes.

/** A reply: raw text, a value sent as JSON, or a function of the request. */
export type FakeReply = string | ReplyValue | ((request: ChatRequest) => string | ReplyValue);
type ReplyValue = Record<string, unknown> | unknown[];

/** Replies saved from real model calls: `fixtures/llm-replies/*.json`. */
export interface RecordedReplies {
  /** The models that produced the replies, for the record. */
  models: string[];
  recorded_at: string;
  replies: Record<string, string[]>;
}

export class FakeProvider implements LlmProvider {
  readonly name: LlmProviderName;
  readonly endpoint: string;
  /** Every request, in order, for tests to inspect. */
  readonly requests: ChatRequest[] = [];
  readonly #replies: Map<string, FakeReply[]>;

  constructor(
    replies: Record<string, FakeReply[]>,
    options: { name?: LlmProviderName; endpoint?: string } = {},
  ) {
    this.#replies = new Map(Object.entries(replies).map(([purpose, list]) => [purpose, [...list]]));
    this.name = options.name ?? 'ollama';
    this.endpoint = options.endpoint ?? 'http://127.0.0.1:11434';
  }

  static fromFile(path: string, options?: { name?: LlmProviderName; endpoint?: string }): FakeProvider {
    const recorded = JSON.parse(readFileSync(path, 'utf8')) as RecordedReplies;
    return new FakeProvider(recorded.replies, options);
  }

  /** Replies not used yet, by purpose: a test can check that every scripted reply was consumed. */
  remaining(): Record<string, number> {
    return Object.fromEntries([...this.#replies].map(([purpose, list]) => [purpose, list.length]));
  }

  chat(request: ChatRequest): Promise<ChatReply> {
    this.requests.push(request);
    const next = this.#replies.get(request.purpose)?.shift();
    if (next === undefined) {
      return Promise.reject(new Error(`FakeProvider has no reply left for "${request.purpose}"`));
    }
    const value = typeof next === 'function' ? next(request) : next;
    const content = typeof value === 'string' ? value : JSON.stringify(value);
    return Promise.resolve({
      content,
      prompt_tokens: estimateTokens(request.messages.map((message) => message.content).join('')),
      completion_tokens: estimateTokens(content),
      duration_ms: 0,
      truncated: false,
    });
  }
}

/** Wraps a real provider and keeps its replies, to save as a fixture for FakeProvider. */
export class RecordingProvider implements LlmProvider {
  readonly name: LlmProviderName;
  readonly endpoint: string;
  readonly #inner: LlmProvider;
  readonly #replies: Record<string, string[]> = {};
  readonly #models = new Set<string>();

  constructor(inner: LlmProvider) {
    this.#inner = inner;
    this.name = inner.name;
    this.endpoint = inner.endpoint;
  }

  async chat(request: ChatRequest): Promise<ChatReply> {
    const reply = await this.#inner.chat(request);
    (this.#replies[request.purpose] ??= []).push(reply.content);
    this.#models.add(request.model);
    return reply;
  }

  recorded(): RecordedReplies {
    return { models: [...this.#models], recorded_at: new Date().toISOString(), replies: this.#replies };
  }

  save(path: string): void {
    writeFileSync(path, `${JSON.stringify(this.recorded(), null, 2)}\n`);
  }
}
