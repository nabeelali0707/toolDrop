import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  recipeManifestSchema,
  recipeSchemasSchema,
  toolFileSchema,
  ToolDropError,
  type ToolFile,
} from '@tooldrop/core';

/** Reads and validates a tool file (a tool definition plus its recipe), with every problem listed. */
export function readToolFile(path: string): ToolFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ToolDropError('invalid_input', `${path} is not readable JSON: ${(error as Error).message}`);
  }
  const parsed = toolFileSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new ToolDropError('invalid_input', `${path} is not a valid tool file: ${problems.join('; ')}`, {
      details: { problems },
    });
  }
  return parsed.data;
}

/**
 * Reads a community library recipe folder (recipes/<host>/<tool>/, DECISIONS.md
 * D-028) as a tool file, with the site its manifest names.
 */
export function readLibraryRecipe(folder: string): { file: ToolFile; site: string } {
  const read = (name: string): unknown => {
    try {
      return JSON.parse(readFileSync(join(folder, name), 'utf8'));
    } catch (error) {
      throw new ToolDropError('invalid_input', `${join(folder, name)}: ${(error as Error).message}`);
    }
  };
  const manifest = recipeManifestSchema.safeParse(read('manifest.json'));
  const schemas = recipeSchemasSchema.safeParse(read('schema.json'));
  if (!manifest.success || !schemas.success) {
    throw new ToolDropError(
      'invalid_input',
      `${folder} is not a valid library recipe; run \`pnpm check:recipes\``,
    );
  }
  const file = toolFileSchema.safeParse({
    name: manifest.data.name,
    description: manifest.data.description,
    authority: manifest.data.authority,
    input_schema: schemas.data.input,
    output_schema: schemas.data.output,
    recipe: read('recipe.json'),
  });
  if (!file.success) {
    throw new ToolDropError(
      'invalid_input',
      `${folder}: ${file.error.issues.map((issue) => issue.message).join('; ')}`,
    );
  }
  return { file: file.data, site: manifest.data.site };
}
