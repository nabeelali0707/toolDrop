import { ToolDropError } from '@tooldrop/core';
import { patientFetch } from './http.ts';
import { DEFAULT_TIMEOUT_MS } from './ollama.ts';
import type { ChatReply, ChatRequest, LlmProvider } from './provider.ts';

// Any `/v1/chat/completions` server: llama.cpp, vLLM, LM Studio, LocalAI or a
// hosted API. Optional, and nothing may require it (SPEC, Providers). Plain
// fetch, no SDK (DECISIONS.md, D-003).

/** An API key, or a function that reads it from the vault the first time a call needs it. */
export type ApiKey = string | (() => Promise<string | undefined>);

export interface OpenAiCompatibleOptions {
  /** Sealed in the vault on disk (task 3.12); only ever in memory once read. */
  apiKey?: ApiKey;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * How the reply format is requested. Servers differ: the best is a JSON
 * schema, then plain JSON mode, then nothing (the prompt and the validation
 * still ask for JSON). A 400 that names the format moves down one level.
 */
type FormatMode = 'json_schema' | 'json_object' | 'none';

interface CompletionResponse {
  choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name = 'openai_compatible' as const;
  readonly endpoint: string;
  readonly #options: OpenAiCompatibleOptions;
  #mode: FormatMode = 'json_schema';
  #key: Promise<string | undefined> | undefined;

  /** `baseUrl` includes the version path, e.g. `http://127.0.0.1:8080/v1`. */
  constructor(baseUrl: string, options: OpenAiCompatibleOptions = {}) {
    this.endpoint = baseUrl.replace(/\/+$/, '');
    this.#options = options;
  }

  async chat(request: ChatRequest): Promise<ChatReply> {
    const started = performance.now();
    for (;;) {
      const response = await this.#post(request);
      if (response.status === 400 && this.#mode !== 'none' && request.format) {
        const text = await response.text();
        if (/response_format|json_schema|json_object/i.test(text)) {
          this.#mode = this.#mode === 'json_schema' ? 'json_object' : 'none';
          continue;
        }
        throw this.#failed(`${response.status}: ${text.slice(0, 300)}`);
      }
      if (!response.ok) throw this.#failed(`${response.status}: ${(await response.text()).slice(0, 300)}`);

      const body = (await response.json()) as CompletionResponse;
      const choice = body.choices?.[0];
      return {
        content: choice?.message?.content ?? '',
        prompt_tokens: body.usage?.prompt_tokens ?? 0,
        completion_tokens: body.usage?.completion_tokens ?? 0,
        duration_ms: Math.round(performance.now() - started),
        truncated: choice?.finish_reason === 'length',
      };
    }
  }

  async #post(request: ChatRequest): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const key = await this.#apiKey();
    if (key) headers.authorization = `Bearer ${key}`;
    try {
      return await (this.#options.fetch ?? patientFetch)(`${this.endpoint}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          temperature: request.options.temperature,
          seed: request.options.seed,
          max_tokens: request.options.num_predict,
          stream: false,
          ...this.#responseFormat(request),
        }),
        signal: AbortSignal.timeout(this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ToolDropError(
        'llm_unavailable',
        error instanceof Error && error.name === 'TimeoutError'
          ? `${this.endpoint} did not reply in time`
          : `cannot reach ${this.endpoint}`,
        { cause: error },
      );
    }
  }

  #responseFormat(request: ChatRequest): Record<string, unknown> {
    if (!request.format || this.#mode === 'none') return {};
    if (this.#mode === 'json_object') return { response_format: { type: 'json_object' } };
    return {
      response_format: {
        type: 'json_schema',
        json_schema: { name: request.purpose.replace(/[^A-Za-z0-9_-]/g, '_'), schema: request.format },
      },
    };
  }

  /** The key, read once: a function reads it from the vault on the first call that needs it. */
  #apiKey(): Promise<string | undefined> {
    const option = this.#options.apiKey;
    this.#key ??= typeof option === 'function' ? option() : Promise.resolve(option);
    return this.#key;
  }

  #failed(detail: string): ToolDropError {
    return new ToolDropError('llm_unavailable', `${this.endpoint} answered ${detail}`);
  }
}
