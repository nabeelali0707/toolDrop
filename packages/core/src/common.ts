import { z } from 'zod';

export const idSchema = z.ulid();

/** How a recipe runs, cheapest first (SPEC, Build pipeline step 6). */
export const STRATEGIES = ['official_api', 'http_replay', 'html_fetch', 'browser_script'] as const;
export const strategySchema = z.enum(STRATEGIES);
export type Strategy = z.infer<typeof strategySchema>;

/** What a tool may do. Write tools need approval to build and, in safe mode, to run. */
export const authoritySchema = z.enum(['read', 'write']);
export type Authority = z.infer<typeof authoritySchema>;

/** A JSON Schema document, such as a tool's input or output schema. */
export type JsonSchema = Record<string, unknown>;
export const jsonSchemaSchema = z.record(z.string(), z.unknown());

/** Names of template variables, output fields and saved values. */
export const identifierSchema = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    'must be an identifier: letters, digits and _, not starting with a digit',
  );
