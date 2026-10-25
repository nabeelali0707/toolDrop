import { describe, expect, it } from 'vitest';
import { toolDefinitionSchema } from './tool.ts';

const listInvoices = {
  name: 'list_invoices',
  description: 'List supplier invoices by status and date.',
  authority: 'read',
  input_schema: { type: 'object', properties: { status: { type: 'string' } } },
  output_schema: { type: 'array' },
};

describe('toolDefinitionSchema', () => {
  it('accepts a tool definition', () => {
    expect(toolDefinitionSchema.safeParse(listInvoices).success).toBe(true);
  });

  it.each(['ListInvoices', 'list-invoices', '1st_tool', ''])('rejects the name "%s"', (name) => {
    expect(toolDefinitionSchema.safeParse({ ...listInvoices, name }).success).toBe(false);
  });

  it('requires object inputs, as MCP tools take named arguments', () => {
    const result = toolDefinitionSchema.safeParse({ ...listInvoices, input_schema: { type: 'string' } });
    expect(result.error?.issues[0]?.message).toBe('input_schema must have type "object"');
  });
});
