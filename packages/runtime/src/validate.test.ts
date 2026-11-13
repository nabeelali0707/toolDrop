import type { JsonSchema } from '@tooldrop/core';
import { Ajv } from 'ajv';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SchemaValidator } from './validate.ts';

const schema = (): JsonSchema => ({
  type: 'object',
  properties: { status: { type: 'string', enum: ['open', 'paid'] }, amount: { type: 'number' } },
  additionalProperties: false,
});

afterEach(() => vi.restoreAllMocks());

describe('SchemaValidator', () => {
  it('compiles a schema once, even when every call brings a new copy of it', () => {
    // The engine reads a tool from the database on each call, so its schemas are new objects each time.
    const compile = vi.spyOn(Ajv.prototype, 'compile');
    const validator = new SchemaValidator();
    for (let call = 0; call < 50; call++) {
      expect(validator.input(structuredClone(schema()), { status: 'paid' })).toEqual({ ok: true });
      expect(validator.output(structuredClone(schema()), { amount: 1 })).toEqual({ ok: true });
    }
    expect(compile).toHaveBeenCalledTimes(2);
  });

  it('tells different schemas apart', () => {
    const validator = new SchemaValidator();
    const other: JsonSchema = { ...schema(), properties: { status: { type: 'string', enum: ['draft'] } } };
    expect(validator.input(schema(), { status: 'paid' })).toEqual({ ok: true });
    expect(validator.input(other, { status: 'paid' }).ok).toBe(false);
  });

  it('gives inputs their defaults and coerces outputs, even for one and the same schema', () => {
    const validator = new SchemaValidator();
    const both: JsonSchema = { type: 'object', properties: { n: { type: 'number', default: 5 } } };
    const input: Record<string, unknown> = {};
    expect(validator.input(both, input)).toEqual({ ok: true });
    expect(input.n).toBe(5);
    // "844.64" read from a table cell becomes the number 844.64: outputs coerce, inputs never do.
    const output: Record<string, unknown> = { n: '844.64' };
    expect(validator.output(both, output)).toEqual({ ok: true });
    expect(output.n).toBe(844.64);
    expect(validator.input(both, { n: '844.64' }).ok).toBe(false);
  });

  it('keeps working past the most schemas it holds, dropping the oldest', () => {
    const validator = new SchemaValidator();
    const numbered = (n: number): JsonSchema => ({
      type: 'object',
      properties: { [`field_${n}`]: { type: 'string' } },
      required: [`field_${n}`],
    });
    for (let n = 0; n < 520; n++) {
      expect(validator.input(numbered(n), { [`field_${n}`]: 'x' })).toEqual({ ok: true });
    }
    // The first was dropped: it compiles again and still answers correctly.
    expect(validator.input(numbered(0), { field_0: 'x' })).toEqual({ ok: true });
    expect(validator.input(numbered(0), {}).ok).toBe(false);
  });
});
