import { z } from 'zod';
import { identifierSchema } from '../common.ts';
import { rankedSelectorSchema } from './selectors.ts';

// The step ops a recipe can use. Strings may hold {{...}} template references
// (see templates.ts); which references are valid where is checked on the whole
// recipe (see schema.ts).
//
// Steps that produce data are `map`, `extract_table` and `extract_text`. The
// recipe's result is what its last producing step returns, and `save` also
// stores a step's value in {{vars.<name>}} for later steps.

const jsonPath = z.string().regex(/^\$/, 'must be a JSONPath starting with "$"');
const savedValues = z.record(identifierSchema, jsonPath);

export const httpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export const paginateSchema = z
  .strictObject({
    /** The loop variable, read as {{loop.<var>}}. */
    var: identifierSchema,
    /** Condition on each response that ends the loop, e.g. "$.hasMore == false". */
    until: z.string().min(1),
    /** Page-number mode: the first value. */
    start: z.number().int().optional(),
    /** Page-number mode: the increment (default 1). */
    step: z.number().int().positive().optional(),
    /** Cursor mode: where in each response the next value is. */
    from: jsonPath.optional(),
    /** Safety cap on requests (default 50). */
    max_pages: z.number().int().positive().max(1000).optional(),
  })
  .refine((p) => (p.start === undefined) !== (p.from === undefined), {
    message: 'set exactly one of "start" (page numbers) or "from" (cursor)',
  });

export const httpOpSchema = z.strictObject({
  op: z.literal('http'),
  method: httpMethodSchema,
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
  query: z.record(z.string(), z.string()).optional(),
  body: z.json().optional(),
  body_format: z.enum(['json', 'form']).optional(),
  paginate: paginateSchema.optional(),
  /** Values to keep from the response, e.g. `{ "accountId": "$.account.id" }`. */
  save: savedValues.optional(),
});

export const mapOpSchema = z.strictObject({
  op: z.literal('map'),
  /** The items to map, e.g. "$.items[*]". Applied to every page of the previous http step. */
  path: jsonPath,
  fields: savedValues.refine((fields) => Object.keys(fields).length > 0, 'map needs at least one field'),
  save: identifierSchema.optional(),
});

export const gotoOpSchema = z.strictObject({ op: z.literal('goto'), url: z.string().min(1) });

export const clickOpSchema = z.strictObject({ op: z.literal('click'), target: rankedSelectorSchema });

export const fillOpSchema = z.strictObject({
  op: z.literal('fill'),
  target: rankedSelectorSchema,
  value: z.string(),
});

export const selectOpSchema = z.strictObject({
  op: z.literal('select'),
  target: rankedSelectorSchema,
  value: z.string(),
});

export const waitForOpSchema = z
  .strictObject({
    op: z.literal('wait_for'),
    target: rankedSelectorSchema.optional(),
    /** A URL, or a glob such as "**\/invoices*", to wait for after navigation. */
    url: z.string().min(1).optional(),
    timeout_ms: z.number().int().positive().max(120_000).optional(),
  })
  .refine((w) => w.target !== undefined || w.url !== undefined, 'wait_for needs a "target" or a "url"');

export const extractTableOpSchema = z.strictObject({
  op: z.literal('extract_table'),
  target: rankedSelectorSchema,
  /** Output field -> column header text, or 0-based column index. */
  columns: z
    .record(identifierSchema, z.union([z.string().min(1), z.number().int().nonnegative()]))
    .refine((columns) => Object.keys(columns).length > 0, 'extract_table needs at least one column'),
  save: identifierSchema.optional(),
});

export const extractTextOpSchema = z.strictObject({
  op: z.literal('extract_text'),
  target: rankedSelectorSchema,
  /** Every match instead of the first. */
  all: z.boolean().optional(),
  save: identifierSchema.optional(),
});
