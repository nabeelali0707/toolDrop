// Validation for the community recipe library (recipes/, DECISIONS.md D-028).
// `pnpm check:recipes` runs it in CI; gitleaks scans the same files for
// secrets on top of the checks here.
import {
  collectTemplateRefs,
  LIBRARY_FILES,
  recipeManifestSchema,
  recipeSchema,
  recipeSchemasSchema,
  recipeTestInputsSchema,
  toolDefinitionSchema,
  type Recipe,
  type RecipeManifest,
} from '@tooldrop/core';
import { Ajv, type ErrorObject } from 'ajv';
import ajvFormats from 'ajv-formats';
import type { z } from 'zod';

// ajv-formats is CommonJS; through Node's ESM interop its plugin is `.default`.
const addFormats = ajvFormats.default;

export interface RecipeFolder {
  /** Path inside recipes/, e.g. "hn.algolia.com/hn_front_page". */
  path: string;
  /** File name -> contents, for the files that exist. */
  files: Record<string, string>;
}

/** Headers and query parameters whose values must come from a template, never a literal. */
const SECRET_NAMES =
  /^(authorization|proxy-authorization|cookie|x-api-key|x-auth-token|api[-_]?key|access[-_]?token|token|secret|password)$/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE = /\+?\d[\d ()-]{8,}\d/;

/** Returns every problem found, so a contributor can fix them all at once. Empty means valid. */
export function validateRecipeFolder(folder: RecipeFolder, options: { template?: boolean } = {}): string[] {
  const missing = LIBRARY_FILES.filter((file) => folder.files[file] === undefined);
  if (missing.length > 0) return missing.map((file) => `missing ${file}`);

  const errors: string[] = [];
  const json = (file: string): unknown => {
    try {
      return JSON.parse(folder.files[file] ?? '');
    } catch (error) {
      errors.push(`${file}: not valid JSON (${(error as Error).message})`);
      return undefined;
    }
  };
  const parse = <T>(file: string, schema: z.ZodType<T>, value: unknown): T | undefined => {
    if (value === undefined) return undefined;
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    for (const issue of result.error.issues)
      errors.push(`${file}: ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    return undefined;
  };

  const manifest = parse('manifest.json', recipeManifestSchema, json('manifest.json'));
  const recipe = parse('recipe.json', recipeSchema, json('recipe.json'));
  const schemas = parse('schema.json', recipeSchemasSchema, json('schema.json'));
  const testInputs = parse('test-inputs.json', recipeTestInputsSchema, json('test-inputs.json'));

  if (!folder.files['README.md']?.trim()) errors.push('README.md: empty');

  if (manifest && !options.template) {
    const expected = `${new URL(manifest.site).host}/${manifest.name}`;
    if (folder.path !== expected)
      errors.push(`folder: must be recipes/${expected}, found recipes/${folder.path}`);
  }

  if (manifest && schemas) {
    const tool = toolDefinitionSchema.safeParse({
      name: manifest.name,
      description: manifest.description,
      authority: manifest.authority,
      input_schema: schemas.input,
      output_schema: schemas.output,
    });
    for (const issue of tool.error?.issues ?? [])
      errors.push(`schema.json: ${issue.path.join('.')}: ${issue.message}`);
  }

  if (schemas) errors.push(...checkJsonSchemas(schemas.input, schemas.output, testInputs));
  if (recipe && manifest) errors.push(...checkRecipeSafety(recipe, manifest, schemas?.input));
  errors.push(...checkPersonalData(folder.files['test-inputs.json'] ?? '', 'test-inputs.json'));
  errors.push(...checkPersonalData(folder.files['recipe.json'] ?? '', 'recipe.json'));
  return errors;
}

function checkJsonSchemas(
  input: unknown,
  output: unknown,
  testInputs: Record<string, unknown>[] | undefined,
) {
  const errors: string[] = [];
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  const compile = (name: string, schema: unknown) => {
    try {
      return ajv.compile(schema as object);
    } catch (error) {
      errors.push(`schema.json: ${name} is not a valid JSON Schema (${(error as Error).message})`);
      return undefined;
    }
  };
  const validateInput = compile('input', input);
  compile('output', output);
  testInputs?.forEach((testInput, index) => {
    if (validateInput && !validateInput(testInput)) {
      for (const error of validateInput.errors ?? [])
        errors.push(`test-inputs.json[${index}]: ${describe(error)}`);
    }
  });
  return errors;
}

function checkRecipeSafety(recipe: Recipe, manifest: RecipeManifest, inputSchema: unknown): string[] {
  const errors: string[] = [];
  const properties = (inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  const declared = Object.keys(properties ?? {});

  for (const ref of collectTemplateRefs(recipe).refs) {
    if (ref.root === 'session') {
      errors.push(`recipe.json: {{${ref.raw}}}: community recipes are for public sites and have no session`);
    }
    if (ref.root === 'input' && !declared.includes(ref.path[0] ?? '')) {
      errors.push(`recipe.json: {{${ref.raw}}} is not declared in schema.json input.properties`);
    }
  }

  recipe.steps.forEach((step, index) => {
    if (step.op === 'http' || step.op === 'goto') {
      if (!step.url.startsWith('{{site}}') && !step.url.startsWith(manifest.site)) {
        errors.push(
          `recipe.json: steps.${index}.url: may only reach ${manifest.site}; start it with {{site}}`,
        );
      }
    }
    if (step.op === 'http') {
      for (const [field, values] of [
        ['headers', step.headers],
        ['query', step.query],
      ] as const) {
        for (const [name, value] of Object.entries(values ?? {})) {
          if (SECRET_NAMES.test(name) && !/^\{\{[^{}]+\}\}$/.test(value.trim())) {
            errors.push(
              `recipe.json: steps.${index}.${field}.${name}: looks like a credential; never commit one`,
            );
          }
        }
      }
    }
  });
  return errors;
}

function checkPersonalData(text: string, file: string): string[] {
  const errors: string[] = [];
  if (EMAIL.test(text)) errors.push(`${file}: contains an email address; recipes must hold no personal data`);
  if (PHONE.test(text)) errors.push(`${file}: contains a phone number; recipes must hold no personal data`);
  return errors;
}

function describe(error: ErrorObject): string {
  return `${error.instancePath || '(root)'} ${error.message ?? 'is invalid'}`;
}
