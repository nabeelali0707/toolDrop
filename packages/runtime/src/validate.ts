import type { JsonSchema } from '@tooldrop/core';
import { Ajv, type ValidateFunction } from 'ajv';
import ajvFormats from 'ajv-formats';

// ajv-formats is CommonJS; through Node's ESM interop its plugin is `.default`.
const addFormats = ajvFormats.default;

export type Validation = { ok: true } | { ok: false; errors: string[] };

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
  readonly #compiled = new WeakMap<object, ValidateFunction>();

  constructor() {
    addFormats(this.#inputs);
    addFormats(this.#outputs);
  }

  input(schema: JsonSchema, value: unknown): Validation {
    return this.#check(this.#inputs, schema, value);
  }

  output(schema: JsonSchema, value: unknown): Validation {
    return this.#check(this.#outputs, schema, value);
  }

  #check(ajv: Ajv, schema: JsonSchema, value: unknown): Validation {
    let validate = this.#compiled.get(schema);
    if (!validate) {
      validate = ajv.compile(schema);
      this.#compiled.set(schema, validate);
    }
    if (validate(value)) return { ok: true };
    const errors = (validate.errors ?? []).map(
      (error) => `${error.instancePath || '(root)'} ${error.message ?? ''}`,
    );
    return { ok: false, errors };
  }
}
