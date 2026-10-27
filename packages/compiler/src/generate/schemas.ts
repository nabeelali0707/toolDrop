import { MANAGEMENT_TOOL_NAMES, type JsonSchema } from '@tooldrop/core';
import { fitPrompt } from '@tooldrop/llm';
import { z } from 'zod';
import type { Capture } from '../capture/capture.ts';
import { describePrompt, DESCRIBE_SYSTEM, type TaskContext } from './prompts.ts';
import { promptBudget, type ModelAccess } from './recipe.ts';

// Input and output JSON Schemas (SPEC, Build pipeline step 8): types come from
// the captured values and from what the recipe returned; the reasoning model
// writes the tool's name and the descriptions an agent reads.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
/** Prices and amounts that a page shows as text, such as "765.45". */
const DECIMAL = /^-?\d+\.\d+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The narrowest JSON Schema type that fits every value. */
export function schemaFor(values: unknown[]): JsonSchema {
  const present = values.filter((value) => value !== null && value !== undefined);
  let schema: JsonSchema = {};
  if (present.length === 0) return schema;
  if (present.every((v) => typeof v === 'boolean')) schema = { type: 'boolean' };
  else if (present.every((v) => typeof v === 'number')) {
    schema = { type: present.every((v) => Number.isInteger(v)) ? 'integer' : 'number' };
  } else if (present.every((v) => typeof v === 'string' && DECIMAL.test(v))) schema = { type: 'number' };
  else if (present.every((v) => typeof v === 'string' && ISO_DATE.test(v)))
    schema = { type: 'string', format: 'date' };
  else if (present.every((v) => typeof v === 'string' && ISO_DATE_TIME.test(v))) {
    schema = { type: 'string', format: 'date-time' };
  } else if (present.every((v) => typeof v === 'string')) schema = { type: 'string' };
  else if (present.every((v) => Array.isArray(v))) schema = { type: 'array' };
  else if (present.every(isRecord)) schema = { type: 'object' };
  if (present.length < values.length && typeof schema.type === 'string')
    return { ...schema, type: [schema.type, 'null'] };
  return schema;
}

/**
 * The output schema, from what the recipe returned. Fields the browser
 * fallback also reads are required when they always had a value; the rest
 * are optional, since the fallback cannot return them.
 */
export function inferOutputSchema(result: unknown, fallbackFields: readonly string[]): JsonSchema {
  if (Array.isArray(result)) {
    const records = result.filter(isRecord);
    if (records.length === 0) return { type: 'array', items: schemaFor(result) };
    return { type: 'array', items: objectSchema(records, fallbackFields) };
  }
  if (isRecord(result)) return objectSchema([result], fallbackFields);
  return schemaFor([result]);
}

function objectSchema(records: Record<string, unknown>[], fallbackFields: readonly string[]): JsonSchema {
  const fields = [...new Set(records.flatMap((record) => Object.keys(record)))];
  const required = fields.filter(
    (field) =>
      fallbackFields.includes(field) &&
      records.every(
        (record) => record[field] !== null && record[field] !== undefined && record[field] !== '',
      ),
  );
  return {
    type: 'object',
    properties: Object.fromEntries(
      fields.map((field) => [field, schemaFor(records.map((record) => record[field]))]),
    ),
    ...(required.length > 0 && { required }),
  };
}

/** The input schema, from the marked inputs: options become an enum, ISO dates a date format. */
export function inputSchema(capture: Capture): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const input of capture.inputs) {
    const action = capture.actions[input.action];
    const options =
      action?.kind === 'select' ? action.options.map((o) => o.value).filter((v) => v !== '') : [];
    properties[input.name] = {
      type: 'string',
      ...(options.length > 0 && { enum: options }),
      ...(ISO_DATE.test(input.example) && { format: 'date' }),
      ...(input.description && { description: input.description }),
    };
  }
  return { type: 'object', properties, additionalProperties: false };
}

export const descriptionSchema = z
  .strictObject({
    name: z
      .string()
      .regex(/^[a-z][a-z0-9_]{2,39}$/, 'lowercase snake_case, 3 to 40 characters, starting with a letter'),
    description: z.string().min(10).max(600),
    inputs: z
      .array(z.strictObject({ name: z.string(), description: z.string().max(300), required: z.boolean() }))
      .max(50),
    fields: z.array(z.strictObject({ name: z.string(), description: z.string().max(300) })).max(100),
  })
  .refine((reply) => !(MANAGEMENT_TOOL_NAMES as readonly string[]).includes(reply.name), {
    message: 'this name belongs to a toolDrop management tool; choose another',
    path: ['name'],
  });
export type Description = z.infer<typeof descriptionSchema>;

/** The reasoning model names the tool and describes its inputs and outputs. */
export async function describeTool(
  access: ModelAccess,
  context: TaskContext,
  capture: Capture,
  result: unknown,
): Promise<Description> {
  const records = Array.isArray(result) ? result.filter(isRecord) : isRecord(result) ? [result] : [];
  const names = [...new Set(records.flatMap((record) => Object.keys(record)))];
  const fields = names.map((name) => ({ name, samples: records.slice(0, 2).map((record) => record[name]) }));
  const prompt = fitPrompt(
    'describe_tool',
    (level) => describePrompt(context, capture, fields, level),
    promptBudget(access, DESCRIBE_SYSTEM),
  );
  return access.llm.generateJson({
    role: 'reasoning',
    purpose: 'describe_tool',
    schema: descriptionSchema,
    system: DESCRIBE_SYSTEM,
    prompt,
    ...(access.jobId !== undefined && { job_id: access.jobId }),
    ...(access.masker && { masker: access.masker }),
  });
}

/** Adds the model's descriptions to the schemas, for the fields that exist. */
export function describeSchemas(
  input: JsonSchema,
  output: JsonSchema,
  description: Description,
): { input: JsonSchema; output: JsonSchema } {
  const inputProperties = { ...(input.properties as Record<string, JsonSchema>) };
  const required: string[] = [];
  for (const entry of description.inputs) {
    const property = inputProperties[entry.name];
    if (!property) continue;
    inputProperties[entry.name] = { ...property, description: entry.description };
    if (entry.required) required.push(entry.name);
  }
  const items = (output.type === 'array' ? output.items : output) as JsonSchema | undefined;
  let described = output;
  if (items?.type === 'object' && items.properties) {
    const properties = { ...(items.properties as Record<string, JsonSchema>) };
    for (const field of description.fields) {
      const property = properties[field.name];
      if (property) properties[field.name] = { ...property, description: field.description };
    }
    const newItems = { ...items, properties };
    described = output.type === 'array' ? { ...output, items: newItems } : newItems;
  }
  return {
    input: { ...input, properties: inputProperties, ...(required.length > 0 && { required }) },
    output: described,
  };
}

/** The model's name, made unique among the published tools. */
export function uniqueToolName(name: string, taken: (name: string) => boolean): string {
  let candidate = name;
  for (let n = 2; taken(candidate); n++) candidate = `${name.slice(0, 60)}_${n}`;
  return candidate;
}
