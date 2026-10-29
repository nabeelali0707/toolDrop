import { llmProviderSchema } from '@tooldrop/core';
import { z } from 'zod';
import { Llm, type LlmOptions } from './llm.ts';
import { OllamaProvider } from './ollama.ts';
import { OpenAiCompatibleProvider, type ApiKey } from './openai-compatible.ts';
import type { LlmProvider } from './provider.ts';

// The model settings in config.json, written by `tooldrop init`.

export const DEFAULT_MODELS = { code: 'qwen2.5-coder:7b', reasoning: 'llama3.1:8b' } as const;

export const llmSettingsSchema = z.object({
  provider: llmProviderSchema,
  base_url: z.url(),
  models: z.object({ code: z.string().min(1), reasoning: z.string().min(1) }),
  /** Redact PII for local endpoints too; always on for external ones. */
  redact_pii: z.boolean().optional(),
  num_ctx: z.number().int().positive().optional(),
  budget_tokens: z.number().int().positive().optional(),
  seed: z.number().int().optional(),
  timeout_ms: z.number().int().positive().optional(),
});
export type LlmSettings = z.infer<typeof llmSettingsSchema>;

/** Ollama's address from OLLAMA_HOST (which may omit the scheme or port), or the default. */
export function ollamaUrl(host = process.env.OLLAMA_HOST): string {
  if (!host) return 'http://127.0.0.1:11434';
  const withScheme = /^https?:\/\//.test(host) ? host : `http://${host}`;
  const url = new URL(withScheme);
  if (!url.port) url.port = '11434';
  if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1';
  return url.origin;
}

/** Local Ollama with the default models: what toolDrop uses before `init` runs. */
/**
 * Local Ollama with the default models, or the ones named in
 * TOOLDROP_CODE_MODEL and TOOLDROP_REASONING_MODEL: the variables the Compose
 * stack downloads models by, so the app uses what was downloaded.
 */
export function defaultSettings(env: NodeJS.ProcessEnv = process.env): LlmSettings {
  return {
    provider: 'ollama',
    base_url: ollamaUrl(),
    models: {
      code: env.TOOLDROP_CODE_MODEL || DEFAULT_MODELS.code,
      reasoning: env.TOOLDROP_REASONING_MODEL || DEFAULT_MODELS.reasoning,
    },
  };
}

export function createProvider(settings: LlmSettings, options: { apiKey?: ApiKey } = {}): LlmProvider {
  const timeout = settings.timeout_ms !== undefined ? { timeoutMs: settings.timeout_ms } : {};
  return settings.provider === 'ollama'
    ? new OllamaProvider(settings.base_url, timeout)
    : new OpenAiCompatibleProvider(settings.base_url, {
        ...timeout,
        ...(options.apiKey !== undefined && { apiKey: options.apiKey }),
      });
}

/** What an Llm needs from the settings; the caller decides where its usage records go. */
export type ModelSetup = Omit<LlmOptions, 'onCall'>;

export function modelSetup(settings: LlmSettings, options: { apiKey?: ApiKey } = {}): ModelSetup {
  return {
    provider: createProvider(settings, options),
    models: settings.models,
    ...(settings.num_ctx !== undefined && { numCtx: settings.num_ctx }),
    ...(settings.budget_tokens !== undefined && { budgetTokens: settings.budget_tokens }),
    ...(settings.seed !== undefined && { seed: settings.seed }),
    ...(settings.redact_pii !== undefined && { redactPii: settings.redact_pii }),
  };
}

export function createLlm(
  settings: LlmSettings,
  options: { apiKey?: ApiKey; onCall?: LlmOptions['onCall'] } = {},
): Llm {
  return new Llm({ ...modelSetup(settings, options), ...(options.onCall && { onCall: options.onCall }) });
}
