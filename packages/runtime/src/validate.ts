import type { JsonSchema } from '@tooldrop/core';
import { Ajv, type ValidateFunction } from 'ajv';
import ajvFormats from 'ajv-formats';

// ajv-formats is CommonJS; through Node's ESM interop its plugin is `.default`.
const addFormats = ajvFormats.default;

export type Validation = { ok: true } | { ok: false; errors: string[] };

interface Compiled {
  schema: JsonSchema;
  validate: ValidateFunction;
}

/** Compiled schemas kept per direction: more than the published tools and workflows of one install. */
const SCHEMAS_KEPT = 500;

/**
 * Validates tool inputs and outputs against their JSON Schemas. Inputs get
 * the schema's defaults filled in. Outputs are coerced to the declared types,
 * because strategies that read pages produce text: "844.64" in a table cell
 * becomes the number 844.64, so every strategy returns the same shape. Text
 * that does not convert still fails.
 */
export class SchemaValidator {
  readonly #inputs = new Ajv({ allErrors: true, strict: false, useDefaults: true });
  readonly #outputs = new Ajv({ allErrors: true, strict: false, coerceTypes: true });
  readonly #inputCache = new Map<string, Compiled>();
  readonly #outputCache = new Map<string, Compiled>();

  constructor() {
    addFormats(this.#inputs);
    addFormats(this.#outputs);
  }

  input(schema: JsonSchema, value: unknown): Validation {
    return this.#check(this.#inputs, this.#inputCache, schema, value);
  }

  output(schema: JsonSchema, value: unknown): Validation {
    return this.#check(this.#outputs, this.#outputCache, schema, value);
  }

  #check(ajv: Ajv, cache: Map<string, Compiled>, schema: JsonSchema, value: unknown): Validation {
    // By content, not by object: the engine reads a tool from the database on every call, so its
    // schemas are new objects each time, and compiling them again costs about 2 ms and is never freed.
    const key = JSON.stringify(schema);
    let entry = cache.get(key);
    if (!entry) {
      if (cache.size >= SCHEMAS_KEPT) {
        // The oldest goes, and Ajv's own cache lets go of it too (a Map keeps insertion order).
        const [oldestKey, oldest] = cache.entries().next().value as [string, Compiled];
        cache.delete(oldestKey);
        ajv.removeSchema(oldest.schema);
      }
      entry = { schema, validate: ajv.compile(schema) };
      cache.set(key, entry);
    }
    const { validate } = entry;
    if (validate(value)) return { ok: true };
    const errors = (validate.errors ?? []).map(
      (error) => `${error.instancePath || '(root)'} ${error.message ?? ''}`,
    );
    return { ok: false, errors };
  }
}
