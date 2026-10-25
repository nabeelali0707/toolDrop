import { z } from 'zod';

/** Which default model a call uses (SPEC, Local LLM usage). */
export const LLM_ROLES = ['code', 'reasoning'] as const;
export const llmRoleSchema = z.enum(LLM_ROLES);
export type LlmRole = z.infer<typeof llmRoleSchema>;

export const LLM_PROVIDERS = ['ollama', 'openai_compatible'] as const;
export const llmProviderSchema = z.enum(LLM_PROVIDERS);
export type LlmProvider = z.infer<typeof llmProviderSchema>;
