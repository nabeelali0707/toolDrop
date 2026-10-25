import { z } from 'zod';
import { jsonSchemaSchema } from './common.ts';
import { toolNameSchema } from './tool.ts';

// The community recipe library (`recipes/`, DECISIONS.md D-028): tools for
// public websites that anyone can install. Each recipe is a folder named
// `recipes/<site host>/<tool name>/` holding the files below.

export const LIBRARY_FILES = [
  'manifest.json',
  'recipe.json',
  'schema.json',
  'test-inputs.json',
  'README.md',
] as const;

export const recipeManifestSchema = z.strictObject({
  /** The tool name agents call; also the folder name. */
  name: toolNameSchema,
  title: z.string().min(1).max(80),
  /** What the tool does, written for the agent that will call it. */
  description: z.string().min(1).max(500),
  /** The site's origin. Recipes may only reach this origin. */
  site: z.url({ protocol: /^https$/ }),
  /** Community recipes only read public data. */
  authority: z.literal('read'),
  sign_in: z.literal('none'),
  /** GitHub usernames of the people who keep the recipe working. */
  maintainers: z
    .array(z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/, 'must be a GitHub username'))
    .min(1),
  tags: z
    .array(z.string().regex(/^[a-z0-9-]+$/))
    .max(10)
    .optional(),
  /** The contributor checked that the site's terms allow this automated access. */
  terms_reviewed: z.literal(true),
});
export type RecipeManifest = z.infer<typeof recipeManifestSchema>;

/** `schema.json`: the tool's input and output JSON Schemas. */
export const recipeSchemasSchema = z.strictObject({
  input: jsonSchemaSchema,
  output: jsonSchemaSchema,
});
export type RecipeSchemas = z.infer<typeof recipeSchemasSchema>;

/** `test-inputs.json`: 2 or more input sets, as the build pipeline validates with (SPEC, step 9). */
export const recipeTestInputsSchema = z.array(z.record(z.string(), z.unknown())).min(2).max(10);
