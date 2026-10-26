import { ToolDropError } from '@tooldrop/core';
import type { ChatReply, ChatRequest, LlmProvider } from './provider.ts';

// Any `/v1/chat/completions` server: llama.cpp, vLLM, LM Studio, LocalAI or a
// hosted API. Optional, and nothing may require it (SPEC, Providers). Plain
// fetch, no SDK (DECISIONS.md, D-003).

export interface OpenAiCompatibleOptions {
  /** Kept in memory only; the vault stores it from Phase 3 (task 3.12). */
  apiKey?: string;
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
    if (this.#options.apiKey) headers.authorization = `Bearer ${this.#options.apiKey}`;
    try {
      return await (this.#options.fetch ?? fetch)(`${this.endpoint}/chat/completions`, {
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
        signal: AbortSignal.timeout(this.#options.timeoutMs ?? 600_000),
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

  #failed(detail: string): ToolDropError {
    return new ToolDropError('llm_unavailable', `${this.endpoint} answered ${detail}`);
  }
}
