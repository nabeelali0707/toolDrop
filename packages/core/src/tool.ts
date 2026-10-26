import { z } from 'zod';
import { authoritySchema, jsonSchemaSchema } from './common.ts';
import { recipeSchema } from './recipe/schema.ts';

/** The MCP server's own tools (SPEC, Management MCP tools); published tools cannot take these names. */
export const MANAGEMENT_TOOL_NAMES = [
  'find_tool',
  'build_tool',
  'get_job',
  'answer_question',
  'run_tool',
  'approve_action',
  'create_watch',
  'delete_watch',
  'list_logins',
  'add_login',
] as const;

export const toolNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/, 'tool names are lowercase snake_case, at most 64 characters')
  .refine(
    (name) => !(MANAGEMENT_TOOL_NAMES as readonly string[]).includes(name),
    'this name belongs to a toolDrop management tool',
  );

export const TOOL_STATUSES = ['live', 'degraded', 'disabled'] as const;
export const toolStatusSchema = z.enum(TOOL_STATUSES);
export type ToolStatus = z.infer<typeof toolStatusSchema>;

/** Who created a recipe version. */
export const RECIPE_ORIGINS = ['build', 'heal', 'user'] as const;
export const recipeOriginSchema = z.enum(RECIPE_ORIGINS);
export type RecipeOrigin = z.infer<typeof recipeOriginSchema>;

/** What callers see of a tool: MCP lists it, REST runs it. */
export const toolDefinitionSchema = z.strictObject({
  name: toolNameSchema,
  description: z.string().min(1).max(2000),
  authority: authoritySchema,
  // MCP tools take named arguments, so inputs are always an object.
  input_schema: jsonSchemaSchema.refine(
    (schema) => schema.type === 'object',
    'input_schema must have type "object"',
  ),
  output_schema: jsonSchemaSchema,
});
export type ToolDefinition = z.infer<typeof toolDefinitionSchema>;

/**
 * A tool and its recipe in one JSON file, without a site: the format for
 * hand-written tools such as `fixtures/recipes/*.json`. The site is chosen
 * when the tool is registered.
 */
export const toolFileSchema = toolDefinitionSchema.extend({ recipe: recipeSchema });
export type ToolFile = z.infer<typeof toolFileSchema>;
