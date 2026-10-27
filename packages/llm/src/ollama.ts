import { ToolDropError } from '@tooldrop/core';
import { Ollama } from 'ollama';
import type { ChatReply, ChatRequest, LlmProvider } from './provider.ts';

// The default provider: Ollama through its official client (DECISIONS.md, D-003).

export interface OllamaProviderOptions {
  /** How long one call may take (default 10 minutes; CPU-only machines are slow). */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class OllamaProvider implements LlmProvider {
  readonly name = 'ollama' as const;
  readonly endpoint: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(endpoint: string, options: OllamaProviderOptions = {}) {
    this.endpoint = endpoint.replace(/\/+$/, '');
    this.#timeoutMs = options.timeoutMs ?? 600_000;
    this.#fetch = options.fetch ?? fetch;
  }

  async chat(request: ChatRequest): Promise<ChatReply> {
    const timeout = this.#timeoutMs;
    const doFetch = this.#fetch;
    // The client takes no signal for single replies, so the timeout rides on its fetch.
    const client = new Ollama({
      host: this.endpoint,
      fetch: (input, init) => doFetch(input, { ...init, signal: AbortSignal.timeout(timeout) }),
    });
    const started = performance.now();
    try {
      const response = await client.chat({
        model: request.model,
        messages: request.messages,
        stream: false,
        keep_alive: request.options.keep_alive,
        options: {
          num_ctx: request.options.num_ctx,
          num_predict: request.options.num_predict,
          temperature: request.options.temperature,
          seed: request.options.seed,
        },
        ...(request.format && { format: request.format }),
      });
      return {
        content: response.message.content,
        prompt_tokens: response.prompt_eval_count ?? 0,
        completion_tokens: response.eval_count ?? 0,
        duration_ms: Math.round(performance.now() - started),
        truncated: response.done_reason === 'length',
      };
    } catch (error) {
      throw this.#unavailable(error, request.model);
    }
  }

  async ping(models: string[]): Promise<void> {
    let installed: Set<string>;
    try {
      const response = await this.#fetch(`${this.endpoint}/api/tags`, { signal: AbortSignal.timeout(3_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { models?: { name: string }[] };
      installed = new Set((body.models ?? []).map((model) => model.name));
    } catch (error) {
      throw this.#unavailable(error, models[0] ?? '');
    }
    const missing = models.filter((model) => !installed.has(model) && !installed.has(`${model}:latest`));
    if (missing.length > 0) {
      throw new ToolDropError(
        'llm_unavailable',
        `Ollama does not have ${missing.join(' or ')}; download with ${missing.map((m) => `\`ollama pull ${m}\``).join(' and ')}`,
      );
    }
  }

  #unavailable(error: unknown, model: string): ToolDropError {
    const status = (error as { status_code?: unknown }).status_code;
    const message = error instanceof Error ? error.message : String(error);
    if (status === 404 && /not found/i.test(message)) {
      return new ToolDropError(
        'llm_unavailable',
        `Ollama does not have ${model}; download it with \`ollama pull ${model}\``,
        { cause: error },
      );
    }
    if (typeof status === 'number') {
      return new ToolDropError('llm_unavailable', `Ollama answered ${status}: ${message}`, { cause: error });
    }
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      return new ToolDropError(
        'llm_unavailable',
        `Ollama did not reply within ${Math.round(this.#timeoutMs / 1000)} s`,
        { cause: error },
      );
    }
    return new ToolDropError(
      'llm_unavailable',
      `cannot reach Ollama at ${this.endpoint}; is it running? Install it from https://ollama.com/download`,
      { cause: error },
    );
  }
}
